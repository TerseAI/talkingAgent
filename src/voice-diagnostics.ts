import type { TransportEvent } from '@openai/agents/realtime';
import { agentLabel } from '../shared/agent-identity.mjs';
import { recordBrowserLog } from './browser-logs';

export function logVoiceEvent(participantId: string | null, event: string, details: Record<string, unknown> = {}) {
  const timestamp = new Date().toISOString();
  console.info(`[${timestamp}] [voice] ${agentLabel(participantId)} ${event} | ${JSON.stringify({ participantId, ...details })}`);
  recordBrowserLog({ timestamp, participantId, event, details });
}

export function logRealtimeEvent(participantId: string, event: TransportEvent, audio: HTMLAudioElement) {
  switch (event.type) {
    case 'response.created':
    case 'response.done': {
      const response = event.response;
      logVoiceEvent(participantId, event.type, {
        responseId: response?.id, status: response?.status, statusDetails: response?.status_details,
        outputModalities: response?.output_modalities, output: response?.output?.map(summarizeOutput),
        outputTokens: response?.usage?.output_token_details, playback: playbackSnapshot(audio),
      });
      return;
    }
    case 'response.output_item.added':
    case 'response.output_item.done':
      logVoiceEvent(participantId, event.type, { responseId: event.response_id, item: event.item && summarizeOutput(event.item) });
      return;
    case 'response.output_audio.done':
    case 'response.output_audio_transcript.done':
    case 'response.output_text.done':
    case 'response.function_call_arguments.done':
    case 'conversation.item.input_audio_transcription.completed':
    case 'conversation.item.truncated':
    case 'input_audio_buffer.speech_started':
    case 'input_audio_buffer.speech_stopped':
    case 'output_audio_buffer.started':
    case 'output_audio_buffer.stopped':
    case 'output_audio_buffer.cleared': {
      const fields = event as Record<string, unknown>;
      logVoiceEvent(participantId, event.type, {
        responseId: fields.response_id, itemId: fields.item_id, callId: fields.call_id,
        contentIndex: fields.content_index, transcript: fields.transcript, text: fields.text,
        audioStartMs: fields.audio_start_ms, audioEndMs: fields.audio_end_ms, playback: playbackSnapshot(audio),
      });
      return;
    }
    case 'error': {
      const error = event.error as { type?: string; code?: string; message?: string; param?: string; event_id?: string } | undefined;
      logVoiceEvent(participantId, event.type, {
        type: error?.type, code: error?.code, message: error?.message, param: error?.param, eventId: error?.event_id,
      });
    }
  }
}

export function observeAudioPlayback(participantId: string, audio: HTMLAudioElement) {
  const events = ['playing', 'pause', 'waiting', 'stalled', 'ended', 'error', 'volumechange'];
  const log = (event: Event) => logVoiceEvent(participantId, `audio_element.${event.type}`, playbackSnapshot(audio));
  events.forEach((event) => audio.addEventListener(event, log));
  return () => events.forEach((event) => audio.removeEventListener(event, log));
}

function summarizeOutput(item: {
  id?: string; type?: string; role?: string; status?: string; phase?: string; name?: string; call_id?: string;
  content?: { type?: string; transcript?: string | null; text?: string | null }[];
}) {
  return {
    itemId: item.id, type: item.type, role: item.role, status: item.status, phase: item.phase,
    tool: item.name, callId: item.call_id,
    content: item.content?.map(({ type, transcript, text }) => ({ type, transcript, text })),
  };
}

function playbackSnapshot(audio: HTMLAudioElement) {
  return {
    paused: audio.paused, muted: audio.muted, volume: audio.volume,
    readyState: audio.readyState, currentTime: audio.currentTime,
    error: audio.error && { code: audio.error.code, message: audio.error.message },
    visibility: typeof document === 'undefined' ? undefined : document.visibilityState,
  };
}
