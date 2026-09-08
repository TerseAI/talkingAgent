import { expect, it, vi } from 'vitest';
import { CountingTurnDriver } from './counting-turns';
import type { CountingSnapshot } from './counting-api';

function setup() {
  const speaker = { requestResponse: vi.fn(), completeTurn: vi.fn(), pauseCount: vi.fn(), setListening: vi.fn() };
  const driver = new CountingTurnDriver('me', speaker);
  const state = (patch: Partial<CountingSnapshot>): CountingSnapshot => ({
    nextNumber: 7, completedCount: 6, targetCount: 100, currentSpeakerId: 'me', counting: true, finished: false, ...patch,
  });
  return { speaker, driver, state };
}

it('cues the number once per turn and completes when that response finishes playing', () => {
  const { speaker, driver, state } = setup();
  driver.onState(state({}), 't1');
  driver.onState(state({}), 't1');
  expect(speaker.requestResponse).toHaveBeenCalledOnce();
  expect(speaker.requestResponse.mock.calls[0]).toEqual([expect.stringMatching(/number 7/), 't1']);
  driver.onTransportEvent({ type: 'response.created', response: { id: 'sdk' } });
  driver.onTransportEvent({ type: 'response.done', response: { id: 'sdk', output: [{ type: 'message' }] } });
  driver.onTransportEvent({ type: 'output_audio_buffer.stopped', response_id: 'sdk' });
  expect(speaker.completeTurn).not.toHaveBeenCalled();
  driver.onTransportEvent({ type: 'response.created', response: { id: 'r1', metadata: { turnId: 't1' } } });
  driver.onTransportEvent({ type: 'output_audio_buffer.stopped', response_id: 'r0' });
  expect(speaker.completeTurn).not.toHaveBeenCalled();
  driver.onTransportEvent({ type: 'response.done', response: { id: 'r1', output: [{ type: 'message' }] } });
  driver.onTransportEvent({ type: 'output_audio_buffer.stopped', response_id: 'r1' });
  expect(speaker.completeTurn).toHaveBeenCalledWith('t1');
  driver.onTransportEvent({ type: 'output_audio_buffer.stopped', response_id: 'r1' });
  expect(speaker.completeTurn).toHaveBeenCalledOnce();
});

it('re-cues once when the model answers a cue without speaking', () => {
  const { speaker, driver, state } = setup();
  driver.onState(state({}), 't1');
  driver.onTransportEvent({ type: 'response.created', response: { id: 'r1', metadata: { turnId: 't1' } } });
  driver.onTransportEvent({ type: 'response.done', response: { id: 'r1', output: [{ type: 'function_call' }] } });
  expect(speaker.requestResponse).toHaveBeenCalledTimes(2);
  driver.onTransportEvent({ type: 'response.created', response: { id: 'r2', metadata: { turnId: 't1' } } });
  driver.onTransportEvent({ type: 'response.done', response: { id: 'r2', output: [] } });
  expect(speaker.requestResponse).toHaveBeenCalledTimes(2);
});

it('defers a cue while another response is in progress and drops it if the turn moves on', () => {
  const { speaker, driver, state } = setup();
  driver.onTransportEvent({ type: 'response.created', response: { id: 'chat' } });
  driver.onState(state({}), 't1');
  expect(speaker.requestResponse).not.toHaveBeenCalled();
  driver.onTransportEvent({ type: 'response.done', response: { id: 'chat', output: [{ type: 'message' }] } });
  expect(speaker.requestResponse).toHaveBeenCalledOnce();
  driver.onTransportEvent({ type: 'response.created', response: { id: 'other' } });
  driver.onState(state({ currentSpeakerId: 'you', nextNumber: 8 }), 't2');
  driver.onTransportEvent({ type: 'response.done', response: { id: 'other', output: [] } });
  driver.onState(state({}), 't3');
  expect(speaker.requestResponse).toHaveBeenCalledTimes(2);
  expect(speaker.requestResponse.mock.calls[1][0]).toMatch(/number 7/);
});

it('pauses the room once when the user starts speaking to the current speaker', () => {
  const { speaker, driver, state } = setup();
  driver.onTransportEvent({ type: 'input_audio_buffer.speech_started' });
  driver.onState(state({ currentSpeakerId: 'you' }), 't0');
  driver.onTransportEvent({ type: 'input_audio_buffer.speech_started' });
  expect(speaker.pauseCount).not.toHaveBeenCalled();
  driver.onState(state({}), 't1');
  driver.onTransportEvent({ type: 'input_audio_buffer.speech_started' });
  driver.onTransportEvent({ type: 'input_audio_buffer.speech_started' });
  expect(speaker.pauseCount).toHaveBeenCalledOnce();
  driver.onState(state({ counting: false, currentSpeakerId: null }), null);
  driver.onState(state({}), 't2');
  driver.onTransportEvent({ type: 'input_audio_buffer.speech_started' });
  expect(speaker.pauseCount).toHaveBeenCalledTimes(2);
});

it('closes the mic while others count and opens it when idle or speaking', () => {
  const { speaker, driver, state } = setup();
  driver.onState(state({ currentSpeakerId: 'you' }), 't1');
  expect(speaker.setListening).toHaveBeenLastCalledWith(false);
  driver.onState(state({}), 't2');
  expect(speaker.setListening).toHaveBeenLastCalledWith(true);
  driver.onState(state({ counting: false, currentSpeakerId: null }), null);
  expect(speaker.setListening).toHaveBeenLastCalledWith(true);
  driver.onTransportEvent({ type: 'response.created', response: { id: 'r' } });
  driver.onTransportEvent({ type: 'output_audio_buffer.stopped', response_id: 'r' });
  expect(speaker.completeTurn).not.toHaveBeenCalled();
});
