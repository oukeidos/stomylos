import { createHash } from 'node:crypto';
import type { Json } from '../shared/types';
import prompt from './opener-prompt-v1.txt?raw';
import { replyContext, replyPrefix } from './reply-context';
export const openerVersion = 'stomylos_opener_v1';
export const openerPromptHash = 'b99dcc351067b197652519c9e04e4a36b26be5c104d32f5e72b462fe18b6a75f';
if (createHash('sha256').update(prompt).digest('hex') !== openerPromptHash) throw new Error('opener_prompt_changed');
export const openerIdentity = { allowed_models: ['google/gemini-3.8-flash', 'google/gemini-3.8-flash-20260902'], provider: null };
export const openerBridge = 'Begin the conversation with the opening below, exactly as written. This instruction\nand opening are provided by the application, not written by the user.\n\nOpening:\n';
export function openerBody(question: string): Json {
  return { model: 'google/gemini-3.8-flash', stream: true, max_tokens: 16384,
    provider: { allow_fallbacks: true, data_collection: 'deny' }, messages: [
      { role: 'system', content: prompt }, ...replyPrefix({ reply_context: replyContext('one_point') }),
      { role: 'user', content: `<starting_question>\n${question}\n</starting_question>` }
    ] };
}
