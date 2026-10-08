import type { RealtimeSession } from '@openai/agents/realtime';
import type { CountingConnection } from '../counting-connection';
import { CountingTurnDriver } from '../counting-turns';
import { logVoiceEvent } from '../voice-diagnostics';

/** Optional room integration; never attached when durable-object tools are disabled. */
export function attachCountingToRealtime(session: RealtimeSession, connection: CountingConnection, participantId: string, setListening: (listening: boolean) => void) {
  const driver = new CountingTurnDriver(participantId, {
    requestResponse: (instructions, number) => session.transport.sendEvent({ type: 'response.create', response: { instructions, metadata: { number: String(number) } } }),
    increment: connection.increment,
    pauseCount: () => { connection.pauseCount().catch(() => {}); },
    setListening,
  }, (event, details) => logVoiceEvent(participantId, event, details));
  connection.onStateChanged = (state, speakerId) => driver.onState(state, speakerId);
  const onEvent = (event: { type: string }) => driver.onTransportEvent(event);
  session.on('transport_event', onEvent);
  return () => {
    session.off('transport_event', onEvent);
    connection.onStateChanged = () => {};
  };
}
