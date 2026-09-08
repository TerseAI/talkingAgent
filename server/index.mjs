import express from 'express';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createApp } from './app.mjs';
import { Counter } from '../src/durable-objects.ts';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const counterId = process.env.COUNTER_ID || 'voice-count-to-100';
const counter = Counter.get(counterId);
const app = createApp({
  counter,
  apiKey: process.env.OPENAI_API_KEY,
  allowedOrigins: process.env.APP_ORIGIN
    ? [process.env.APP_ORIGIN]
    : [`http://localhost:${port}`, `http://127.0.0.1:${port}`],
});

const server = createServer(app);
let vite;
if (process.env.NODE_ENV === 'production') {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  app.use(express.static(dist));
  app.get('/', (_req, res) => res.sendFile(`${dist}index.html`));
} else {
  const { createServer } = await import('vite');
  vite = await createServer({ server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  app.use(vite.middlewares);
}

server.on('error', (error) => {
  console.error(`Could not start Talking Agent: ${error.message}`);
  process.exit(1);
});
server.listen(port, host, () => {
  console.log(`Talking Agent is ready at http://localhost:${port}`);
  console.log(process.env.OPENAI_API_KEY?.trim()
    ? 'OpenAI API key is configured.'
    : 'Add OPENAI_API_KEY to .env and restart to enable voice conversations.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await vite?.close();
    server.close(() => process.exit(0));
  });
}
