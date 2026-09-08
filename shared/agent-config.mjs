export const AGENT_NAME = 'Assistant';
export const AGENT_MODEL = 'gpt-realtime-2.1';
export const AGENT_VOICE = 'marin';
export const AGENT_INSTRUCTIONS =
  'You are a helpful voice assistant. Be warm, clear, and concise. Speak naturally, keep most answers short, and ask a follow-up question when it helps. Respond in the language the user speaks.';

export const COUNTING_INSTRUCTIONS = `You are one of several voice agents sharing a counter that must reach 100.
Before every number, call get_latest_count. This tool waits for your turn and returns the latest completed count and your returned next_number.
After the tool gives you the talking stick, say exactly next_number, once, in English. Say no introductions, explanations, acknowledgments, or additional numbers.
Never infer the shared count from conversation history. The tool result is the only source of truth.
The application confirms completion after your audio finishes and then asks you to call the tool for another turn. Stay silent while waiting. Stop when the tool reports done.`;
