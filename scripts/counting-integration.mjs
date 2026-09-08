import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { createApp } from '../server/app.mjs';
import { attachCountingSocketRelay } from '../server/counting-socket-relay.mjs';
import { CountingRoom } from '../src/counting-room.ts';
import { CountingConnection } from '../src/counting-connection.ts';
import { CountingTurnDriver } from '../src/counting-turns.ts';
import { TURN_FALLBACK_MS } from '../shared/counting-protocol.mjs';

const roomId = `integration-${randomUUID()}`;
const room = CountingRoom.get(roomId);
const origin = 'http://localhost';
const hosts = [];

async function within(promise, timeoutMs = 10_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for the actor.')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

// Stands in for one browser: a fake Realtime session that "speaks" 50ms after each cue.
function simulatedBrowser(name) {
  const participantId = `${name}:${randomUUID()}`;
  const abort = new AbortController();
  const spoken = [];
  const states = [];
  let connection;
  let driver;
  let silent = false;
  const speaker = {
    requestResponse(instructions, turnId) {
      const number = Number(/number (\d+)/.exec(instructions)[1]);
      const id = `resp_${randomUUID()}`;
      driver.onTransportEvent({ type: 'response.created', response: { id, metadata: { turnId } } });
      if (silent) return;
      setTimeout(() => {
        spoken.push(number);
        driver.onTransportEvent({ type: 'response.done', response: { id, output: [{ type: 'message' }] } });
        driver.onTransportEvent({ type: 'output_audio_buffer.stopped', response_id: id });
      }, 50);
    },
    completeTurn: (turnId) => connection.completeTurn(turnId),
    pauseCount() {},
    setListening() {},
  };
  return {
    participantId, abort, spoken, states,
    mute() { silent = true; },
    attach(base) {
      connection = new CountingConnection(participantId, abort.signal, () => new WebSocket(
        `${base.replace('http:', 'ws:')}/api/counting/socket?participantId=${encodeURIComponent(participantId)}`, { headers: { Origin: origin } }));
      driver = new CountingTurnDriver(participantId, speaker);
      connection.onStateChanged = (state, turnId) => { states.push(state); driver.onState(state, turnId); };
      connection.connect();
      return connection;
    },
  };
}

try {
  for (const name of ['Alice', 'Bob', 'Charlie']) {
    const reference = CountingRoom.get(roomId);
    const server = createServer(createApp({ room: reference, allowedOrigins: [origin] }));
    const relay = attachCountingSocketRelay(server, reference, [origin]);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const browser = simulatedBrowser(name);
    const connection = browser.attach(`http://127.0.0.1:${server.address().port}`);
    hosts.push({ server, relay, browser, connection });
  }
  const [alice, bob, charlie] = hosts;
  const finished = new Promise((resolve) => {
    for (const { browser } of hosts) {
      const original = browser.states.push.bind(browser.states);
      browser.states.push = (state) => { if (state.finished) resolve(); return original(state); };
    }
  });

  assert.equal((await within(bob.connection.startCount())).status, 'ok');
  await within(finished, 60_000);

  const spoken = hosts.flatMap(({ browser }) => browser.spoken).sort((a, b) => a - b);
  assert.deepEqual(spoken, Array.from({ length: 100 }, (_, index) => index + 1), 'every number is spoken exactly once');
  assert.equal(bob.browser.spoken[0], 1, 'the participant who started speaks first');
  assert.deepEqual(hosts.map(({ browser }) => browser.spoken[0]).sort(), [1, 2, 3], 'the first three numbers rotate through all participants');
  assert.ok(hosts.every(({ browser }) => browser.spoken.length >= 33));
  assert.equal((await room.getSnapshot()).completedCount, 100);
  console.log(`PASS: 1–100 across three relays with the room cueing each browser. Turns: ${hosts.map(({ browser }) => browser.spoken.length).join(', ')}.`);

  assert.equal((await within(alice.connection.resetCount())).status, 'ok');
  charlie.browser.mute();
  assert.equal((await within(charlie.connection.startCount())).status, 'ok');
  await within(new Promise((resolve) => setTimeout(resolve, TURN_FALLBACK_MS + 1_000)));
  let snapshot = await room.getSnapshot();
  assert.ok(snapshot.completedCount >= 2, 'the relay expires a turn whose browser never reports and the others continue');
  console.log(`PASS: fallback expiry advanced past a silent participant after ${TURN_FALLBACK_MS}ms.`);
  charlie.browser.abort.abort();
  await within(new Promise((resolve) => setTimeout(resolve, 1_500)));
  snapshot = await room.getSnapshot();
  assert.ok(snapshot.counting && snapshot.currentSpeakerId !== charlie.browser.participantId, 'a disconnected speaker hands its turn to the others');
  assert.equal((await within(alice.connection.pauseCount())).status, 'ok');
  assert.equal((await room.getSnapshot()).counting, false);
  console.log('PASS: disconnect hands off the turn; pause holds the room.');
} finally {
  try { if (hosts[0]) await within(hosts[0].connection.resetCount()); } catch {}
  hosts.forEach(({ browser }) => browser.abort.abort());
  await Promise.all(hosts.map(async ({ server, relay }) => {
    await relay.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }));
}
