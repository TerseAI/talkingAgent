import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionOptions } from '../shared/session-options.mjs';
import { AGENT_INSTRUCTIONS, AGENT_VOICE } from '../shared/agent-config.mjs';

test('preserves the existing web assistant configuration', () => {
  assert.deepEqual(sessionOptions(), { instructions: AGENT_INSTRUCTIONS, voice: AGENT_VOICE });
});
test('gives each counting participant its own prompt and voice, without shared state', () => {
  const participants = [1, 2, 3].map((instance) => sessionOptions({ instance, mode: 'group-counting' }));
  participants.forEach((config, index) => {
    assert.match(config.instructions, new RegExp(`participant ${index + 1}`));
    assert.match(config.instructions, /only the next number/);
    assert.match(config.instructions, /no predetermined speaking order/);
  });
  assert.equal(new Set(participants.map((config) => config.voice)).size, 3);
});
test('rejects invalid session configurations', () => {
  for (const input of [null, [], { mode: 'unknown' }, { instance: 4 }, { instance: '1' }]) assert.throws(() => sessionOptions(input));
});
