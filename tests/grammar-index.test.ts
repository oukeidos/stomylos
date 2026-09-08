import { expect, it } from 'vitest';
import { endRetryDelay } from '../src/main/end-retry';
import { AppFailure } from '../src/main/errors';
import { readFileSync } from 'node:fs';
import { grammarBody, grammarSnapshot, validateGrammar, hash } from '../src/main/contracts';
import goldens from './fixtures/contract-goldens.json';
import type { Message } from '../src/shared/types';
const learner = (id: string): Message => ({ id, session_id:'s', sequence:1, role:'user', origin:'learner', delivery:'complete', request_id:null, content:'  Same.\r\n한글  ' });
const users = [learner('first'), learner('second')];
const source: Message[] = [{...learner('opening'), role:'assistant',origin:'starter'},users[0],{...learner('hidden'),origin:'synthetic' as Message['origin']},{...learner('reply'),role:'assistant',origin:'model'},users[1]];
it('sends only indexed learner occurrences with exact tested low settings and reconstructs repeated originals', () => {
  const snapshot=grammarSnapshot(), body=grammarBody(snapshot,source);
  expect(body.reasoning).toEqual({exclude:true,effort:'low'});
  expect(body.messages[0].content).toBe(readFileSync('../experiments/EXP-009-authentic-conversation-grammar/context-ablation-2026-09-08/index-prompt.txt','utf8'));
  expect(JSON.parse(body.messages[1].content)).toEqual(users.map((m,index)=>({index,role:'user',content:m.content})));
  const units=users.map((m,index)=>({index,corrected_text:m.content,explanation:''}));
  expect(validateGrammar(JSON.stringify({units}),source,snapshot).map(u=>[u.source_message_id,u.ordinal,u.text])).toEqual(users.map((m,i)=>[m.id,i,m.content]));
  for(const indices of [[0,0],[1,0],[0,2],[0,'1'],[0,1.5],[0,true],[0]]) {
    expect(()=>validateGrammar(JSON.stringify({units:indices.map(index=>({index,corrected_text:'Same.',explanation:'Edit.'}))}),source,snapshot)).toThrow();
  }
  expect(()=>validateGrammar(JSON.stringify({units:[{...units[0],text:users[0].content},units[1]]}),source,snapshot)).toThrow('grammar_schema');
  expect(()=>validateGrammar(JSON.stringify({units:[{...units[0],corrected_text:'Same.'},units[1]]}),source,snapshot)).toThrow('grammar_empty_correction_or_note');
  expect(validateGrammar(JSON.stringify({units:[{...units[0],explanation:'Context.'},units[1]]}),source,snapshot)[0].warnings).toBe('["unchanged_with_note"]');
});
it('retains the frozen full/medium/text contract and rejects mixed or unknown grammar contracts', () => {
  const old=goldens.legacy.grammar_snapshot;
  expect(grammarBody(old,source).reasoning.effort).toBe('medium');
  expect(JSON.parse(grammarBody(old,source).messages[1].content)).toHaveLength(source.length);
  const legacySource=users;
  const content=JSON.stringify({units:users.map(m=>({text:m.content,corrected_text:m.content,explanation:''}))});
  expect(validateGrammar(content,legacySource,old)).toHaveLength(2);
  expect(()=>validateGrammar(content,legacySource,grammarSnapshot())).toThrow('grammar_schema');
  for (const snapshot of [{...old,version:'unknown'},{...old,version:grammarSnapshot().version},{...grammarSnapshot(),schema_sha256:hash('wrong')}]) {
    expect(()=>grammarBody(snapshot,source)).toThrow('unsupported_grammar_settings');
    expect(()=>validateGrammar(content,legacySource,snapshot)).toThrow('unsupported_grammar_settings');
  }
});

it('retains the automatic output-validation retry policy for invalid indices', () => {
  expect(endRetryDelay(new AppFailure('grammar_source_index'))).toBe(0);
  expect(endRetryDelay(new AppFailure('unsupported_grammar_settings'))).toBeNull();
});
