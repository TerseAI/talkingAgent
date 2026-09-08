import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { createApp } from '../server/app.mjs';
import { attachCountingSocketRelay } from '../server/counting-socket-relay.mjs';
import { CountingRoom } from '../src/counting-room.ts';
import { CountingConnection } from '../src/counting-connection.ts';

const roomId = `integration-${randomUUID()}`;
const room = CountingRoom.get(roomId);
const hosts = [];
const origin = 'http://localhost';
async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for the actor.')), 10000);
    })]);
  } finally { clearTimeout(timer); }
}

try {
  for (const name of ['Alice', 'Bob', 'Charlie']) {
    const reference = CountingRoom.get(roomId);
    const server = createServer(createApp({ room: reference, allowedOrigins: [origin] }));
    const relay = attachCountingSocketRelay(server, reference, [origin]);
    const abort = new AbortController();
    const participantId = `${name}:${randomUUID()}`;
    const events = [];
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const connection = new CountingConnection(participantId, abort.signal, () => {
      const socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/counting/socket?participantId=${encodeURIComponent(participantId)}`, { headers: { Origin: origin } });
      socket.on('message', (data) => events.push(JSON.parse(String(data))));
      return socket;
    });
    const reportComplete = async () => assert.equal((await within(connection.reportTurnComplete())).status, 'completed');
    hosts.push({ server, relay, abort, connection, reportComplete, events, participantId });
  }
  const [alice, bob, charlie] = hosts;
  assert.equal((await within(alice.connection.waitForTurn())).numberToSpeak, 1);
  let bobReturned = false;
  const waiting = bob.connection.waitForTurn().then((result) => { bobReturned = true; return result; });
  await delay(100);
  assert.equal(bobReturned, false, 'Bob must wait while Alice owns the turn');
  await alice.reportComplete();
  assert.equal((await within(waiting)).numberToSpeak, 2);
  let charlieReturned = false;
  const next = charlie.connection.waitForTurn().then((result) => { charlieReturned = true; return result; });
  await delay(100);
  assert.equal(charlieReturned, false);
  assert.ok(alice.events.some((event) => event.type === 'turn_changed' && event.state.currentSpeakerId === bob.participantId), 'The actor broadcasts Bob’s grant to Alice too');
  bob.connection.close();
  assert.equal((await within(next)).numberToSpeak, 2, 'Disconnect hands off the unfinished number without advancing');
  hosts.forEach(({ connection }) => connection.close());
  await within(hosts[0].connection.resetCount());
  console.log('PASS: actor broadcasts resolve only the selected tool; disconnect releases an unfinished turn.');

  const completedTurnsPerParticipant = [0, 0, 0];
  const assignedNumbers = [];
  await within(Promise.all(hosts.map(async ({ connection, reportComplete }, index) => {
    while (true) {
      const grant = await connection.waitForTurn();
      if (grant.status === 'finished') return;
      assert.equal(grant.status, 'granted');
      assignedNumbers.push(grant.numberToSpeak);
      await reportComplete();
      completedTurnsPerParticipant[index]++;
    }
  })));
  assert.deepEqual(assignedNumbers, Array.from({ length: 100 }, (_, index) => index + 1));
  assert.ok(completedTurnsPerParticipant.every((count) => count > 0));
  assert.equal((await room.getSnapshot()).completedCount, 100);
  console.log(`PASS: 1–100 through three socket relays, native DO broadcasts, no polling. Turns: ${completedTurnsPerParticipant.join(', ')}.`);
} finally {
  try {
    if (hosts[0]) await within(hosts[0].connection.resetCount());
  } finally {
    hosts.forEach(({ abort }) => abort.abort());
    await Promise.all(hosts.map(async ({ server, relay }) => {
      await relay.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }));
  }
}
