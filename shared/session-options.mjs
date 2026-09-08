import { AGENT_INSTRUCTIONS, AGENT_VOICE, COUNTING_INSTRUCTIONS } from './agent-config.mjs';

/** Each request creates an independent voice session; counting tools share an actor. */
export function sessionOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid session options.');
  const { mode = 'assistant', instance = 1 } = input;
  if (!['assistant', 'group-counting', 'shared-counting'].includes(mode) || !Number.isInteger(instance) || instance < 1 || instance > 3) {
    throw new Error('Choose assistant or group-counting mode and a participant from 1 to 3.');
  }
  if (mode === 'assistant') return { instructions: AGENT_INSTRUCTIONS, voice: AGENT_VOICE };
  if (mode === 'shared-counting') return { instructions: COUNTING_INSTRUCTIONS, voice: AGENT_VOICE };
  return {
    voice: ['marin', 'cedar', 'coral'][instance - 1],
    instructions: `You are participant ${instance} in a spoken group counting experiment with three independent voice agents.
Together, the group should count aloud from 1 through 10 in ascending order, saying each number only once across the group.
Wait until a human says "begin" or "start" before participating. Do not greet or acknowledge the instructions.
Listen to the other voices. When you decide it is your turn, say only the next number, then wait and listen. Never say multiple numbers in one response.
Do not announce your participant number, explain the game, narrate your reasoning, or assign turns. There is no predetermined speaking order.
Base your decisions only on what you actually hear. If you hear another participant speak, let them finish. If voices overlap or repeat a number, recover from the last number you clearly heard.
After you hear or say 10, stay silent until a human explicitly asks for a new round.`,
  };
}
