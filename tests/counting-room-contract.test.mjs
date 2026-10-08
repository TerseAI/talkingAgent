import assert from 'node:assert/strict';
import test from 'node:test';
import { ActorCompiler, Persistence } from 'durable-actors/compiler';

test('CountingRoom uses persisted state supported by the current actor runtime', () => {
  const [actor] = new ActorCompiler().compile('src/counting-room.ts');

  assert.deepEqual(actor.fields, [
    { name: 'count', persistence: Persistence.Persisted },
    { name: 'running', persistence: Persistence.Persisted },
  ]);
});

test('CountingRoom compiles into a deployable Durable Actors contract', () => {
  const deployment = new ActorCompiler().compileDeployment('src/counting-room.ts');
  assert.equal(deployment.schemas[0].actorName, 'CountingRoom');
});
