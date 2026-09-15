// Test-only candidate projection. Does not change application admission or contracts.
import { it, expect } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { config, conversationSnapshot, conversationRequestSnapshot, conversationBody, grammarSnapshot, grammarBody, validateGrammar, hash, budget } from '../src/main/contracts';
import { timed } from './time-fixtures';
import { renderCold, validateRecall } from '../src/main/memory-recall';
import { renderAssociative } from '../src/main/associative-recall';
import { replyContext } from '../src/main/reply-context';
import { genieBody, genieRange, parseGenie } from '../src/main/genie';
import { sessionMemoryAddBody, validateSessionMemorySize } from '../src/main/memory-add';
import { recentDialogue } from '../src/main/partner-router';
import { searchInput, searchRouterBody, searchSnapshot, withSearch } from '../src/main/search-contract';
import { prepareProviderRequest } from '../src/main/provider-policy';
import type { Json, Message } from '../src/shared/types';
const out='test-results/conversation-limits'; mkdirSync(out,{recursive:true});
const bytes=(s:string)=>Buffer.byteLength(s); const wire=(m:Message[])=>m.map(({role,content})=>({role,content}));
const msg=(content:string,role:'user'|'assistant',i:number):Message=>({id:'m'+i,session_id:'synthetic',sequence:i,role,origin:role==='user'?'learner':'model',content,delivery:'complete',request_id:null});
function fill(prefix:string,n:number) { const phrase=' I enjoy quiet walks and observing the trees near the library.'; expect(bytes(prefix)).toBeLessThanOrEqual(n); return prefix+phrase.repeat(Math.ceil((n-bytes(prefix))/phrase.length)).slice(0,n-bytes(prefix)); }
function history(n:number,finishUser=true):Message[] {
 const result:Message[]=[]; const assistants=finishUser?n-1:n;
 for(let i=0;i<n;i++) {
  const userSize=Math.floor(48000/n)+(i<48000%n?1:0);
  const prefix=i===0?'I keep a blue notebook. ':i===Math.floor(n/2)?'Correction: my notebook is green, not blue. ':i===n-1?'What color is my notebook now? Answer briefly. ':`Today I walked near the library. `;
  result.push(msg(fill(prefix,userSize),'user',result.length));
  if(i<assistants) result.push(msg(fill('That sounds peaceful. ',Math.floor(112000/assistants)+(i<112000%assistants?1:0)),'assistant',result.length));
 }
 return result;
}
function admitted(messages:Message[],next:string) {
 if(next==='/end')return true;
 const users=messages.filter(m=>m.origin==='learner');
 return users.length<512 && bytes(next)<=6000 && users.reduce((n,m)=>n+bytes(m.content),bytes(next))<=48000 && messages.reduce((n,m)=>n+bytes(m.content),bytes(next))<=160000;
}
function recent(m:Message[]) {
 const pairs:Message[][]=[]; let opening:Message|undefined;
 for(let i=0;i<m.length;i++) { if(m[i].origin==='starter'&&m[i].delivery==='complete')opening=m[i];
  if(m[i].origin==='learner'&&m[i].delivery==='complete'&&m[i+1]?.role==='assistant'&&m[i+1].delivery==='complete')pairs.push([m[i],m[++i]]); }
 const selected=pairs.slice(-3); while(selected.length>1&&bytes(JSON.stringify(wire(selected.flat())))>24000)selected.shift();
 const chosen=selected.length?selected.flat():opening?[opening]:[];
 if(bytes(JSON.stringify(wire(chosen)))>24000)throw Error('candidate_hyphantes_capacity');return wire(chosen);
}
function snapshot(m:Message[],kind:'user'|'starter'='user',lighter=false) {
 const s=conversationRequestSnapshot(conversationSnapshot(kind)); s.reply_context=replyContext(lighter?'one_point':'standard');
 s.memory_context={character_id:'shared',revision:1,database_records:[{id:'hot',text:fill('The user enjoys walking. ',2998)}]};
 const cold:any={id:'cold',text:'',text_hash:'',observed_at:null,edited_at:null,time_basis:'unknown'};
 cold.text=fill('The user reads novels. ',2000-Array.from(renderCold([cold])).length);cold.text_hash=hash(cold.text);
 s.cold_recollections={policy:'cold_session_recall_v1',prng:'sfc32_v1',seed:'a'.repeat(32),revision:1,generation:null,space:null,items:[cold],block:renderCold([cold]),reason:'selected'};validateRecall(s.cold_recollections);
 const assoc:any={id:'recall',text:'',text_hash:'',source_order:1};assoc.text=fill('The user likes libraries. ',1500-Array.from(renderAssociative([assoc])).length);assoc.text_hash=hash(assoc.text);
 s.associative_recall={version:'stomylos_associative_recall_v1',query_ids:['q'],source_revision:1,threshold:0.78,items:[assoc],block:renderAssociative([assoc]),reason:'selected'};
 return timed(s,m);
}
const dense=history(512), long=history(8), measurements:any[]=[];
it('candidate UTF-8/count boundaries and End escape are exact; production is unchanged',()=>{
 for(const prefix of ['', '한글😀\n"\\'])for(const n of [5999,6000,6001])expect(admitted([],prefix+'x'.repeat(n-bytes(prefix)))).toBe(n<=6000);
 for(const n of [47999,48000,48001])expect(admitted([msg('x'.repeat(n-1),'user',0)],'x')).toBe(n<=48000);
 for(const n of [159999,160000,160001])expect(admitted([msg('x'.repeat(n-1),'assistant',0)],'x')).toBe(n<=160000);
 for(const n of [511,512,513])expect(admitted(Array.from({length:n},(_,i)=>msg('x','user',i)),'x')).toBe(n<512);
 expect(admitted(dense,'/end')).toBe(true);expect(budget(dense).allowed).toBe(false);
});
it('real current conversation builders preserve near-cap histories with maximum context',()=>{
 for(const source of [dense,long])for(const kind of ['user','starter'] as const)for(const lighter of [false,true]) {
  const m=structuredClone(source);let question:string|null=null;
  if(kind==='starter') { question='What did you enjoy today?';m[1].content=m[1].content.slice(question.length);m.unshift({...msg(question,'assistant',-1),origin:'starter'}); }
  const body=conversationBody(snapshot(m,kind,lighter),'model_07',question,m);
  expect(m.reduce((n,x)=>n+bytes(x.content),0)).toBe(160000);
  expect(body.messages.at(-1).content).toContain(m.at(-1)!.content);
  expect(body.messages.length).toBe(m.length+1+(kind==='starter'?1:0)+(lighter?4:0));
  measurements.push({turns:source.filter(x=>x.role==='user').length,kind,lighter,request_bytes:bytes(JSON.stringify(body)),messages:body.messages.length,system_bytes:bytes(body.messages[0].content),content_bytes:body.messages.reduce((n:number,x:any)=>n+bytes(x.content),0)});
 }
});
it('candidate Hyphantes window excludes old history, preserves whole pairs and rejects oversized last pair',()=>{
 const complete=history(512,false);expect(recent(complete)).toHaveLength(6);expect(recent(complete)).toEqual(recent(complete.slice(-6)));expect(recent([])).toEqual([]);
 const opening={...msg('Hello.','assistant',0),origin:'starter' as const};expect(recent([opening])).toEqual(wire([opening]));
 expect(recent(complete.slice(-2))).toHaveLength(2);
 const pairs=[msg('a','user',0),msg('x'.repeat(15000),'assistant',1),msg('b','user',2),msg('y'.repeat(15000),'assistant',3)];expect(recent(pairs)).toHaveLength(2);
 expect(()=>recent([msg('x'.repeat(6000),'user',0),msg('x'.repeat(20000),'assistant',1)])).toThrow('candidate_hyphantes_capacity');
});
it('grammar validates 512 indexed occurrences and large mock output while historical contract stays immutable',()=>{
 const source=dense.filter(m=>m.role==='user'),saved=grammarSnapshot(),raw=JSON.stringify(saved),body=grammarBody(saved,dense);
 expect(JSON.parse(body.messages[1].content)).toHaveLength(512);
 const units=source.map((m,index)=>({index,corrected_text:m.content,explanation:'A'.repeat(850)}));const output=JSON.stringify({units});
 expect(validateGrammar(output,dense,saved)).toHaveLength(512);expect(bytes(output)).toBeLessThan(2*1024*1024);
 expect(()=>validateGrammar(JSON.stringify({units:units.slice(1)}),dense,saved)).toThrow('grammar_source_count');
 expect(()=>grammarBody({...saved,parameters:{...saved.parameters,max_tokens:128000}},dense)).toThrow('unsupported_grammar_settings');expect(JSON.stringify(saved)).toBe(raw);
 measurements.push({mock_grammar_output_bytes:bytes(output)});
});
it('full terminal overflow is accepted by session-memory size guard and recent consumers remain bounded',()=>{
 const source=[...dense,msg('A'.repeat(64000),'assistant',dense.length)];
 const body=sessionMemoryAddBody({conversation:wire(source)});expect(()=>validateSessionMemorySize(body)).not.toThrow();
 expect(bytes(JSON.stringify(recentDialogue(dense).input))).toBeLessThan(25000);
 expect(()=>searchRouterBody(searchSnapshot(),searchInput('A'.repeat(64000),'U'.repeat(6000)),0)).not.toThrow();
 measurements.push({terminal_transcript_bytes:source.reduce((n,m)=>n+bytes(m.content),0),memory_request_bytes:bytes(JSON.stringify(body))});
});
it('writes frozen synthetic live requests using existing builders and provider preparation',()=>{
 const cases:any[]=[];const add=(id:string,body:Json,timeoutMs:number,extra:any={})=>cases.push({id,body:prepareProviderRequest(body).body,timeoutMs,...extra});
 add('seed-off',conversationBody(snapshot(dense),'model_07',null,dense),120000,{stream:true,source:wire(dense),expected:'green'});
 const searching=structuredClone(dense);const last=searching.at(-1)!;last.content=fill('Find the current stable Python release on python.org and cite the source. ',bytes(last.content));
 add('seed-search',withSearch(conversationBody(snapshot(searching),'model_07',null,searching),true),120000,{stream:true,search:true,source:wire(searching)});
 for(const [id,source] of [['grammar-long',long],['grammar-dense',dense]] as const) {
  const m=structuredClone(source);for(const user of m.filter(x=>x.role==='user'))user.content=user.content.replace('I enjoy','I likes');
  const body=grammarBody(grammarSnapshot(),m);body.max_tokens=128000;add(id,body,600000,{source:m,grammar:true});
 }
 add('session-memory',sessionMemoryAddBody({conversation:wire([...dense,msg('A'.repeat(64000),'assistant',dense.length)])}),180000,{memory:true});
 const complete=history(512,false);for(const [id,source] of [['hyphantes-short',complete.slice(-6)],['hyphantes-long',complete]] as const) {
  const s={sessionId:'synthetic',text:'I want say the walk made me less stress.',revision:1,contextHash:hash(JSON.stringify(source)),messages:recent(source)};
  add(id,genieBody(s,genieRange(s.text,{start:0,end:0,direction:'none',scope:'draft'})),120000,{genie:true});
 }
 expect(cases).toHaveLength(7);expect(cases[5].body).toEqual(cases[6].body);
 const manifest={created_at:new Date().toISOString(),revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),source_hashes:Object.fromEntries(['contracts.ts','runtime-config.json','genie.ts','memory-add.ts','provider-policy.ts'].map(f=>[f,hash(readFileSync('src/main/'+f,'utf8'))])),max_calls:7,max_usd:20,cases:cases.map(c=>({...c,body_hash:hash(JSON.stringify(c.body)),request_bytes:bytes(JSON.stringify(c.body))}))};
 writeFileSync(out+'/manifest.json',JSON.stringify(manifest,null,2));writeFileSync(out+'/offline-measurements.json',JSON.stringify(measurements,null,2));
});
