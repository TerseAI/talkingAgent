export function durableActorToolsEnabled(value = process.env.DURABLE_ACTORS_TOOLS ?? 'true') {
  if (!['true', 'false'].includes(value)) throw new Error('DURABLE_ACTORS_TOOLS must be true or false.');
  return value === 'true';
}
