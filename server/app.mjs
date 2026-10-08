import express from 'express';
import { AGENT_MODEL, AGENT_REASONING_EFFORT, AGENT_VOICE, realtimeInstructions } from '../shared/agent-config.mjs';
import { sessionOptions } from '../shared/session-options.mjs';
import { browserLogBatchSchema } from './browser-logs.mjs';

export function createApp({ apiKey = '', allowedOrigins = [], fetchImpl = fetch, now = Date.now, room = null, voice = AGENT_VOICE, writeBrowserLogs = null, toolsEnabled = true } = {}) {
  const app = express();
  let attempts = [];
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'microphone=(self), camera=()',
    });
    next();
  });
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/config', (_req, res) => {
    res.json({ configured: Boolean(apiKey.trim()), model: AGENT_MODEL, voice, toolsEnabled });
  });
  app.get('/api/counting', async (_req, res) => {
    if (!toolsEnabled) return res.status(404).json({ error: 'Durable-object tools are disabled.' });
    try { res.json(await room.getState()); }
    catch { res.status(503).json({ error: 'Start npm run actors, then restart npm run dev.' }); }
  });
  for (const method of ['start', 'pause', 'reset', 'increment']) {
    app.post(`/api/counting/${method}`, async (_req, res) => {
      if (!toolsEnabled) return res.status(404).json({ error: 'Durable-object tools are disabled.' });
      try { await room[method](); res.sendStatus(204); }
      catch { res.status(503).json({ error: 'The counting room is unavailable.' }); }
    });
  }

  if (writeBrowserLogs) app.post('/api/browser-logs', (req, res, next) => {
    if (!allowedOrigins.includes(req.get('origin'))) return res.sendStatus(403);
    next();
  }, express.json({ limit: '64kb' }), async (req, res) => {
    const batch = browserLogBatchSchema.safeParse(req.body);
    if (!batch.success) return res.status(400).json({ error: 'Invalid browser log batch.' });
    try {
      await writeBrowserLogs(batch.data);
      res.sendStatus(204);
    } catch (error) {
      console.error(`Could not save browser logs: ${error.message}`);
      res.sendStatus(500);
    }
  });

  app.post('/api/session', express.json({ limit: '2kb' }), async (req, res) => {
    // Fixed origins protect the local credential endpoint from requests by other websites.
    if (!allowedOrigins.includes(req.get('origin'))) {
      return res.status(403).json({ error: 'Start the conversation from this app’s own address.' });
    }
    if (!apiKey.trim()) {
      return res.status(503).json({ error: 'Add OPENAI_API_KEY to .env, then restart the server.' });
    }

    let options;
    try {
      options = sessionOptions(req.body);
      if (!req.body?.mode || req.body.mode === 'assistant') options.voice = voice;
    }
    catch (error) { return res.status(400).json({ error: error.message }); }

    const timestamp = now();
    attempts = attempts.filter((time) => timestamp - time < 60_000);
    if (attempts.length >= 10) {
      res.set('Retry-After', '60');
      return res.status(429).json({ error: 'Too many connection attempts. Wait a minute and try again.' });
    }
    attempts.push(timestamp);

    try {
      const response = await fetchImpl('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(12_000),
        body: JSON.stringify({
          expires_after: { anchor: 'created_at', seconds: 60 },
          session: {
            type: 'realtime',
            model: AGENT_MODEL,
            reasoning: { effort: AGENT_REASONING_EFFORT },
            instructions: toolsEnabled ? options.instructions : realtimeInstructions(false),
            audio: {
              input: {
                transcription: { model: 'gpt-4o-mini-transcribe' },
                turn_detection: { type: 'semantic_vad', create_response: true, interrupt_response: true },
              },
              output: { voice: options.voice },
            },
          },
        }),
      });

      if (!response.ok) {
        const errors = {
          401: 'OpenAI rejected the API key. Check OPENAI_API_KEY in .env and restart the server.',
          403: 'This OpenAI project does not have access to the requested Realtime model.',
          429: 'OpenAI’s usage limit was reached. Check your API billing and limits, then try again.',
        };
        // Never return the upstream body: it may include sensitive diagnostics.
        return res.status(response.status === 429 ? 429 : 502).json({
          error: errors[response.status] ?? 'OpenAI could not start a session. Please try again.',
        });
      }

      const data = await response.json();
      if (typeof data.value !== 'string' || !data.value.startsWith('ek_') ||
          !Number.isFinite(data.expires_at) || data.expires_at <= now() / 1000) {
        return res.status(502).json({ error: 'OpenAI returned an invalid session credential. Please try again.' });
      }
      return res.json({ value: data.value, expires_at: data.expires_at, toolsEnabled });
    } catch (error) {
      const timedOut = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
      return res.status(502).json({
        error: timedOut
          ? 'OpenAI took too long to respond. Please try again.'
          : 'Could not reach OpenAI. Check the server’s internet connection and try again.',
      });
    }
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  app.use((error, _req, res, next) => {
    if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') {
      return res.status(error.status).json({ error: 'Provide a small, valid JSON session configuration.' });
    }
    next(error);
  });
  return app;
}
