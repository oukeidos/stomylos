import { catalogIdentity } from './catalog-content';
import type Database from 'better-sqlite3';
import { randomInt } from 'node:crypto';
import type { Starter } from '../shared/types';
import { AppFailure } from './errors';
import { catalogKey } from './migrations/019-data';

type Candidate = Starter & { normalized_text: string; answer_count: number };
export function weightedQuestion<T extends { answer_count: number }>(questions: T[], draw: number): T {
  if (!questions.length) throw new AppFailure('starter_session_exhausted');
  if (!(draw >= 0 && draw < 1)) throw new AppFailure('starter_random_invalid');
  const weights = questions.map(q => 1 / (1 + q.answer_count));
  let cursor = draw * weights.reduce((a, b) => a + b, 0);
  for (const [i, weight] of weights.entries()) { cursor -= weight; if (cursor < 0) return questions[i]; }
  return questions[questions.length - 1];
}
export function selectCatalog(db: Database.Database, current?: string, sessionId?: string,
  draw = () => randomInt(0x100000000) / 0x100000000) {
  const blocked = new Set<string>(), blockedText = new Set<string>();
  const block = (id?: string | null, text?: string | null) => {
    const identity = catalogIdentity(db, id, text);
    if (identity) blocked.add(identity); else if (text) blockedText.add(catalogKey(text));
  };
  block(current);
  if (sessionId) {
    for (const e of db.prepare("SELECT question_id,text FROM starter_events WHERE session_id=? AND kind IN ('presented','replaced')").all(sessionId) as {question_id:string;text:string}[]) block(e.question_id,e.text);
    const session = db.prepare('SELECT starter_id,starter_text,parked_starter FROM sessions WHERE id=?').get(sessionId) as {starter_id:string|null;starter_text:string|null;parked_starter:string|null} | undefined;
    if (session) block(session.starter_id,session.starter_text);
    if (session?.parked_starter) { const q = JSON.parse(session.parked_starter).question; block(q.id,q.text); }
  }
  const recent = (db.prepare("SELECT question_id,text FROM starter_events WHERE kind IN ('presented','replaced') ORDER BY rowid DESC LIMIT 5").all() as {question_id:string;text:string}[])
    .map(e => ({id:catalogIdentity(db,e.question_id,e.text),text:catalogKey(e.text)}));
  const all = db.prepare(`SELECT q.id,q.version,q.text,q.normalized_text,c.answer_count FROM starter_catalog_entries c
    JOIN starter_questions q ON q.id=c.question_id WHERE c.eligible=1 AND q.state='active' ORDER BY c.question_id`).all() as Candidate[];
  if (!all.length) throw new AppFailure('starter_catalog_corrupt');
  const pool = all.filter(q => !blocked.has(q.id) && !blockedText.has(q.normalized_text));
  if (!pool.length) throw new AppFailure('starter_session_exhausted');
  let allowed = pool.filter(q => !recent.some(e => e.id ? e.id === q.id : e.text === q.normalized_text)), relaxed = false;
  while (!allowed.length) {
    recent.pop(); relaxed = true;
    allowed = pool.filter(q => !recent.some(e => e.id ? e.id === q.id : e.text === q.normalized_text));
  }
  return { question: { ...weightedQuestion(allowed, draw()), slot: null, pending_since: null }, fallback: false, relaxed };
}
