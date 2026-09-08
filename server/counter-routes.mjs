import express from 'express';
import { z } from 'zod';

/** @param {Pick<import('../src/durable-objects.ts').Counter, 'getState' | 'getLatestCount' | 'doneSpeaking' | 'stop' | 'reset'> | null} counter */
export function counterRouter(counter, allowedOrigins) {
  const router = express.Router();
  router.get('/', async (_req, res) => {
    try { res.json(await counter.getState()); }
    catch { res.status(503).json({ error: 'Start npm run counter, then restart npm run dev.' }); }
  });
  router.use((req, res, next) => {
    if (!allowedOrigins.includes(req.get('origin'))) return res.status(403).json({ error: 'Use this web app’s own origin.' });
    next();
  });
  router.use(express.json({ limit: '2kb' }));
  const identity = z.object({ clientId: z.string().uuid() });
  const actions = {
    claim: [identity, ({ clientId }) => counter.getLatestCount(clientId)],
    complete: [identity.extend({ number: z.number().int().min(1).max(100) }), ({ clientId, number }) => counter.doneSpeaking(clientId, number)],
    cancel: [identity, ({ clientId }) => counter.stop(clientId)],
    reset: [z.object({}), () => counter.reset()],
  };
  for (const [action, [schema, invoke]] of Object.entries(actions)) {
    router.post(`/${action}`, async (req, res) => {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid counter request.' });
      try { res.json(await invoke(parsed.data)); }
      catch (error) { res.status(409).json({ error: error.message }); }
    });
  }
  return router;
}
