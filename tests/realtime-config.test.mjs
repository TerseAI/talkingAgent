import assert from 'node:assert/strict';
import test from 'node:test';
import { durableActorToolsEnabled } from '../server/realtime-config.mjs';

test('coordination follows the Durable Actors environment setting', () => {
  const previous = process.env.DURABLE_ACTORS_TOOLS;
  try {
    process.env.DURABLE_ACTORS_TOOLS = 'false';
    assert.equal(durableActorToolsEnabled(), false);
    process.env.DURABLE_ACTORS_TOOLS = 'true';
    assert.equal(durableActorToolsEnabled(), true);
    process.env.DURABLE_ACTORS_TOOLS = 'invalid';
    assert.throws(() => durableActorToolsEnabled(), /DURABLE_ACTORS_TOOLS/);
  } finally {
    if (previous === undefined) delete process.env.DURABLE_ACTORS_TOOLS;
    else process.env.DURABLE_ACTORS_TOOLS = previous;
  }
});
