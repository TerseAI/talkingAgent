import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// Uses synthetic audio devices; never records the user's microphone or calls OpenAI.
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
await mkdir('.qa', { recursive: true });
const base = process.env.TEST_URL || 'http://localhost:3000';
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/config', (route) => route.fulfill({ json: { configured: false } }));
  await page.goto(base);
  await expect(page.getByRole('heading', { name: 'Talk to your agent.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'One thing before we talk' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start conversation', exact: true })).toBeDisabled();
  await page.screenshot({ path: '.qa/desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Open help' }).click();
  await expect(page.getByRole('heading', { name: 'Voice conversation', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close help' }).click();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 });
  mobile.on('pageerror', (error) => errors.push(error.message));
  await mobile.route('**/api/config', (route) => route.fulfill({ json: { configured: false } }));
  await mobile.goto(base);
  await expect(mobile.getByRole('heading', { name: 'One thing before we talk' })).toBeVisible();
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await mobile.screenshot({ path: '.qa/mobile.png', fullPage: true });

  await page.unroute('**/api/config');
  await page.route('**/api/config', (route) => route.fulfill({ json: { configured: true } }));
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByRole('button', { name: 'Start conversation', exact: true })).toBeEnabled();

  // The actual local server rejects this request when no API key is configured.
  // Stub its answer so the smoke test is safe even after a real key is installed.
  await page.route('**/api/session', (route) => route.fulfill({ status: 503, json: { error: 'Add OPENAI_API_KEY to .env, then restart the server.' } }));
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Add OPENAI_API_KEY');
  await expect(page.getByRole('button', { name: 'Start a new conversation' })).toBeEnabled();

  // Cancelling while a token is outstanding releases the already-acquired microphone.
  await page.addInitScript(() => {
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getMedia(constraints);
      window.testMediaStream = stream;
      return stream;
    };
  });
  await page.reload();
  await page.unroute('**/api/session');
  let tokenRoute;
  await page.route('**/api/session', (route) => { tokenRoute = route; });
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await expect.poll(() => Boolean(tokenRoute)).toBe(true);
  await expect(page.getByRole('button', { name: 'Cancel connection' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel connection' }).click();
  await expect(page.getByRole('heading', { name: 'Conversation ended' })).toBeVisible();
  expect(await page.evaluate(() => window.testMediaStream.getTracks().every((track) => track.readyState === 'ended'))).toBe(true);
  await tokenRoute.fulfill({ status: 503, json: { error: 'Cancelled test request' } }).catch(() => {});
  await expect(page.getByRole('heading', { name: 'Conversation ended' })).toBeVisible();

  const denied = await browser.newPage();
  await denied.route('**/api/config', (route) => route.fulfill({ json: { configured: true } }));
  await denied.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Denied', 'NotAllowedError'));
  });
  await denied.goto(base);
  await denied.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await expect(denied.getByRole('alert')).toContainText('Microphone access was denied');
  expect(errors).toEqual([]);
  console.log('Browser smoke passed: desktop/mobile, setup, help, token failure, cancellation cleanup, denied permission; no page errors.');
} finally {
  await browser.close();
}
