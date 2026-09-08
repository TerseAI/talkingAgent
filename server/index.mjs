import express from 'express';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createApp } from './app.mjs';
import { attachCountingSocketRelay } from './counting-socket-relay.mjs';
import { openAgentWindows } from './open-agent-windows.mjs';
import { createBrowserLogWriter } from './browser-logs.mjs';
import { CountingRoom } from '../src/counting-room.ts';
import { agentName } from '../shared/agent-identity.mjs';

const ports = process.env.PORT ? [Number(process.env.PORT)] : [3002, 3003, 3004];
const host = process.env.HOST || '127.0.0.1';
const roomId = process.env.COUNTING_ROOM_ID || 'voice-count-to-100-v2';
const room = CountingRoom.get(roomId);
const browserLogDirectory = process.env.NODE_ENV === 'production' ? null
  : fileURLToPath(new URL(`../.logs/${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url));
if (browserLogDirectory) console.log(`Browser logs: ${browserLogDirectory}`);
const hosts = [];
for (const port of ports) {
  const allowedOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  const voice = ({ 3002: 'marin', 3003: 'cedar', 3004: 'coral' })[port] ?? 'marin';
  const app = createApp({
    room,
    voice,
    apiKey: process.env.OPENAI_API_KEY,
    allowedOrigins,
    writeBrowserLogs: browserLogDirectory ? await createBrowserLogWriter(browserLogDirectory, agentName(voice)) : null,
  });

  const server = createServer(app);
  const socketRelay = attachCountingSocketRelay(server, room, allowedOrigins);
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
  await new Promise((resolve) => server.listen(port, host, () => {
    console.log(`Talking Agent is ready at http://localhost:${port}`);
    console.log(process.env.OPENAI_API_KEY?.trim()
      ? 'OpenAI API key is configured.'
      : 'Add OPENAI_API_KEY to .env and restart to enable voice conversations.');
    resolve();
  }));

  hosts.push({ server, vite, socketRelay });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await Promise.all(hosts.map(async ({ server, vite, socketRelay }) => {
      await socketRelay.close();
      await vite?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }));
    process.exit(0);
  });
}

if (process.env.NODE_ENV !== 'production' && process.env.OPEN_BROWSER !== 'false') {
  openAgentWindows(ports.map((port) => `http://localhost:${port}`));
}
