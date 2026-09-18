import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/main/database';
import {expressionBody,expressionCharacters,expressionContract,expressionLimit,validateExpressions} from '../src/main/expression-report';
import {PatternReportController} from '../src/main/pattern-report-controller';
import {validatePatternCommand} from '../src/main/pattern-report-ipc';
import {OpenRouter} from '../src/main/transport';
import type {PatternSelection,PatternSource} from '../src/shared/pattern-report';
let dir:string,store:Store;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'expression-report-'));store=new Store(dir,'isolated');});
afterEach(()=>{store.close();rmSync(dir,{recursive:true,force:true});vi.unstubAllGlobals();});
const range=(reportType:'grammar'|'expression'='expression',excludeCovered=false):PatternSelection=>({from:'2020-01-01T00:00:00Z',to:'2030-01-01T00:00:00Z',timezone:'UTC',reportType,excludeCovered});
function seed(n=1){const ids:string[]=[];for(let i=0;i<n;i++){const s=store.createSession();store.submit(s.id,'I started in May. I still work on it.');(store as any).db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES(?,?,1,'assistant','Tell me more.','model','complete')").run(randomUUID(),s.id);store.end(s.id);ids.push(s.id);}return ids;}
function create(selection=range()){return store.patternCreate(store.patternPreview(undefined,selection).fingerprint,randomUUID(),undefined,selection);}
function replaceMessage(id:string, content:string) {
 const db=(store as any).db;
 db.transaction(()=>{
  const triggers=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name IN ('immutable_final_message','frozen_message_update')").all() as {sql:string}[];
  db.exec('DROP TRIGGER immutable_final_message; DROP TRIGGER frozen_message_update');
  db.prepare('UPDATE messages SET content=? WHERE id=?').run(content,id);
  for(const t of triggers)db.exec(t.sql);
 })();
}
const suggestion=(ids:string[],expression='have been + -ing')=>({expression,explanation:'Connect the start and continuation.',example:'I have been working on it since May.',evidence_ids:ids});
it('assembles lossless full context, selected prompt/schema, Astra low and admits one conversation',()=>{
 seed();const p=store.patternPreview(undefined,range());expect(p.blocked).toBeNull();expect(store.patternPreview(undefined,range('grammar')).blocked).toBe('insufficient');
 const r=create(),detail=store.patternDetail(r.id),a=store.patternDispatch(r.attemptId!),body=JSON.parse(a.request);
 expect(body.messages[0].content).toBe(readFileSync('src/main/expression-prompt-v1.txt','utf8'));
 expect(body.response_format).toEqual(JSON.parse(readFileSync('src/main/expression-format-v1.json','utf8')));
 expect(body.reasoning).toEqual({effort:'low',exclude:true});expect(body.max_tokens).toBe(128000);
 expect(body.messages[1].content).toContain('ASSISTANT:');expect(body.messages[1].content).toContain('USER:');
 for(const m of detail.sources[0].messages!)expect(body.messages[1].content).toContain(`${m.id} ${m.role.toUpperCase()}: ${JSON.stringify(m.content)}`);
 expect(p.scope.characters).toBe(expressionCharacters(body));expect(p.scope.characterLimit).toBe(2000000);
});
it('checks exact inclusive Unicode length with request framing and never drops a selected session',()=>{
 seed();const db=(store as any).db;const user=store.messages(store.sessions()[0].id).find(m=>m.role==='user')!;
 replaceMessage(user.id,'');
 const base=store.patternPreview(undefined,range()).scope.characters!;
 replaceMessage(user.id,'😀'.repeat(expressionLimit-base));
 const edge=store.patternPreview(undefined,range());expect(edge.scope.characters).toBe(expressionLimit);expect(edge.blocked).toBeNull();
 replaceMessage(user.id,'😀'.repeat(expressionLimit-base)+'a');
 const over=store.patternPreview(undefined,range());expect(over.blocked).toBe('input_limit');expect(over.scope.count).toBe(1);expect(over.scope.excluded.overBudget).toBe(0);expect(()=>create()).toThrow('pattern_input_limit');
},30000);
it('rejects wrong IDs, duplicate references, extra keys and partial output; preserves all valid items with stable frequency sorting',()=>{
 seed(3);const r=create(),sources=store.patternDetail(r.id).sources,ids=sources.map(s=>s.units[0].message_id),assistant=sources[0].messages!.find(m=>m.role==='assistant')!.id;
 const items=[suggestion([ids[0]],'first'),suggestion(ids,'all'),suggestion(ids.slice(0,2),'two'),suggestion([ids[1]],'last')];
 const raw=JSON.stringify({suggestions:items});expect(validateExpressions(raw,sources).map(s=>s.expression)).toEqual(['all','two','first','last']);
 for(const value of [{suggestions:[suggestion([assistant])]},{suggestions:[suggestion(['unknown'])]},{suggestions:[suggestion([ids[0],ids[0]])]},{suggestions:[{...suggestion(ids),category:'grammar'}]},{suggestions:[{...suggestion(ids),example:''}]},{suggestions:[],extra:true}])expect(()=>validateExpressions(JSON.stringify(value),sources)).toThrow('pattern_expression_output');
 expect(()=>validateExpressions(raw.slice(0,-2),sources)).toThrow();
 expect(()=>validateExpressions('{"suggestions":[],"suggestions":[]}',sources)).toThrow();
 store.patternDispatch(r.attemptId!);store.patternSave(r.attemptId!,raw,{usage:{cost:0.13}});
 expect(store.patternAttempt(r.attemptId!).html).toBe(raw);expect(store.patternDetail(r.id).suggestions).toHaveLength(4);expect(store.patternDetail(r.id).resultCount).toBe(4);
 expect(()=>store.patternHtml(r.id)).toThrow('pattern_not_html');
});
it('keeps successful empty results, isolates type coverage and reuses saved requests offline after restart',()=>{
 seed(5);const r=create();store.patternDispatch(r.attemptId!);store.patternSave(r.attemptId!,'{"suggestions":[]}',{});
 expect(store.patternDetail(r.id).suggestions).toEqual([]);expect(store.patternPreview(undefined,range('expression',true)).scope.count).toBe(0);
 expect(store.patternPreview(undefined,range('grammar',true)).scope.count).toBe(5);
 const grammar=create(range('grammar'));store.patternDispatch(grammar.attemptId!);store.patternSave(grammar.attemptId!,'<!DOCTYPE html><html><head></head><body>Grammar</body></html>',{});
 expect(store.patternList(0,'expression').reports.map(c=>c.id)).toEqual([r.id]);expect(store.patternList(0,'grammar').reports.map(c=>c.id)).toEqual([grammar.id]);
 store.close();store=new Store(dir,'isolated');expect(create().id).toBe(r.id);expect(store.patternDetail(r.id).suggestions).toEqual([]);
 store.patternDelete(r.id);expect(store.patternPreview(undefined,range('expression',true)).scope.count).toBe(5);expect(store.patternPreview(undefined,range('grammar',true)).scope.count).toBe(0);
});
it('retains retry bytes and complete source context, detects context changes and preserves a saved report after deletion',()=>{
 const [id]=seed();const r=create();store.patternDispatch(r.attemptId!);store.patternFinish(r.attemptId!,'failed','request_timeout',null,{});
 const retry=store.patternRetry(r.id,randomUUID());expect(retry.request).toBe(store.patternAttempt(r.attemptId!).request);store.patternFinish(retry.id,'cancelled','request_cancelled',null,{});
 const assistant=store.messages(id).find(m=>m.role==='assistant')!;replaceMessage(assistant.id,'Changed context');
 expect(store.patternDetail(r.id).canRetry).toBe(false);expect(()=>store.patternRetry(r.id,randomUUID())).toThrow('pattern_source_changed');
 const next=create();store.patternDispatch(next.attemptId!);store.patternSave(next.attemptId!,'{"suggestions":[]}',{});store.deleteSession(id);
 expect(store.patternDetail(next.id).sources[0].deleted).toBe(true);expect(store.patternDetail(next.id).suggestions).toEqual([]);
});
it('controller persists unpinned provider request and validates JSON through real transport, without an HTML viewer',async()=>{
 seed();const fetch=vi.fn(async()=>new Response(JSON.stringify({id:'fixture',model:'openai/gpt-6-astra',provider:'OpenAI',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'{"suggestions":[]}'}}],usage:{cost:0.01}})));vi.stubGlobal('fetch',fetch);
 const call=async(method:string,...args:any[])=>(store as any)[method](...args), open=vi.fn();
 const controller=new PatternReportController({call} as any,new OpenRouter(()=>'synthetic'),{write:call,publish:()=>{},open,closeViewer:()=>{},retrySave:async()=>{}} as any);
 try{const p=store.patternPreview(undefined,range());const r=await controller.command('patternCreate',{fingerprint:p.fingerprint,selection:range(),operationId:randomUUID()});
 await vi.waitFor(()=>expect(store.patternDetail(r.id).status).toBe('succeeded'));
 const body=JSON.parse((fetch.mock.calls as any)[0][1].body);expect(body.provider).toEqual({allow_fallbacks:true,data_collection:'deny',require_parameters:true});expect(body.response_format.json_schema.strict).toBe(true);
 expect((store as any).db.prepare('SELECT provider_request FROM pattern_report_attempts WHERE report_id=?').get(r.id).provider_request).toBeTruthy();expect(open).not.toHaveBeenCalled();
 }finally{await controller.close();}
});
it('rejects malformed IPC types and keeps exact contract unchanged',()=>{
 validatePatternCommand('patternPreview',range());validatePatternCommand('patternList',{offset:0,reportType:'expression'});
 expect(()=>validatePatternCommand('patternPreview',{...range(),reportType:'other'})).toThrow('invalid_command');
 expect(()=>validatePatternCommand('patternList',{offset:0,reportType:'other'})).toThrow('invalid_command');
 expect(expressionContract.timeout_ms).toBe(3600000);expect(expressionBody([]).messages).toHaveLength(2);
});
