import express from 'express';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createApp } from './app.mjs';
import { TurnCoordinator } from './turn-coordinator.mjs';
import { Counter } from '../src/durable-objects.ts';

const ports = [3002, 3003, 3004];
if (process.env.PORT && process.env.PORT !== '3002') throw new Error('Run npm run dev once; it serves ports 3002, 3003, and 3004 together.');
const host = process.env.HOST || '127.0.0.1';
const counterId = process.env.COUNTER_ID || 'voice-count-to-100';
const counter = new TurnCoordinator(Counter.get(counterId));
const hosts = [];
for (const port of ports) {
  const app = createApp({
    counter,
    voice: ({ 3002: 'marin', 3003: 'cedar', 3004: 'coral' })[port] ?? 'marin',
    apiKey: process.env.OPENAI_API_KEY,
    allowedOrigins: [`http://localhost:${port}`, `http://127.0.0.1:${port}`],
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

  hosts.push({ server, vite });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await counter.close().catch((error) => console.error('Could not release the counter:', error.message));
    await Promise.all(hosts.map(async ({ server, vite }) => {
      await vite?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }));
    process.exit(0);
  });
}
