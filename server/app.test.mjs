import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from './app.mjs';

const origin = 'http://localhost:3000';
const permanentKey = 'sk-test-server-only';
let server;
let base;
let upstream;
let key = permanentKey;
let timestamp = Date.now();

before(async () => {
  const app = createApp({
    get apiKey() { return key; },
    allowedOrigins: [origin],
    now: () => timestamp,
    fetchImpl: (...args) => upstream(...args),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

const mint = (headers = { Origin: origin }) => fetch(`${base}/api/session`, { method: 'POST', headers });

test('config exposes readiness but never the permanent key', async () => {
  const response = await fetch(`${base}/api/config`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.deepEqual(data, { configured: true, model: 'gpt-realtime-2.1', voice: 'marin' });
});

test('rejects foreign and missing origins without contacting OpenAI', async () => {
  upstream = () => assert.fail('must not mint a credential');
  assert.equal((await mint({ Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await mint({})).status, 403);
});

test('uses the requested model and only returns a short-lived credential', async () => {
  upstream = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/realtime/client_secrets');
    assert.equal(options.headers.Authorization, `Bearer ${permanentKey}`);
    const body = JSON.parse(options.body);
    assert.equal(body.session.model, 'gpt-realtime-2.1');
    assert.equal(body.expires_after.seconds, 60);
    assert.equal(body.session.audio.input.turn_detection.interrupt_response, true);
    return Response.json({ value: 'ek_ephemeral', expires_at: Math.floor(timestamp / 1000) + 60, session: { private_detail: 'omit me' } });
  };
  const response = await mint();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { value: 'ek_ephemeral', expires_at: Math.floor(timestamp / 1000) + 60 });
});

test('sanitizes upstream errors and gives an actionable authentication error', async () => {
  upstream = async () => Response.json({ error: `Invalid key: ${permanentKey}` }, { status: 401 });
  const response = await mint();
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.match(body, /Check OPENAI_API_KEY/);
  assert.ok(!body.includes(permanentKey));
});

test('handles timeouts and malformed or expired credentials', async () => {
  upstream = async () => { throw new DOMException('timeout', 'TimeoutError'); };
  assert.match((await (await mint()).json()).error, /too long/);
  for (const payload of [{ value: permanentKey }, { value: 'ek_expired', expires_at: 1 }]) {
    upstream = async () => Response.json(payload);
    assert.equal((await mint()).status, 502);
  }
});

test('rate limits attempts, then permits them after the window', async () => {
  upstream = async () => Response.json({ value: 'ek_valid', expires_at: Math.floor(timestamp / 1000) + 60 });
  let response;
  for (let i = 0; i < 11; i++) response = await mint();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  timestamp += 60_001;
  assert.equal((await mint()).status, 200);
});

test('missing key returns setup instructions', async () => {
  const missing = createApp({ allowedOrigins: [origin], fetchImpl: () => assert.fail('must not contact OpenAI') }).listen(0, '127.0.0.1');
  await new Promise((resolve) => missing.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${missing.address().port}/api/session`, { method: 'POST', headers: { Origin: origin } });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /\.env/);
  } finally { await new Promise((resolve) => missing.close(resolve)); }
});
