import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.mjs';
import { TurnCoordinator } from '../server/turn-coordinator.mjs';
import { Counter } from '../src/durable-objects.ts';

const counter = new TurnCoordinator(Counter.get(`integration-${randomUUID()}`));
const servers = [];
const hosts = [];
try {
  for (let index = 0; index < 3; index++) {
    const app = createApp({ counter, allowedOrigins: ['http://localhost'] });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    servers.push(server);
    hosts.push(async (action = '', body, signal) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/counter${action ? `/${action}` : ''}`, {
        method: body ? 'POST' : 'GET', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal,
      });
      const result = await response.json();
      assert.equal(response.ok, true, JSON.stringify(result));
      return result;
    });
  }
  const alice = `Alice:${randomUUID()}`;
  const bob = `Bob:${randomUUID()}`;
  const charlie = `Charlie:${randomUUID()}`;
  assert.equal((await hosts[0]('claim', { clientId: alice })).next_number, 1);
  let returned = false;
  const waiting = hosts[1]('claim', { clientId: bob }).then((result) => { returned = true; return result; });
  await delay(100);
  assert.equal(returned, false, 'HTTP tool request must remain open while Alice owns the turn');
  await hosts[0]('complete', { clientId: alice });
  assert.equal((await waiting).next_number, 2);
  await hosts[1]('cancel', { clientId: bob });
  await hosts[0]('reset', {});
  console.log('PASS: one pending HTTP request resolves directly when the holder completes.');

  const counts = [0, 0, 0];
  const numbers = [];
  const clients = [alice, bob, charlie];
  await Promise.all(hosts.map(async (request, index) => {
    while (true) {
      const grant = await request('claim', { clientId: clients[index] });
      if (grant.status === 'done') return;
      assert.equal(grant.status, 'granted');
      numbers.push(grant.next_number);
      await request('complete', { clientId: clients[index] });
      counts[index]++;
    }
  }));
  assert.deepEqual(numbers, Array.from({ length: 100 }, (_, index) => index + 1));
  assert.ok(counts.every((count) => count > 0));
  assert.equal((await hosts[0]()).count, 100);
  console.log(`PASS: 1–100 through three HTTP hosts, one coordinator, no socket notifications or polling. Turns: ${counts.join(', ')}.`);
} finally {
  await counter.reset();
  await Promise.all(servers.map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
}
