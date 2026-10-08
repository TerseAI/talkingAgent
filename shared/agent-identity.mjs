import { DEV_AGENTS } from './agent-roster.mjs';

export function agentName(voice) {
  return DEV_AGENTS.find((agent) => agent.voice === voice)?.name ?? 'Assistant';
}

export function agentLabel(id) {
  if (!id) return 'nobody';
  const [name, session] = id.split(':');
  return session ? `${name} (${session.slice(0, 8)})` : `Agent ${id.slice(0, 8)}`;
}

export function logCountingEvent(event, agentId, detail = '') {
  console.info(`[${new Date().toISOString()}] [counting] ${agentLabel(agentId)} ${event}${detail ? ` | ${detail}` : ''}`);
}
