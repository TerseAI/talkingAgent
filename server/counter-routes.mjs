import express from 'express';
import { z } from 'zod';
import { logCounter } from '../shared/agent-identity.mjs';

export function counterRouter(counter, allowedOrigins) {
  const router = express.Router();
  const clientId = z.union([z.string().uuid(), z.string().regex(/^(Alice|Bob|Charlie|Assistant):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)]);
  router.get('/', async (_req, res) => {
    try { res.json(await counter.getState()); }
    catch { res.status(503).json({ error: 'Start npm run counter, then restart npm run dev.' }); }
  });
  router.use((req, res, next) => {
    if (!allowedOrigins.includes(req.get('origin'))) return res.status(403).json({ error: 'Use this web app’s own origin.' });
    next();
  });
  router.use(express.json({ limit: '2kb' }));
  const identity = z.object({ clientId });
  router.post('/claim', async (req, res) => {
    const parsed = identity.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid counter request.' });
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        abort.abort();
        void counter.cancel(parsed.data.clientId).catch(() => {});
      }
    });
    try {
      const result = await counter.getTalkingStick(parsed.data.clientId, abort.signal);
      if (!res.destroyed) res.json(result);
    } catch (error) {
      logCounter('claim rejected', parsed.data.clientId, error.message);
      if (!res.destroyed) res.status(409).json({ error: error.message });
    }
  });
  const actions = {

    complete: [identity, ({ clientId }) => counter.doneSpeaking(clientId)],
    cancel: [identity, ({ clientId }) => counter.cancel(clientId)],
    reset: [z.object({}), () => counter.reset()],
  };
  for (const [action, [schema, invoke]] of Object.entries(actions)) {
    router.post(`/${action}`, async (req, res) => {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid counter request.' });
      try { res.json(await invoke(parsed.data)); }
      catch (error) { logCounter(`${action} rejected`, parsed.data.clientId, error.message); res.status(409).json({ error: error.message }); }
    });
  }
  return router;
}
