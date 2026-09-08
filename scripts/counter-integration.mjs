import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.mjs';
import { createServer } from 'node:http';
import { Counter } from '../src/durable-objects.ts';
import { CounterLock } from '../src/counter-lock.ts';

// Real local runtime, three separate HTTP servers using the SDK, one isolated DO.
// Tool calls are simulated here; this does not test the model or audio.
const actorId = `integration-${randomUUID()}`;
const servers = [];
const streams = [];
try {
  const hosts = [];
  for (let i = 0; i < 3; i++) {
    const counter = Counter.get(actorId);
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createApp({ counter, allowedOrigins: [origin] }));
    hosts.push(async (action = '', body) => {
      const response = await fetch(`${origin}/api/counter${action ? `/${action}` : ''}`, {
        method: body ? 'POST' : 'GET', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      });
      const result = await response.json();
      assert.equal(response.ok, true, JSON.stringify(result));
      return result;
    });
  }
  // Three distinct listeners; only the first queued agent should receive the pulse.
  const clients = [randomUUID(), randomUUID(), randomUUID()];
  await hosts[0]('claim', { clientId: clients[0] });
  await hosts[1]('claim', { clientId: clients[1] });
  await hosts[2]('claim', { clientId: clients[2] });
  const readers = await Promise.all(servers.map(async (server, index) => {
    const abort = new AbortController();
    streams.push(abort);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/counter/events?clientId=${clients[index]}`, { signal: abort.signal });
    assert.equal(response.status, 200);
    return response.body.getReader();
  }));
  // The current holder receives a reconnect notification; consume it first.
  await nextTurn(readers[0]);
  const received = [false, false, false];
  const deliveries = readers.map((reader, index) => nextTurn(reader).then(() => { received[index] = true; }).catch(() => {}));
  await hosts[0]('complete', { clientId: clients[0], number: 1 });
  const timeout = setTimeout(() => streams.forEach((abort) => abort.abort()), 5000);
  await deliveries[1];
  clearTimeout(timeout);
  await delay(100);
  assert.deepEqual(received, [false, true, false]);
  assert.equal((await hosts[0]('claim', { clientId: clients[0] })).status, 'waiting');
  assert.equal((await hosts[2]()).talkingStick, clients[1]);
  // Disconnect the selected agent: its reserved turn must move to the next waiter.
  streams[1].abort();
  const disconnectTimeout = setTimeout(() => streams.forEach((abort) => abort.abort()), 5000);
  await deliveries[2];
  clearTimeout(disconnectTimeout);
  assert.equal(received[2], true);
  assert.equal((await hosts[2]()).talkingStick, clients[2]);
  streams.forEach((abort) => abort.abort());
  await Promise.all(deliveries);
  await hosts[0]('reset', {});
  console.log('PASS: FIFO handoff pulses only the selected host; disconnect hands its reserved turn to the next waiter.');
  const owner = randomUUID();
  const waiter = randomUUID();
  await hosts[0]('claim', { clientId: owner });
  const socket = await Counter.get(actorId).connect({ clientId: waiter });
  const connection = Object.assign(new EventTarget(), { close: () => socket.close() });
  socket.addEventListener('message', ({ data }) => {
    if (JSON.parse(String(data)).type === 'turn_available') connection.dispatchEvent(new Event('turn'));
  });
  const abortWait = new AbortController();
  streams.push(abortWait);
  const lock = new CounterLock(waiter, abortWait.signal, connection, (action, body) => hosts[1](action, body));
  connection.dispatchEvent(new Event('ready'));
  let resolved = false;
  const grant = lock.claim().then((result) => { resolved = true; return result; });
  await delay(100);
  assert.equal(resolved, false, 'Tool must remain pending while another agent holds the lock');
  await hosts[0]('complete', { clientId: owner, number: 1 });
  const grantTimeout = setTimeout(() => abortWait.abort(), 5000);
  const granted = await grant;
  clearTimeout(grantTimeout);
  assert.equal(granted.status, 'granted');
  assert.equal(granted.next_number, 2);
  abortWait.abort();
  await hosts[1]('cancel', { clientId: waiter });
  await hosts[0]('reset', {});
  console.log('PASS: pending tool resolved only after the real socket handoff granted its lock.');
  let speaking = 0;
  const counts = [0, 0, 0];
  const spoken = [];
  await Promise.all(hosts.map(async (request, index) => {
    const clientId = randomUUID();
    while (true) {
      let grant;
      do {
        grant = await request('claim', { clientId });
        if (grant.status === 'waiting') await delay(25);
      } while (grant.status === 'waiting');
      if (grant.status === 'done') return;
      assert.equal(grant.status, 'granted');
      assert.equal(speaking++, 0, 'Two hosts received simultaneous turns');
      assert.equal(grant.next_number, grant.latest_count + 1);
      spoken.push(grant.next_number);
      await delay(100);
      speaking--;
      await request('complete', { clientId, number: grant.next_number });
      counts[index]++;
      await delay(50);
    }
  }));
  const result = await hosts[2]();
  assert.equal(result.count, 100);
  assert.ok(counts.every((count) => count > 0));
  assert.deepEqual(spoken, Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal((await Counter.get(actorId).getState()).count, 100);
  console.log(`PASS: three web hosts shared one real Durable Object; 1–100 exactly once, one talking stick, no overlapping simulated turns. Turns: ${counts.join(', ')}. SDK reads persisted 100.`);
} finally {
  streams.forEach((abort) => abort.abort());
  await Promise.all(servers.map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
}

async function nextTurn(reader) {
  let text = '';
  while (!text.includes('event: turn')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('Counter connection closed before the grant');
    text += new TextDecoder().decode(value);
  }
}
