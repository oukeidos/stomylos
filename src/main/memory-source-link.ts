import prompt from './memory-source-link-prompt.txt?raw';
import type {Json} from '../shared/types';
import {AppFailure} from './errors';
export const sourceLinkPrompt=prompt.trim();
export const sourceLinkVersion='stomylos_memory_sources_v1';
export const sourceLinkIdentity={allowed_models:['openai/gpt-5.6-luna'],provider:null};
export interface SourceLink {id:number;ids:number[]}
/** UTF-8 bytes conservatively bound byte-fallback text tokens, plus protocol margin.
 * Reserve a compact response listing every source once per record, not an average
 * English token ratio. The model may still waste output; truncation fails validation. */
export function linkBatches(conversation:Json[],records:string[],frozenPrompt=sourceLinkPrompt):Json[] {
 const messages=conversation.map((m,i)=>[i+1,m.role,m.content]);
 const messageIds=messages.map(m=>m[0]);
 const make=(rows:any[]):Json=>{
  // OpenAI permits at most 1000 enum values across the entire schema.
  // Both domains are contiguous integer ranges, so bounds are equivalent.
  const ranges=rows.length+messageIds.length>1000;
  const recordDomain=ranges?{minimum:rows[0][0],maximum:rows.at(-1)[0]}:{enum:rows.map(r=>r[0])};
  const messageDomain=ranges?{minimum:1,maximum:messages.length}:{enum:messageIds};
  const worst=JSON.stringify({sources:rows.map(r=>({id:r[0],ids:messageIds}))});
  const max_tokens=Math.max(4096,Buffer.byteLength(worst,'utf8')+1024);
  return {model:'openai/gpt-5.6-luna',reasoning:{effort:'none',exclude:true},max_tokens,
   messages:[{role:'system',content:frozenPrompt},{role:'user',content:JSON.stringify({conversation:messages,records:rows})}],
   response_format:{type:'json_schema',json_schema:{name:'record_sources',strict:true,schema:{type:'object',properties:{sources:{type:'array',items:{type:'object',properties:{id:{type:'integer',...recordDomain},ids:{type:'array',items:{type:'integer',...messageDomain},minItems:1}},required:['id','ids'],additionalProperties:false}}},required:['sources'],additionalProperties:false}}},provider:{require_parameters:true}};
 };
 const fits=(b:Json)=>b.max_tokens<=128000 && Buffer.byteLength(JSON.stringify(b),'utf8')+8192<=922000 && Buffer.byteLength(JSON.stringify(b),'utf8')+8192+b.max_tokens<=1050000;
 const batches:Json[]=[];
 // Binary-search a fitting prefix; avoid repeatedly serializing every growing
 // prefix of thousands of records on the database worker.
 for(let offset=0;offset<records.length;){
  const outputRows=Math.max(1,Math.floor((128000-1040)/(Buffer.byteLength(JSON.stringify(messageIds))+40)));
  let low=1,high=Math.min(records.length-offset,outputRows),count=0,best:Json|undefined;
  while(low<=high){
   const mid=Math.floor((low+high)/2),body=make(records.slice(offset,offset+mid).map((text,i)=>[offset+i+1,text]));
   if(fits(body)){count=mid;best=body;low=mid+1;}else high=mid-1;
  }
  if(!best)throw new AppFailure('memory_source_input_limit');
  batches.push(best);offset+=count;
 }
 return batches;
}
export function validateSources(body:Json,content:string):SourceLink[] {
 try {
  const input=JSON.parse(body.messages[1].content),value=JSON.parse(content);
  if(!value||Object.keys(value).join()!=='sources'||!Array.isArray(value.sources)||value.sources.length!==input.records.length)throw Error();
  const wanted=new Set(input.records.map((r:any)=>r[0])),messages=new Set(input.conversation.map((m:any)=>m[0]));
  const result:SourceLink[]=value.sources.map((r:any)=>{
   if(!r||Object.keys(r).sort().join()!=='id,ids'||!Number.isInteger(r.id)||!wanted.delete(r.id)||!Array.isArray(r.ids)||!r.ids.length||r.ids.some((id:unknown)=>!Number.isInteger(id)||!messages.has(id)))throw Error();
   return {id:r.id,ids:[...new Set<number>(r.ids)].sort((a,b)=>a-b)};
  });
  return result.sort((a,b)=>a.id-b.id);
 }catch{throw new AppFailure('memory_source_format');}
}
/** Return zero-based original record indexes; identity never depends on sort order. */
export function sourceAnchor(conversation:Json[],source:SourceLink):number {
 const users=source.ids.filter(id=>conversation[id-1]?.role==='user');
 return Math.max(...(users.length?users:source.ids));
}
export function sourceOrder(conversation:Json[],sources:SourceLink[]):number[] {
 return [...sources].sort((a,b)=>sourceAnchor(conversation,a)-sourceAnchor(conversation,b)||a.id-b.id).map(s=>s.id-1);
}
