import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { createApp } from '../server/app.mjs';
import { attachCountingSocketRelay } from '../server/counting-socket-relay.mjs';
import { CountingRoom } from '../src/counting-room.ts';
import { CountingConnection } from '../src/counting-connection.ts';
import { CountingTurnDriver } from '../src/counting-turns.ts';

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
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  let connection;
  let driver;
  const speaker = {
    requestResponse(_instructions, number) {
      const id = `resp_${randomUUID()}`;
      driver.onTransportEvent({ type: 'response.created', response: { id, metadata: { number: String(number) } } });
      setTimeout(() => {
        spoken.push(number);
        driver.onTransportEvent({ type: 'response.done', response: { id, output: [{ type: 'message' }] } });
        const followupId = `resp_${randomUUID()}`;
        driver.onTransportEvent({ type: 'response.created', response: { id: followupId } });
        driver.onTransportEvent({ type: 'response.done', response: { id: followupId, output: [] } });
        driver.onTransportEvent({ type: 'output_audio_buffer.stopped', response_id: followupId });
      }, 50);
    },
    increment: () => connection.increment(),
    pauseCount() {},
    setListening() {},
  };
  return {
    participantId, abort, spoken, states, ready,
    attach(base, actor) {
      connection = new CountingConnection(participantId, abort.signal, () => new WebSocket(
        `${base.replace('http:', 'ws:')}/api/counting/socket?participantId=${encodeURIComponent(participantId)}`, { headers: { Origin: origin } }),
      (method) => actor[method]());
      driver = new CountingTurnDriver(participantId, speaker);
      connection.onStateChanged = (state, speakerId) => { states.push(state); markReady(); driver.onState(state, speakerId); };
      connection.connect();
      return connection;
    },
  };
}

try {
  for (const name of ['Alice', 'Bob', 'Charlie', 'Dana']) {
    const reference = CountingRoom.get(roomId);
    const server = createServer(createApp({ room: reference, allowedOrigins: [origin] }));
    const relay = attachCountingSocketRelay(server, reference, [origin]);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const browser = simulatedBrowser(name);
    const connection = browser.attach(`http://127.0.0.1:${server.address().port}`, reference);
    hosts.push({ server, relay, browser, connection });
  }
  await within(Promise.all(hosts.map(({ browser }) => browser.ready)));
  const [, bob] = hosts;
  const finished = new Promise((resolve) => {
    for (const { browser } of hosts) {
      const original = browser.states.push.bind(browser.states);
      browser.states.push = (state) => { if (state.count === 100) resolve(); return original(state); };
    }
  });

  assert.equal((await within(bob.connection.startCount())).status, 'ok');
  await within(finished, 60_000);

  const spoken = hosts.flatMap(({ browser }) => browser.spoken).sort((a, b) => a - b);
  assert.deepEqual(spoken, Array.from({ length: 100 }, (_, index) => index + 1), 'every number is spoken exactly once');
  assert.deepEqual(hosts.map(({ browser }) => browser.spoken[0]), [1, 2, 3, 4], 'the first four numbers rotate through the connected participants');
  assert.ok(hosts.every(({ browser }) => browser.spoken.length === 25));
  assert.equal((await room.getState()).count, 100);
  console.log(`PASS: 1–100 across four relays with connected-participant turns. Turns: ${hosts.map(({ browser }) => browser.spoken.length).join(', ')}.`);
} finally {
  try { if (hosts[0]) await within(hosts[0].connection.resetCount()); } catch {}
  hosts.forEach(({ browser }) => browser.abort.abort());
  await Promise.all(hosts.map(async ({ server, relay }) => {
    await relay.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }));
}
