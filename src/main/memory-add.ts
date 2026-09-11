import prompt from './memory-add-prompt.txt?raw';
import type { FlatMemoryDocument } from '../shared/memory';
import type { Json } from '../shared/types';
import { activeMemoryCharacterCap, memoryCharacters, normalizeMemoryText } from './memory-render';
import { memoryHash } from './memory-updater';
import { AppFailure } from './errors';
export { activeMemoryCharacterCap } from './memory-render';
export const memoryAddVersion = 'stomylos_memory_add_v1';
export function memoryAddBody(input: Json): Json {
  return { model:'openai/gpt-5.6-luna', reasoning:{effort:'none',exclude:true}, max_tokens:2048,
    messages:[{role:'system',content:prompt},{role:'user',content:JSON.stringify(input)}],
    response_format:{type:'json_schema',json_schema:{name:'add_only_v1',strict:true,schema:{type:'object',properties:{add:{type:'array',items:{type:'string',minLength:1}}},required:['add'],additionalProperties:false}}}, provider:{require_parameters:true} };
}
export function addAndFifo(before: FlatMemoryDocument, content: string, messageId: string) {
  let value: any;
  try { value=JSON.parse(content); } catch { throw new AppFailure('memory_add_format'); }
  if (!value || Object.keys(value).length!==1 || !Array.isArray(value.add) || value.add.length>4096 ||
    value.add.some((s: unknown)=>typeof s!=='string'||!s.trim())) throw new AppFailure('memory_add_format');
  const added = (value.add as string[]).map((text,index)=>({id:'add_'+memoryHash(JSON.stringify([memoryAddVersion,messageId,index])).slice(0,24),text:normalizeMemoryText(text)}));
  if(added.some(r=>Array.from(r.text).length+2>activeMemoryCharacterCap))throw new AppFailure('memory_add_item_capacity');
  const document = structuredClone(before), evicted = [];
  document.database_records.push(...added);
  while (memoryCharacters(document)>activeMemoryCharacterCap) evicted.push(document.database_records.shift()!);
  if (added.length) document.revision++;
  return {document,changes:{added,evicted}};
}
