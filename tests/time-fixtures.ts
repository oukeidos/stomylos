import { conversationComponents, conversationSystem, hash } from '../src/main/contracts';
import v5 from '../src/main/conversation-v5-config.json';
import { recordedTime, temporalHash, timeSources } from '../src/main/time-context';
import type { Json, Message } from '../src/shared/types';
import universal from '../src/main/universal-v1-config.json';

export const publicTime = recordedTime('2026-09-05T03:00:00.000Z', 'Asia/Seoul', 540);
export function timed(snapshot: Json, messages: Message[]): Json {
  const result = structuredClone(snapshot);
  result.time_context = { reply_reference: publicTime, sources: timeSources(messages, () => publicTime) };
  result.temporal_source_hash = temporalHash(result.time_context.sources);
  result.system_sha256 = hash(conversationSystem(result, messages));
  return result;
}
export function universalSnapshot(memory = false): Json {
  return { ...structuredClone(universal.conversation), system_prompt: universal.conversationPrompt,
    prompt_id: 'stomylos_conversation_prompt_v3', prompt_sha256: hash(universal.conversationPrompt),
    ...(memory ? { memory_version: 'stomylos_memory_context_v1' } : {}) };
}
export function v5Snapshot(kind: 'starter' | 'user' = 'starter'): Json {
  return { ...structuredClone(v5.conversation), system_prompt: v5.conversationPrompt,
    prompt_id: 'stomylos_conversation_prompt_v4', prompt_sha256: hash(v5.conversationPrompt), app_version: '0.13.1',
    memory_version: 'stomylos_memory_context_v2', time_version: 'stomylos_time_context_v1',
    component_hashes: conversationComponents(v5.conversation.version), opening: { version: 'stomylos_opening_v1', kind } };
}
