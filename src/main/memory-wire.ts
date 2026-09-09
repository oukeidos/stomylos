import { memoryCategories, type MemoryPacket, type MemoryOperation } from '../shared/memory';
import { AppFailure } from './errors';

function fail(code: string): never { throw new AppFailure('memory_' + code); }

// Only called after canonical packet validation. Maps are request-local and never persisted.
export function memoryWire(packet: MemoryPacket) {
  const targets = new Map<string, string>(), sources = new Map<string, string>();
  const identities = new Set<string>();
  const memory = Object.fromEntries(memoryCategories.map(category => [category, packet.current_memory[category].map(item => {
    if (identities.has(item.id)) fail('item');
    identities.add(item.id);
    const id = `m${targets.size + 1}`; targets.set(id, item.id);
    return { id, text: item.text };
  })]));
  identities.clear();
  const timezone = packet.session.messages.find(m => m.sent_time)?.sent_time?.timezone ?? null;
  const counts = { u: 0, a: 0, x: 0 };
  const messages = packet.session.messages.map(m => {
    if (!m.id || identities.has(m.id)) fail('source');
    identities.add(m.id);
    const eligible = m.role === 'user' && m.origin === 'learner' && m.delivery === 'complete';
    const prefix = eligible ? 'u' : m.role === 'assistant' ? 'a' : 'x';
    const id = `${prefix}${++counts[prefix]}`;
    const value: { id: string; role: string; content: string; sent_at?: string | null; timezone?: string | null; evidence?: false; interrupted?: true } = { id, role: m.role, content: m.content };
    if (eligible) {
      sources.set(id, m.id); value.sent_at = null;
      if (m.sent_time) {
        const t = m.sent_time, offset = t.utc_offset_minutes, magnitude = Math.abs(offset);
        const suffix = `${offset < 0 ? '-' : '+'}${String(Math.floor(magnitude / 60)).padStart(2, '0')}:${String(magnitude % 60).padStart(2, '0')}`;
        value.sent_at = new Date(Date.parse(t.utc) + offset * 60000).toISOString().slice(0, -1) + suffix;
        if (t.timezone !== timezone) value.timezone = t.timezone;
      }
    } else if (m.role === 'user' || m.origin !== 'model') value.evidence = false;
    if (m.delivery !== 'complete') value.interrupted = true;
    return value;
  });
  return { input: { memory, timezone, messages }, targets, sources };
}

// Structure and duplicate JSON keys are validated by the caller before mapping.
export function resolveMemoryOperation(op: MemoryOperation, maps: ReturnType<typeof memoryWire>): MemoryOperation {
  const source_message_ids = op.source_message_ids.map(id => maps.sources.get(id) ?? fail('source'));
  const id = op.op === 'add' ? op.id : maps.targets.get(op.id!) ?? fail('target');
  return { ...op, id, source_message_ids };
}
