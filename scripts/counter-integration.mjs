import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.mjs';
import { createServer } from 'node:http';
import { Counter } from '../src/durable-objects.ts';

// Real local runtime, three separate HTTP servers using the SDK, one isolated DO.
// Playback is simulated here; scripts/counting-browser-live.mjs tests actual model audio.
const actorId = `integration-${randomUUID()}`;
const servers = [];
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
  console.log(`PASS: three web hosts shared one real Durable Object; 1–100 exactly once, one talking stick, no overlapping spoken turns. Turns: ${counts.join(', ')}. SDK reads persisted 100.`);
} finally {
  await Promise.all(servers.map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
}
