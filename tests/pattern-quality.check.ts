// Historical preparation/replay only; no provider call is made by this check.
import { expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { patternBody, patternContract, patternHash, selectPatternScope, validatePatternHtml } from '../src/main/pattern-report';
import { OpenRouter } from '../src/main/transport';
import { at, session, patternQualityCases } from './pattern-quality-fixtures';
if (!process.env.STOMYLOS_PATTERN_QUALITY_DIR && process.env.STOMYLOS_PATTERN_QUALITY_RESULTS !== '1')
  throw new Error('Supply STOMYLOS_PATTERN_QUALITY_DIR for isolated preparation or STOMYLOS_PATTERN_QUALITY_RESULTS=1 for the existing local replay.');
it.runIf(Boolean(process.env.STOMYLOS_PATTERN_QUALITY_DIR))('exports the historical comparison and synthetic requests', () => {
  const directory = process.env.STOMYLOS_PATTERN_QUALITY_DIR;
  const rows = patternQualityCases();
  const old=JSON.parse(readFileSync('../experiments/EXP-019-interactive-pattern-reports/cases.json','utf8')).cases;
  const impact=old.map((c:any)=>{
    const sources=c.input.sessions.map((s:any,i:number)=>({...session(s.session_id,s.units.map((u:any)=>[u.text,u.corrected_text,u.explanation]),i),ended_at:new Date(s.ended_at).toISOString()}));
    const selected=selectPatternScope(sources,at);
    return {case:c.id,available:sources.length,included:selected.sources.length,estimate:selected.preview.scope.estimate,excluded:selected.preview.scope.excluded,blocked:selected.preview.blocked};
  });
  if(directory) {
    if(!directory.startsWith('/tmp/') && directory!=='test-results/pattern-quality')throw new Error('Isolated artifact output required');
    mkdirSync(join(directory,'requests'),{recursive:true});
    const manifest={status:'prepared_not_executed',liveCalls:0,contract:patternContract,asOf:at,estimator:'utf8-request-plus-1024-v1',originalFixtureAdmission:impact,
      cases:rows.map(row=>{const request=JSON.stringify(patternBody(row.sources));writeFileSync(join(directory,'requests',row.id+'.json'),request);return {id:row.id,expectation:row.expectation,scope:row.preview.scope,sources:row.sources,request_sha256:patternHash(request)};})};
    writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest,null,2));
  }
});


it.runIf(process.env.STOMYLOS_PATTERN_QUALITY_RESULTS === '1')('accepts the three paid outputs through production transport and HTML validation without network calls',async()=>{
  const directory='test-results/pattern-quality';
  const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
  const ledger=JSON.parse(readFileSync(join(directory,'ledger.json'),'utf8'));
  expect(ledger.attempts).toHaveLength(3);
  try {
    for(const c of manifest.cases){
      const row=ledger.attempts.find((a:any)=>a.id===c.id);expect(row.status).toBe('complete');
      const request=readFileSync(join(directory,'requests',c.id+'.json'),'utf8');
      expect(patternHash(request)).toBe(c.request_sha256);
      expect(request).toBe(JSON.stringify(patternBody(c.sources)));
      const response=readFileSync(join(directory,'responses',c.id+'.json'),'utf8');
      const saved=readFileSync(join(directory,'reports',c.id+'.html'),'utf8');
      const fetch=vi.fn(async()=>new Response(response,{headers:{'Content-Type':'application/json'}}));vi.stubGlobal('fetch',fetch);
      const result=await new OpenRouter(()=> 'public-mock-key').complete(JSON.parse(request),patternContract.identity,new AbortController().signal,1000);
      expect(result.content).toBe(saved);expect(validatePatternHtml(result.content)).toBe(saved);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  } finally {vi.unstubAllGlobals();}
});
