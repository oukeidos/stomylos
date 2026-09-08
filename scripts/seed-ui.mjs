// Public, invented stress data. This script is never included in the release.
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const directory = process.argv[2]; if (!directory) throw new Error('A temporary data directory is required');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const db = new Database(join(directory, 'stomylos.sqlite3'));
db.exec(readFileSync('src/main/schema.sql', 'utf8')); db.pragma('user_version = 13'); db.pragma('foreign_keys = ON');
const runtime = JSON.parse(readFileSync('src/main/universal-v1-config.json', 'utf8'));
const initialized = new Date().toISOString();
for (const [index, question] of runtime.starters.entries()) {
  db.prepare("INSERT INTO starter_questions(id,version,text,normalized_text,origin,state,created_at) VALUES(?,?,?,?,'seed','active',?)")
    .run(question.id, question.version, question.text, question.text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim(), initialized);
  db.prepare('INSERT INTO starter_slots(slot,question_id,initialized_at) VALUES(?,?,?)').run(index + 1, question.id, initialized);
}
const hash = text => createHash('sha256').update(text).digest('hex');
const memory = JSON.stringify({ character_id: 'shared', experiences: [], intentions: [], relationships: [], revision: 0, traits: [] });
db.prepare('INSERT INTO shared_memory VALUES(1,?,?)').run(memory, hash(memory));
const chat = JSON.stringify({ ...runtime.conversation, system_prompt: runtime.conversationPrompt, prompt_sha256: hash(runtime.conversationPrompt), app_version: JSON.parse(readFileSync('package.json', 'utf8')).version });
const note = 'The original message is clear in this context. This deliberately long public fixture checks that expanding a full session remains responsive without clipping text. '.repeat(8);
for (const [id, count, date] of [['fixture-full', 24, '2026-09-03T10:00:00.000Z'], ['fixture-forty', 20, '2026-09-02T10:00:00.000Z']]) {
  db.prepare("INSERT INTO sessions(id,state,starter_id,starter_version,starter_text,created_at,chat_config,character,model) VALUES(?,'active',?,?,?,?,?,'model_03','anthropic/claude-sonnet-5')")
    .run(id, 'public-fixture', 'public-fixture-v1', 'What small part of your day would you like to keep?', date, chat);
  const messages = [{ role: 'assistant', content: 'What small part of your day would you like to keep?' }];
  for (let ordinal = 0; ordinal < count; ordinal++) {
    messages.push({ role: 'user', content: `I enjoy a quiet walk before breakfast. It gives me time to notice the trees and listen to the birds. (${ordinal + 1})` });
    if (ordinal < count - 1) messages.push({ role: 'assistant', content: 'That small pocket of unhurried time gives the rest of the day a different rhythm. A familiar route can still offer something new: a change in light, a flower that was not open yesterday, or a sound you normally miss.' });
  }
  for (const [index, message] of messages.entries()) db.prepare('INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES(?,?,?,?,?,?,?)')
    .run(`${id}-m${index}`, id, index, message.role, message.content, index === 0 ? 'starter' : message.role === 'user' ? 'learner' : 'model', 'complete');
  const source = JSON.stringify(messages, null, 2); const requestId = `${id}-analysis`;
  db.prepare("UPDATE sessions SET state='ended',ended_at=?,source_hash=?,analysis_state='running' WHERE id=?").run(date, hash(source), id);
  db.prepare("INSERT INTO model_requests(id,session_id,role,status,created_at,dispatched_at,source_sequence,source_hash,config,config_hash) VALUES(?,?,'grammar','dispatched',?,?,?,?,?,?)")
    .run(requestId, id, date, date, messages.length - 1, hash(source), '{}', hash('{}'));
  const units = messages.filter(m => m.role === 'user').map((m, index) => ({ text: m.content, corrected_text: index % 3 === 0 ? m.content.replace('a quiet walk', 'a peaceful walk') : m.content, explanation: index % 3 === 0 ? note : '' }));
  for (const [index, unit] of units.entries()) db.prepare('INSERT INTO grammar_units(analysis_attempt_id,session_id,source_message_id,ordinal,text,corrected_text,explanation,changed,warnings) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(requestId, id, `${id}-m${index * 2 + 1}`, index, unit.text, unit.corrected_text, unit.explanation, unit.text !== unit.corrected_text ? 1 : 0, '[]');
  db.prepare("UPDATE model_requests SET status='succeeded',finished_at=?,response_content=? WHERE id=?").run(date, JSON.stringify({ units }), requestId);
  db.prepare("UPDATE sessions SET analysis_state='completed',selected_analysis_id=? WHERE id=?").run(requestId, id);
}
if (process.argv.includes('--history')) {
  for (let i = 0; i < 60; i++) {
    const id = `fixture-older-${String(i).padStart(2, '0')}`;
    db.prepare("INSERT INTO sessions(id,state,starter_id,starter_version,starter_text,created_at,chat_config) VALUES(?,'draft','public-fixture','public-fixture-v1',?,'2026-01-01T00:00:00.000Z',?)").run(id, `An older public conversation ${i + 1}`, chat);
    db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES(?,?,0,'assistant',?,'starter','complete')").run(`${id}-m0`, id, `An older public conversation ${i + 1}`);
    db.prepare("UPDATE sessions SET state='ended',analysis_state='skipped' WHERE id=?").run(id);
  }
}
db.close();
