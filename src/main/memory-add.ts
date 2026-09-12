import prompt from './memory-add-prompt.txt?raw';
import type { FlatMemoryDocument } from '../shared/memory';
import type { Json } from '../shared/types';
import type { RecordedTime } from '../shared/time';
import { activeMemoryCharacterCap, memoryCharacters, normalizeMemoryText } from './memory-render';
import { memoryHash } from './memory-updater';
import { AppFailure } from './errors';
export { activeMemoryCharacterCap } from './memory-render';
export const memoryAddVersion = 'stomylos_memory_add_v1';
// Request provenance is independent of the immutable record-ID namespace above.
export const memoryAddRequestVersion = 'stomylos_memory_add_v2';
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function memoryAddDate(sent?: RecordedTime | null): string | null {
  const date = sent?.local_date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const calendar = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== date) return null;
  return `${date} (${weekdays[calendar.getUTCDay()]})`;
}
export function memoryAddBody(input: Json, sent?: RecordedTime | null): Json {
  const wire = structuredClone(input);
  delete wire.timezone;
  if (wire.current_user) wire.current_user.sent_at = memoryAddDate(sent);
  return { model:'openai/gpt-5.6-luna', reasoning:{effort:'none',exclude:true}, max_tokens:2048,
    messages:[{role:'system',content:prompt},{role:'user',content:JSON.stringify(wire)}],
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
