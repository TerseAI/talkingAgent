export type Entry = { id: string; role: 'user' | 'assistant'; text: string; status: 'in_progress' | 'completed' | 'incomplete' };
type Item = { id?: string; type?: string; role?: string; status?: Entry['status']; content?: { type: string; text?: string; transcript?: string }[] };
export type RealtimeEvent = {
  type: string; item_id?: string; item?: Item; delta?: string; transcript?: string; text?: string;
  error?: { code?: string; message?: string };
  response?: { status?: string; output?: Item[] };
};

function upsert(entries: Entry[], id: string, patch: Partial<Entry>): Entry[] {
  const index = entries.findIndex((entry) => entry.id === id);
  if (index === -1) return [...entries, { id, role: 'assistant', text: '', status: 'in_progress', ...patch }];
  return entries.map((entry, i) => i === index ? { ...entry, ...patch } : entry);
}

function addItem(entries: Entry[], item?: Item): Entry[] {
  if (!item?.id || item.type !== 'message' || !['user', 'assistant'].includes(item.role ?? '')) return entries;
  const text = item.content?.map((part) => part.transcript ?? part.text ?? '').join('\n') ?? '';
  return upsert(entries, item.id, { role: item.role as Entry['role'], ...(text ? { text } : {}), status: item.status ?? 'in_progress' });
}

/** Reconciles streamed and final events into this instance's local transcript only. */
export function applyEvent(entries: Entry[], event: RealtimeEvent): Entry[] {
  if (['conversation.item.added', 'conversation.item.created', 'response.output_item.added', 'response.output_item.done'].includes(event.type)) return addItem(entries, event.item);
  if (event.type === 'response.done') return (event.response?.output ?? []).reduce(addItem, entries);
  const id = event.item_id;
  if (!id) return entries;
  if (event.type === 'input_audio_buffer.speech_started') return upsert(entries, id, { role: 'user' });
  if (event.type.endsWith('input_audio_transcription.failed')) return upsert(entries, id, { role: 'user', text: '[Transcription unavailable]', status: 'incomplete' });
  if (event.type === 'conversation.item.truncated') return upsert(entries, id, { status: 'incomplete' });
  if (/input_audio_transcription\.(delta|completed)$/.test(event.type)) {
    const previous = entries.find((entry) => entry.id === id)?.text ?? '';
    return upsert(entries, id, { role: 'user', text: event.transcript ?? previous + (event.delta ?? ''), status: event.type.endsWith('completed') ? 'completed' : 'in_progress' });
  }
  if (/response\.(output_audio_transcript|audio_transcript|output_text|text)\.(delta|done)$/.test(event.type)) {
    const previous = entries.find((entry) => entry.id === id)?.text ?? '';
    return upsert(entries, id, { role: 'assistant', text: event.transcript ?? event.text ?? previous + (event.delta ?? ''), status: event.type.endsWith('done') ? 'completed' : 'in_progress' });
  }
  return entries;
}
