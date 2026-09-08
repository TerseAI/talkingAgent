import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const browserLogBatchSchema = z.object({
  pageId: z.string().uuid(),
  entries: z.array(z.object({
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime(),
    participantId: z.string().max(100).nullable(),
    event: z.string().max(160),
    details: z.record(z.string(), z.unknown()),
  })).min(1).max(100),
});

export async function createBrowserLogWriter(directory, agent) {
  await mkdir(directory, { recursive: true });
  return async ({ pageId, entries }) => {
    const receivedAt = new Date().toISOString();
    const lines = entries.map((entry) => JSON.stringify({ ...entry, agent, pageId, receivedAt })).join('\n');
    await appendFile(join(directory, `${agent}-${pageId}.jsonl`), `${lines}\n`, { mode: 0o600 });
  };
}
