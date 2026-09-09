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
  const blocked = new Set<string>();
  if (current) {
    const q = db.prepare('SELECT normalized_text FROM starter_questions WHERE id=?').get(current) as {normalized_text:string} | undefined;
    if (q) blocked.add(q.normalized_text);
  }
  if (sessionId) {
    for (const e of db.prepare("SELECT text FROM starter_events WHERE session_id=? AND kind IN ('presented','replaced')").all(sessionId) as {text:string}[]) blocked.add(catalogKey(e.text));
    const session = db.prepare('SELECT starter_text,parked_starter FROM sessions WHERE id=?').get(sessionId) as {starter_text:string|null;parked_starter:string|null} | undefined;
    if (session?.starter_text) blocked.add(catalogKey(session.starter_text));
    if (session?.parked_starter) blocked.add(catalogKey(JSON.parse(session.parked_starter).question.text));
  }
  const recent = (db.prepare("SELECT text FROM starter_events WHERE kind IN ('presented','replaced') ORDER BY rowid DESC LIMIT 5").all() as {text:string}[]).map(e => catalogKey(e.text));
  const all = db.prepare(`SELECT q.id,q.version,q.text,q.normalized_text,c.answer_count FROM starter_catalog_entries c
    JOIN starter_questions q ON q.id=c.question_id WHERE c.eligible=1 AND q.state='active' ORDER BY c.question_id`).all() as Candidate[];
  if (!all.length) throw new AppFailure('starter_catalog_corrupt');
  const pool = all.filter(q => !blocked.has(q.normalized_text));
  if (!pool.length) throw new AppFailure('starter_session_exhausted');
  let allowed = pool.filter(q => !recent.includes(q.normalized_text)), relaxed = false;
  while (!allowed.length) {
    recent.pop(); relaxed = true;
    allowed = pool.filter(q => !recent.includes(q.normalized_text));
  }
  return { question: { ...weightedQuestion(allowed, draw()), slot: null, pending_since: null }, fallback: false, relaxed };
}
