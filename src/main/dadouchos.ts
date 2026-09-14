import { createHash } from 'node:crypto';
import type { SessionView, Message } from '../shared/types';
import { AppFailure } from './errors';
import prompt from './dadouchos-prompt.txt?raw';
import contract from './dadouchos-contract.json';
export { contract as dadouchosContract };
export const dadouchosIdentity = { allowed_models: [contract.model], provider: null };
export const dadouchosPromptHash = createHash('sha256').update(prompt).digest('hex');
export interface DadouchosSource { sessionId: string; hash: string; messages: {role: 'user' | 'assistant'; content: string}[] }
export function dadouchosSource(view: SessionView): DadouchosSource {
  const { session, messages } = view, last = messages.at(-1);
  if (session.state !== 'active' || view.partner.pending || view.endProcessing || !last || last.role !== 'assistant' || last.delivery !== 'complete' || messages.filter(m=>m.origin==='learner').length >= 24)
    throw new AppFailure('dadouchos_unavailable');
  const pairs: Message[][] = [];
  for (let i=0;i<messages.length;i++) {
    const user=messages[i];
    if (user.origin !== 'learner') continue;
    const reply=messages[++i];
    if (user.role!=='user' || user.delivery!=='complete' || !reply || reply.origin!=='model' || reply.role!=='assistant' || reply.delivery!=='complete' || !user.content.trim() || !reply.content.trim()) throw new AppFailure('dadouchos_unavailable');
    pairs.push([user,reply]);
  }
  if (!pairs.length) throw new AppFailure('dadouchos_unavailable');
  const selected=pairs.slice(-3).flat();
  return {sessionId:session.id,hash:createHash('sha256').update(JSON.stringify([session.id,view.partner.revision,selected.map(m=>[m.id,m.content])])).digest('hex'),messages:selected.map(({role,content})=>({role,content}))};
}
export function dadouchosBody(source: DadouchosSource) {
  const body={model:contract.model,reasoning:contract.reasoning,max_tokens:contract.max_tokens,stream:false,
    provider:{require_parameters:true,allow_fallbacks:true,data_collection:'deny'},
    messages:[{role:'system',content:prompt},{role:'user',content:'Recent conversation (JSON data):\n'+JSON.stringify(source.messages)}]};
  if (Buffer.byteLength(JSON.stringify(body))>256_000) throw new AppFailure('dadouchos_input_limit');
  return body;
}
export function parseDadouchos(text: string) {
  if (typeof text!=='string' || !text.trim()) throw new AppFailure('dadouchos_output');
  return text.trim();
}
