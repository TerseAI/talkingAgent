export const DEV_AGENTS = [
  { port: 3002, name: 'Alice', voice: 'marin' },
  { port: 3003, name: 'Bob', voice: 'cedar' },
  { port: 3004, name: 'Charlie', voice: 'coral' },
  { port: 3005, name: 'Dana', voice: 'ash' },
];

export function agentForPort(port) {
  return DEV_AGENTS.find((agent) => agent.port === port) ?? { port, name: 'Alice', voice: 'marin' };
}
