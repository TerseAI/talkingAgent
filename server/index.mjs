import express from 'express';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createApp } from './app.mjs';
import { attachCountingSocketRelay } from './counting-socket-relay.mjs';
import { openAgentWindows } from './open-agent-windows.mjs';
import { createBrowserLogWriter } from './browser-logs.mjs';
import { durableActorToolsEnabled } from './realtime-config.mjs';
import { agentName } from '../shared/agent-identity.mjs';
import { agentForPort, DEV_AGENTS } from '../shared/agent-roster.mjs';

const agents = process.env.PORT ? [agentForPort(Number(process.env.PORT))] : DEV_AGENTS;
const host = process.env.HOST || '127.0.0.1';
const roomId = process.env.COUNTING_ROOM_ID || 'voice-count-to-100-v4';
const toolsEnabled = durableActorToolsEnabled();
const room = toolsEnabled ? (await import('../src/counting-room.ts')).CountingRoom.get(roomId) : null;
const browserLogDirectory = process.env.NODE_ENV === 'production' ? null
  : fileURLToPath(new URL(`../.logs/${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url));
if (browserLogDirectory) console.log(`Browser logs: ${browserLogDirectory}`);
const hosts = [];
for (const { port, voice } of agents) {
  const allowedOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  const app = createApp({
    room,
    toolsEnabled,
    voice,
    apiKey: process.env.OPENAI_API_KEY,
    allowedOrigins,
    writeBrowserLogs: browserLogDirectory ? await createBrowserLogWriter(browserLogDirectory, agentName(voice)) : null,
  });

  const server = createServer(app);
  const socketRelay = toolsEnabled ? attachCountingSocketRelay(server, room, allowedOrigins) : null;
  let vite;
  if (process.env.SERVE_UI === 'false') {
    // Standalone React/Vite app connects through its API proxy.
  } else if (process.env.NODE_ENV === 'production') {
    const dist = fileURLToPath(new URL('../ui/dist/', import.meta.url));
    app.use(express.static(dist));
    app.get('/', (_req, res) => res.sendFile(`${dist}index.html`));
  } else {
    const { createServer } = await import('vite');
    vite = await createServer({ configFile: fileURLToPath(new URL('../ui/vite.config.ts', import.meta.url)), server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
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
      await socketRelay?.close();
      await vite?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }));
    process.exit(0);
  });
}

if (process.env.SERVE_UI !== 'false' && process.env.NODE_ENV !== 'production' && process.env.OPEN_BROWSER !== 'false') {
  openAgentWindows(agents.map(({ port }) => `http://localhost:${port}`));
}
