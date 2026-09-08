import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import goldens from './fixtures/contract-goldens.json';
import { appVersion, characters, config, conversationBody, conversationSnapshot, grammarBody, grammarSnapshot, hash, routerBody, starters, transcriptJson } from '../src/main/contracts';
import type { Message } from '../src/shared/types';
const sources = goldens.cases.map(rows => rows.map((row, sequence) => ({ ...row, id: `public-${sequence}`, session_id: 'public', sequence,
  origin: row.role === 'user' ? 'learner' : sequence === 0 ? 'starter' : 'model', delivery: 'complete', request_id: null }) as Message));
it('uses the package version for settings, request provenance and release backups', () => {
  expect(appVersion).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
});
it('preserves legacy schema definitions except the explicit entry columns and message deletion guards, and every source byte', () => {
  const schema = readFileSync('src/main/schema.sql', 'utf8');
  const withoutDeletionGuard = (sql: string) => sql.replace(/CREATE TRIGGER protect_message_delete[\s\S]*?END;/, '');
  const originalEntry = (sql: string) => sql
    .replace('  starter_id TEXT,', '  starter_id TEXT NOT NULL,')
    .replace('  starter_version TEXT,', '  starter_version TEXT NOT NULL,')
    .replace('  starter_text TEXT,', '  starter_text TEXT NOT NULL,')
    .replace(/  opening_kind TEXT[\s\S]*?  CHECK\(parked_starter IS NULL OR \(opening_kind='user' AND state='draft'\)\),\n/, '');
  expect(originalEntry(withoutDeletionGuard(schema.split('-- Starter renewal schema v2')[0])).trim()).toBe(withoutDeletionGuard(goldens.legacy.schema).trim());
  for (const [index, source] of sources.entries()) {
    expect(transcriptJson(source)).toBe(goldens.legacy.transcripts[index]);
    expect(hash(transcriptJson(source))).toBe(hash(goldens.legacy.transcripts[index]));
  }
});
it('preserves every original conversation body for historical sessions', () => {
  for (const character of goldens.legacy.conversation_config.characters) {
    expect(conversationBody(goldens.legacy.conversation_snapshot, character.id, sources[0][0].content, sources[0]))
      .toEqual((goldens.legacy.conversation_bodies as Record<string, object>)[character.id]);
  }
  expect(starters).toEqual(goldens.legacy.starters);
});
it('preserves grammar settings and uses the selected experimental schema without extra fields', () => {
  expect(grammarSnapshot()).toEqual({ ...goldens.legacy.grammar_snapshot, app_version: appVersion });
  expect(grammarBody(grammarSnapshot(), sources[0])).toEqual(goldens.legacy.grammar_body);
  expect(config.grammar.request_parameters.response_format).toEqual({ type: 'json_schema', json_schema: {
    name: 'stomylos_grammar_analysis_v1', strict: true, schema: goldens.grammar.schema } });
});
it('changes only the identified router export newline while preserving request settings and input', () => {
  const expected = structuredClone(goldens.legacy.router_body);
  expect(expected.messages[0].content).toBe(goldens.router.prompt + '\n');
  expected.messages[0].content = goldens.router.prompt;
  expect(routerBody(sources[0][0].content, sources[0][1].content, goldens.legacy.conversation_snapshot)).toEqual(expected);
});
