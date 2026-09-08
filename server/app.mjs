import express from 'express';
import { AGENT_MODEL, AGENT_VOICE } from '../shared/agent-config.mjs';
import { sessionOptions } from '../shared/session-options.mjs';
import { counterRouter } from './counter-routes.mjs';

export function createApp({ apiKey = '', allowedOrigins = [], fetchImpl = fetch, now = Date.now, counter = null } = {}) {
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
    res.json({ configured: Boolean(apiKey.trim()), model: AGENT_MODEL, voice: AGENT_VOICE });
  });
  app.use('/api/counter', counterRouter(counter, allowedOrigins));

  app.post('/api/session', express.json({ limit: '2kb' }), async (req, res) => {
    // Fixed origins protect the local credential endpoint from requests by other websites.
    if (!allowedOrigins.includes(req.get('origin'))) {
      return res.status(403).json({ error: 'Start the conversation from this app’s own address.' });
    }
    if (!apiKey.trim()) {
      return res.status(503).json({ error: 'Add OPENAI_API_KEY to .env, then restart the server.' });
    }

    let options;
    try { options = sessionOptions(req.body); }
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
            instructions: options.instructions,
            audio: {
              input: {
                transcription: { model: 'gpt-4o-mini-transcribe' },
                turn_detection: req.body?.mode === 'shared-counting' ? null : { type: 'semantic_vad', create_response: true, interrupt_response: true },
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
      return res.json({ value: data.value, expires_at: data.expires_at });
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
