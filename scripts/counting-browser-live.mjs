import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

// Uses real OpenAI sessions (billable) and synthetic microphone input.
// All three hosts share an isolated test DO; the user's counter is untouched.
const actorId = `voice-browser-test-${randomUUID()}`;
const ports = [3101, 3102, 3103];
const children = [];
const logs = [];
const events = [];
const spoken = [];
let browser;
await mkdir('.qa', { recursive: true });
try {
  for (const port of ports) {
    const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'node_modules/little-durable-objects/dist/cli.js', 'run', '--data-dir', '.counter-data', 'server/index.mjs'], {
      env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), APP_ORIGIN: `http://localhost:${port}`, COUNTER_ID: actorId },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', (data) => logs.push(`host ${port}: ${data}`));
    children.push(child);
  }
  for (const port of ports) {
    await expect.poll(async () => fetch(`http://localhost:${port}/api/config`).then((r) => r.status).catch(() => 0), { timeout: 20_000 }).toBe(200);
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  ] });
  const pages = [];
  for (const port of ports) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.on('response', async (response) => {
      if (response.url().endsWith('/api/counter/claim')) {
        const result = await response.json().catch(() => null);
        if (result?.status === 'granted') spoken.push({ port, number: result.next_number });
      }
    });
    page.on('pageerror', (error) => logs.push(`page ${port}: ${error.message}`));
    await page.exposeFunction('recordCountEvent', (event) => events.push({ port, ...event }));
    await page.addInitScript(() => {
      const create = RTCPeerConnection.prototype.createDataChannel;
      RTCPeerConnection.prototype.createDataChannel = function (...args) {
        const channel = create.apply(this, args);
        channel.addEventListener('message', (message) => {
          try {
            const event = JSON.parse(message.data);
            if (['response.created', 'response.done', 'response.output_audio_transcript.done', 'output_audio_buffer.started', 'output_audio_buffer.stopped', 'error'].includes(event.type)) {
              window.recordCountEvent({ time: Date.now(), type: event.type, responseId: event.response_id ?? event.response?.id, metadata: event.response?.metadata, status: event.response?.status, transcript: event.transcript, error: event.error?.message });
            }
          } catch {}
        });
        return channel;
      };
    });
    await page.goto(`http://localhost:${port}`);
    await expect(page.getByRole('button', { name: 'Start this agent', exact: true })).toBeEnabled({ timeout: 20_000 });
    pages.push(page);
  }
  await Promise.all(pages.map((page) => page.getByRole('button', { name: 'Start this agent', exact: true }).click()));
  let lastReported = -1;
  const deadline = Date.now() + 12 * 60_000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await fetch(`http://localhost:${ports[0]}/api/counter`).then((r) => r.json());
    for (const page of pages) {
      if (await page.locator('.session-error').count()) throw new Error(await page.locator('.session-error').innerText());
    }
    if (Math.floor(snapshot.count / 10) !== lastReported) {
      lastReported = Math.floor(snapshot.count / 10);
      console.log(`Real voice agents: ${snapshot.count}/100 confirmed.`);
    }
    if (snapshot.done) break;
    await delay(2000);
  }
  assert.equal(snapshot.count, 100, 'Voice agents did not reach 100 before the deadline');
  assert.equal(new Set(spoken.map(({ port }) => port)).size, 3);
  assert.deepEqual(spoken.map(({ number }) => number), Array.from({ length: 100 }, (_, i) => i + 1));
  for (const page of pages) await expect(page.getByRole('heading', { name: 'Together, we reached 100.' })).toBeVisible({ timeout: 15_000 });
  const playing = new Set();
  for (const event of events.sort((a, b) => a.time - b.time)) {
    if (event.type === 'output_audio_buffer.started') { assert.equal(playing.size, 0, 'Browser playback overlapped'); playing.add(event.responseId); }
    if (event.type === 'output_audio_buffer.stopped') playing.delete(event.responseId);
  }
  assert.equal(playing.size, 0);
  await pages[0].screenshot({ path: '.qa/counting-complete.png', fullPage: true });
  console.log('PASS: three real gpt-realtime-2.1 browser agents on separate web hosts reached 100 through the same local DO, with no overlapping playback events.');
} finally {
  await writeFile('.qa/counting-live-events.json', JSON.stringify({ actorId, events, logs }, null, 2));
  await browser?.close();
  for (const child of children) child.kill('SIGTERM');
}
