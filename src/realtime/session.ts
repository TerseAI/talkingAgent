import { RealtimeAgent, RealtimeSession, OpenAIRealtimeWebRTC } from '@openai/agents/realtime';
import { AGENT_MODEL, AGENT_REASONING_EFFORT, AGENT_VOICE } from '../../shared/agent-config.mjs';
import { agentName } from '../../shared/agent-identity.mjs';

export type RealtimeCredential = { value: string; toolsEnabled: boolean };

export async function requestRealtimeCredential(signal: AbortSignal): Promise<RealtimeCredential> {
  const response = await fetch('/api/session', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || 'Could not start an OpenAI Realtime session.');
  if (typeof data?.value !== 'string' || !data.value.startsWith('ek_') || typeof data.toolsEnabled !== 'boolean') {
    throw new Error('Invalid OpenAI Realtime configuration. Restart the server and refresh.');
  }
  return { value: data.value, toolsEnabled: data.toolsEnabled };
}

/** OpenAI Realtime setup only. The caller owns media, UI, and session lifecycle. */
export function createOpenAIRealtimeSession({ stream, audio, voice = AGENT_VOICE, instructions, tools = [] }: {
  stream: MediaStream;
  audio: HTMLAudioElement;
  voice?: string;
  instructions: string;
  tools?: ConstructorParameters<typeof RealtimeAgent>[0]['tools'];
}) {
  const agent = new RealtimeAgent({
    name: agentName(voice),
    instructions,
    tools,
  });
  return new RealtimeSession(agent, {
    model: AGENT_MODEL,
    transport: new OpenAIRealtimeWebRTC({ mediaStream: stream, audioElement: audio }),
    config: {
      reasoning: { effort: AGENT_REASONING_EFFORT },
      audio: {
        input: {
          transcription: { model: 'gpt-4o-mini-transcribe' },
          turnDetection: { type: 'semantic_vad', createResponse: true, interruptResponse: true },
        },
        output: { voice },
      },
    },
  });
}
