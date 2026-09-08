import type { Json, Message, OpeningKind, Session, Starter } from '../shared/types';
import { AppFailure } from './errors';

export const openingVersion = 'stomylos_opening_v1';
const exact = (value: any, keys: string[]) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function openingKind(snapshot: Json): OpeningKind {
  if (snapshot.opening === undefined) return 'starter';
  if (!['stomylos_conversation_v4', 'stomylos_conversation_v5', 'stomylos_conversation_v6', 'stomylos_conversation_v7'].includes(snapshot.version) || !exact(snapshot.opening, ['version', 'kind']) ||
      snapshot.opening.version !== openingVersion || !['starter', 'user'].includes(snapshot.opening.kind)) {
    throw new AppFailure('unsupported_opening');
  }
  return snapshot.opening.kind;
}

export function sessionOpening(session: Session): OpeningKind {
  const kind = openingKind(JSON.parse(session.chat_config));
  if (kind !== session.opening_kind || (kind === 'starter'
    ? [session.starter_id, session.starter_version, session.starter_text].some(value => typeof value !== 'string' || !value)
    : [session.starter_id, session.starter_version, session.starter_text].some(value => value !== null))) {
    throw new AppFailure('opening_source_changed');
  }
  return kind;
}

export interface ParkedStarter { question: Starter; message: Message }
export function parkedStarter(session: Session): ParkedStarter | null {
  if (!session.parked_starter) return null;
  let value: ParkedStarter;
  try { value = JSON.parse(session.parked_starter); } catch { throw new AppFailure('opening_source_changed'); }
  if (session.state !== 'draft' || sessionOpening(session) !== 'user' || !exact(value, ['question', 'message']) ||
      !exact(value.question, ['id', 'version', 'text']) || Object.values(value.question).some(v => typeof v !== 'string' || !v) ||
      !exact(value.message, ['id', 'session_id', 'sequence', 'role', 'content', 'origin', 'delivery', 'request_id']) ||
      typeof value.message.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.message.id) ||
      value.message.session_id !== session.id || value.message.sequence !== 0 || value.message.role !== 'assistant' ||
      value.message.origin !== 'starter' || value.message.delivery !== 'complete' || value.message.request_id !== null ||
      value.message.content !== value.question.text) throw new AppFailure('opening_source_changed');
  return value;
}

export function validateOpeningSource(session: Session, messages: Message[]) {
  const kind = sessionOpening(session);
  if (kind === 'user' ? messages.some(m => m.origin === 'starter') || (messages.length > 0 && messages[0].role !== 'user')
    : messages[0]?.origin !== 'starter' || messages[0].content !== session.starter_text || messages[0].sequence !== 0) {
    throw new AppFailure('opening_source_changed');
  }
  if (session.state === 'draft' && messages.length !== (kind === 'starter' ? 1 : 0)) throw new AppFailure('opening_is_frozen');
}
