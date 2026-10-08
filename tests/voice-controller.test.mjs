import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { VoiceController } from '../ui/src/voice-controller.ts';

function setup(connect) {
  const session = new EventEmitter();
  session.removeAllListeners = undefined;
  session.transport = new EventEmitter();
  session.connect = () => connect(session.transport);
  let closed = false;
  session.close = () => { closed = true; };
  const track = new EventTarget();
  let stopped = false;
  track.stop = () => { stopped = true; };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const audio = new EventTarget();
  audio.pause = () => {};
  const controller = new VoiceController({
    getMedia: async () => stream,
    createAudio: () => audio,
    getToken: async () => ({ value: 'ek_test', toolsEnabled: false }),
    createSession: async () => session,
  });
  return { controller, session, released: () => closed && stopped };
}

test('failed browser connection shows its original error and releases resources', async () => {
  const { controller, session, released } = setup(async (transport) => {
    transport.emit('connection_change', 'disconnected');
    throw new Error('Realtime call request failed with status 400: invalid configuration');
  });
  await controller.start();
  assert.equal(controller.getSnapshot().status, 'error');
  assert.match(controller.getSnapshot().error, /status 400: invalid configuration/);
  assert.equal(released(), true);
  assert.equal(session.eventNames().length, 0);
});

test('disconnecting an established browser session releases resources and leaves connecting state', async () => {
  const { controller, session, released } = setup(async () => {});
  await controller.start();
  assert.equal(controller.getSnapshot().status, 'connected');
  session.transport.emit('connection_change', 'disconnected');
  assert.equal(controller.getSnapshot().status, 'error');
  assert.equal(released(), true);
  assert.equal(session.eventNames().length, 0);
});

test('session error events preserve the API error message', async () => {
  const { controller, session, released } = setup(async () => {});
  await controller.start();
  session.emit('error', { type: 'error', error: new Error('You have no credits remaining.') });
  assert.equal(controller.getSnapshot().error, 'You have no credits remaining.');
  assert.equal(released(), true);
});
