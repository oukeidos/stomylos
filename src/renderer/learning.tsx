import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { PatternDetail, PatternPreview, PatternState, PatternCard, PatternSelection, ReportType } from '../shared/pattern-report';

const idle: PatternState = { revision: 0, reportId: null, phase: 'idle', startedAt: null, error: null };
export function usePatternState() {
  const [state, setState] = useState(idle);
  useEffect(() => {
    const apply = (s: PatternState) => setState(old => s.revision >= old.revision ? s : old);
    const off = window.stomylos.subscribe(e => { if (e.type === 'pattern') apply(e.snapshot); });
    void window.stomylos.command('patternState', undefined).then(apply).catch(() => undefined);
    return off;
  }, []);
  return state;
}
const countLabel = (n:number, word:string) => `${n} ${word}${n===1?'':'s'}`;
const label = (type?: ReportType) => type === 'expression' ? 'Expression suggestions' : 'Grammar patterns';
const date = (text: string | null) => text ? new Date(text).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' }) : '—';
const range = (card: PatternCard) => `${date(card.scope.selection?.from ?? card.scope.from)} – ${date(card.scope.selection ? new Date(Date.parse(card.scope.selection.to)-1).toISOString() : card.scope.to)}`;
function message(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  const messages: Record<string,string> = {
    pattern_scope_changed:'Available conversations changed. Review the updated scope before creating the report.',
    pattern_insufficient:'Choose a period with more completed conversations.',
    pattern_input_limit:'This selection is too long. Choose a shorter period.',
    pattern_busy:'A report is already being created.', pattern_not_retryable:'This report cannot be retried.',
    pattern_source_deleted:'A source conversation was deleted. Create a new report from available conversations.',
    pattern_source_changed:'Source messages changed. Create a new report from the current conversations.',
    pattern_expression_output:'The model returned incomplete or invalid suggestions. Retry generation.',
    pattern_output:'The model did not return a complete HTML report.', pattern_output_limit:'The returned report exceeded the size limit.',
    request_timeout:'Report generation timed out.', request_cancelled:'Generation was cancelled.',
    api_key_missing:'Add your API key in Settings to create a report.', save_required:'Finish saving before continuing.',
    pattern_not_ready:'This report is not ready to open.', pattern_closed:'The application is closing.',
    interrupted_unknown_outcome:'Generation was interrupted. Its remote outcome and cost may be unknown.',
    queued_not_dispatched:'This request was saved but not sent.', cancelled:'Generation was cancelled.'
  };
  return messages[code] ?? `The report action could not finish (${code}).`;
}
export function Learning({active,revision,state,disabled,keyPresent,source,requestedReport,handledReport}: {
  active:boolean; revision:number; state:PatternState; disabled:boolean; keyPresent:boolean;
  source(id:string,messageId?:string):Promise<void>; requestedReport:string|null; handledReport():void;
}) {
  const [sidebar,setSidebar]=useState<HTMLElement|null>(null);
  useEffect(()=>setSidebar(document.getElementById('report-history')),[]);
  const [filter,setFilter]=useState<ReportType|'all'>('all'), [type,setType]=useState<ReportType>('expression');
  const [cards,setCards]=useState<PatternCard[]>([]), [offset,setOffset]=useState(0), [more,setMore]=useState(false);
  const [newReport,setNewReport]=useState(false), [selected,setSelected]=useState<string|null>(null), [detail,setDetail]=useState<PatternDetail|null>(null);
  const [preview,setPreview]=useState<PatternPreview|null>(null), [weeks,setWeeks]=useState('1'), [from,setFrom]=useState(''), [to,setTo]=useState(''), [exclude,setExclude]=useState(false);
  const [error,setError]=useState<string|null>(null), [busy,setBusy]=useState(false), [loading,setLoading]=useState(false), [removing,setRemoving]=useState(false);
  const [open,setOpen]=useState(0), [evidence,setEvidence]=useState(false), [context,setContext]=useState<string|null>(null), [info,setInfo]=useState(false);
  const [tick,setTick]=useState(Date.now()), [refresh,setRefresh]=useState(0);
  const operation=useRef(false), selectionEpoch=useRef(0), navigation=useRef({selected,newReport});
  navigation.current={selected,newReport};
  const choose=useCallback((id:string)=>{setRefresh(n=>n+1);setSelected(id);setDetail(null);setNewReport(false);setOpen(0);setEvidence(false);setContext(null);setInfo(false);setError(null);},[]);
  useEffect(()=>{if(active&&requestedReport){choose(requestedReport);handledReport();}},[active,requestedReport,choose,handledReport]);
  useEffect(()=>{
    if(!active)return;let current=true;setLoading(true);
    void window.stomylos.command('patternList',{offset,...(filter==='all'?{}:{reportType:filter})}).then(r=>{
      if(!current)return;setCards(r.reports);setMore(r.hasMore);
      if(!navigation.current.selected&&!navigation.current.newReport&&r.reports[0])choose(r.reports[0].id);
    }).catch(e=>{if(current)setError(message(e));}).finally(()=>{if(current)setLoading(false);});
    return()=>{current=false;};
  },[active,revision,state.revision,offset,filter,refresh,choose]);
  useEffect(()=>{
    if(!active||!selected||newReport)return;let current=true;
    void window.stomylos.command('patternDetail',{id:selected}).then(d=>{if(current)setDetail(d);}).catch(e=>{if(current)setError(message(e));});
    return()=>{current=false;};
  },[active,selected,newReport,revision,state.revision,refresh]);
  useEffect(()=>{
    const epoch=++selectionEpoch.current;setPreview(null);
    if(!active||!newReport)return;
    const end=new Date(),start=new Date(end.getTime()-Number(weeks==='custom'?1:weeks)*7*86400_000);
    if(weeks==='custom'){
      if(!from||!to)return;
      const a=new Date(from+'T00:00:00'),b=new Date(to+'T00:00:00');b.setDate(b.getDate()+1);
      if(!Number.isFinite(a.getTime())||!Number.isFinite(b.getTime())||a>=b){setError('Choose a valid date range.');return;}
      start.setTime(a.getTime());end.setTime(b.getTime());
    }
    const selection:PatternSelection={from:start.toISOString(),to:end.toISOString(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,excludeCovered:exclude,reportType:type};
    void window.stomylos.command('patternPreview',selection).then(p=>{if(epoch===selectionEpoch.current)setPreview(p);}).catch(e=>{if(epoch===selectionEpoch.current)setError(message(e));});
    return()=>{selectionEpoch.current++;};
  },[active,newReport,weeks,from,to,exclude,type,revision,state.revision,refresh]);
  useEffect(()=>{if(state.phase==='idle')return;const timer=setInterval(()=>setTick(Date.now()),1000);return()=>clearInterval(timer);},[state.phase]);
  const act=async(fn:()=>Promise<unknown>)=>{if(operation.current)return;operation.current=true;setBusy(true);setError(null);try{await fn();}catch(e){setError(message(e));}finally{operation.current=false;setBusy(false);setRefresh(n=>n+1);}};
  const changeScope=(fn:()=>void)=>{setPreview(null);setError(null);fn();};
  const startNew=()=>{setType(filter==='grammar'?'grammar':'expression');setNewReport(true);setError(null);};
  const generating=state.phase!=='idle', elapsed=state.startedAt?Math.max(0,Math.floor((tick-Date.parse(state.startedAt))/1000)):0;
  const nav=<div className="reports-library">
    <h2>Reports</h2><button className="primary report-new" onClick={startNew}>+ New report</button>
    <label className="report-filter">Report type<select aria-label="Filter report type" value={filter} onChange={e=>{setFilter(e.target.value as typeof filter);setOffset(0);}}><option value="all">All reports</option><option value="grammar">Grammar patterns</option><option value="expression">Expression suggestions</option></select></label>
    <nav aria-label="Report history" aria-busy={loading}>{cards.map(c=><button key={c.id} className="report-history-item" aria-current={!newReport&&c.id===selected?'page':undefined} onClick={()=>choose(c.id)}>
      <span className="report-kind">{label(c.reportType)}</span><span>{range(c)}</span><small>{countLabel(c.scope.count,'conversation')}{c.resultCount!==undefined?` · ${countLabel(c.resultCount,'suggestion')}`:''}</small>
      {c.status!=='succeeded'&&<small>{c.status==='dispatched'?'Generating…':c.status==='queued'?'Waiting':c.status}</small>}
    </button>)}</nav>
    {!cards.length&&!loading&&<p className="note">No saved reports yet.</p>}
    {(more||offset>0)&&<div className="report-pages"><button disabled={!offset||loading} onClick={()=>setOffset(n=>Math.max(0,n-20))}>Newer</button><button disabled={!more||loading} onClick={()=>setOffset(n=>n+20)}>Older</button></div>}
  </div>;
  const progress=generating&&<section className="learning-progress" role="status"><strong>{state.phase==='saving'?'Saving your report…':'Creating your report…'}</strong><p>{elapsed}s elapsed · You can keep chatting while it runs.</p>
    {state.phase==='generating'&&<button disabled={busy} onClick={()=>void act(()=>window.stomylos.command('patternCancel',{id:state.reportId!}))}>Cancel generation</button>}
    {disabled&&<button disabled={busy} onClick={()=>void act(()=>window.stomylos.command('patternRetrySave',undefined))}>Retry saving</button>}
  </section>;
  return <>{sidebar&&createPortal(nav,sidebar)}<section className="learning reports-main" hidden={!active} aria-label="Reports"><div className="learning-page">
    {disabled&&<p className="notice" role="status">Report changes are temporarily unavailable.<button disabled={busy} onClick={()=>void act(()=>window.stomylos.command('patternRetrySave',undefined))}>Retry saving</button></p>}
    {error&&<p role="alert" className="notice danger">{error}<button onClick={()=>{setError(null);setRefresh(n=>n+1);}}>Reload</button></p>}
    {newReport?<>
      <div className="report-heading"><h1>New report</h1></div>
      <section className="learning-scope" aria-label="Report scope">
        <fieldset className="report-field"><legend>Report type</legend><div className="report-types">{(['grammar','expression'] as const).map(t=><button key={t} aria-pressed={type===t} onClick={()=>{if(type!==t)changeScope(()=>setType(t));}}>{label(t)}</button>)}</div>
        <p className="note">{type==='expression'?'Find useful ways to express your meaning.':'Review recurring grammar errors.'}</p></fieldset>
        <fieldset className="report-field"><legend>Time period</legend>
        <div className="report-weeks">{[1,2,3,4].map(n=><button key={n} aria-pressed={weeks===String(n)} onClick={()=>{if(weeks!==String(n))changeScope(()=>setWeeks(String(n)));}}>{n} {n===1?'week':'weeks'}</button>)}<button aria-pressed={weeks==='custom'} onClick={()=>{if(weeks!=='custom')changeScope(()=>setWeeks('custom'));}}>Custom dates</button></div>
        {weeks==='custom'&&<div className="report-dates"><label>From<input type="date" value={from} onChange={e=>changeScope(()=>setFrom(e.target.value))}/></label><label>Through<input type="date" value={to} onChange={e=>changeScope(()=>setTo(e.target.value))}/></label></div>}
        <label className="check"><input type="checkbox" checked={exclude} onChange={e=>changeScope(()=>setExclude(e.target.checked))}/>Exclude conversations used in this report type</label></fieldset>
        {preview?<>
          <section className="report-preview" aria-label="Selected conversations"><div className="report-summary"><p className="scope-number">{countLabel(preview.scope.count,'conversation')}</p><span className="note">{countLabel(preview.scope.records,'message')}</span></div>
          <p className="note">{date(preview.scope.from)} – {date(preview.scope.to)}</p>
          <p className="note">{preview.scope.inputCost===undefined?'Input cost unavailable':`Estimated input cost ≈ $${preview.scope.inputCost.toFixed(4)}`} · output additional</p>
          {preview.scope.longContext&&<p className="note">Long-context pricing expected</p>}
          {preview.blocked&&<p role="status">{preview.blocked==='input_limit'?'This selection is too long. Choose a shorter period.':type==='expression'?'Choose a period with at least one ended conversation containing your messages.':'At least five ended conversations are needed.'}</p>}
          <details><summary>Scope details</summary>
            <p className="note">{type==='expression'?`${preview.scope.characters?.toLocaleString()} / ${preview.scope.characterLimit?.toLocaleString()} characters (Unicode code points).`:`Approximately ${preview.scope.estimate.toLocaleString()} / ${preview.scope.limit.toLocaleString()} input tokens.`}</p>
            <p className="note">{type==='expression'?'Original user messages and assistant context from ended conversations. Assistant messages are not evidence.':'Original learner messages from ended conversations. Individual grammar analysis is not required.'}</p>
            <p className="note">Weeks count back from now. Custom dates include both dates in your local timezone. No conversations are removed automatically. Exclusion counts successful reports of this type.</p>
          </details>
          </section>
        </>:<p role="status">{weeks==='custom'&&(!from||!to)?'Choose a start and end date.':error?'Scope preview unavailable. Resolve the error above to continue.':'Checking selected conversations…'}</p>}
        <div className="learning-actions report-submit"><button className="primary" disabled={!preview||busy||disabled||!!preview.blocked||generating||(!keyPresent&&!preview.existingId)} onClick={()=>{if(!preview)return;void act(async()=>{
            if(preview.existingId){choose(preview.existingId);return;}
            const r=await window.stomylos.command('patternCreate',{fingerprint:preview.fingerprint,operationId:crypto.randomUUID(),selection:preview.scope.selection});setOffset(0);choose(r.id);
          });}}>{preview?.existingId?'Open existing report':'Create report'}</button><button onClick={()=>setNewReport(false)}>Cancel</button></div>
          {!keyPresent&&!preview?.existingId&&<p className="note">Add an API key in Settings to generate a report. Saved reports work offline.</p>}
      </section>{progress}
    </>:detail?<>
      <div className="report-heading"><div><h1>{label(detail.reportType)}</h1><p className="report-date">{range(detail)}</p><p className="note">{countLabel(detail.scope.count,'conversation')}{detail.resultCount!==undefined?` · ${countLabel(detail.resultCount,'suggestion')}`:''}</p></div><button aria-expanded={info} onClick={()=>setInfo(v=>!v)}>Details</button></div>
      {info&&<section className="report-metadata" aria-label="Report details">
        <dl><dt>Created</dt><dd>{new Date(detail.created_at).toLocaleString()}</dd><dt>Generation cost</dt><dd>{typeof detail.cost==='number'?`$${detail.cost.toFixed(4)}`:'Unavailable'}</dd><dt>Model</dt><dd>{detail.model} · {detail.reasoning??'medium'}</dd></dl>
        {detail.reportType==='expression'&&<p className="note">Counts refer to matching messages, not separate events.</p>}
        <details><summary>Generation attempts</summary>{detail.attempts.map(a=>{const m=JSON.parse(a.metadata);return <p className="note" key={a.id}>{a.status} · {typeof m.usage?.cost==='number'?`$${m.usage.cost.toFixed(4)}`:'Cost unavailable'}{a.failure?` · ${message(a.failure)}`:''}</p>;})}</details>
        <button className="quiet report-delete" disabled={busy||disabled||generating} onClick={()=>setRemoving(true)}>Delete report</button>
      </section>}
      {state.reportId===detail.id&&progress}
      {detail.selected_attempt_id?(detail.reportType==='expression'?<>
        {detail.suggestions?.length?<><p className="expression-sort">Most matching messages first</p><div className="expression-list">{detail.suggestions.map((item,i)=><article className="expression-item" key={i}>
          <button className="expression-toggle" aria-expanded={open===i} onClick={()=>{setOpen(open===i?-1:i);setEvidence(false);setContext(null);}}><span className="expression-number">{i+1}</span><span>{item.expression}</span><small>{item.evidence_ids.length} {item.evidence_ids.length===1?'message':'messages'}</small><span aria-hidden="true">{open===i?'−':'+'}</span></button>
          {open===i&&<div className="expression-content"><p>{item.explanation}</p><div className="expression-example"><small>Example</small><p>{item.example}</p></div>
            <button className="quiet" aria-expanded={evidence} onClick={()=>setEvidence(v=>!v)}>{evidence?'Hide your messages':`View your messages (${item.evidence_ids.length})`}</button>
            {evidence&&item.evidence_ids.map(id=>{const s=detail.sources.find(s=>s.units.some(u=>u.message_id===id))!;const u=s.units.find(u=>u.message_id===id)!;const index=s.messages?.findIndex(m=>m.id===id)??-1;const previous=index>0?s.messages?.[index-1]:undefined;return <section className="expression-evidence" key={id}><div className="expression-evidence-heading"><span>{date(s.ended_at)} · {s.title||'Conversation'}</span><span>You</span></div><p>{u.original}</p><div className="learning-actions">
              {previous?.role==='assistant'&&<button className="quiet" aria-expanded={context===id} onClick={()=>setContext(context===id?null:id)}>{context===id?'Hide context':'Show context'}</button>}
              {!s.deleted?<button className="quiet" onClick={()=>void act(()=>source(s.session_id,id))}>Open conversation ↗</button>:<span className="note">Original conversation deleted</span>}
            </div>{context===id&&previous?.role==='assistant'&&<div className="expression-context"><small>Assistant · before your message</small><p>{previous.content}</p></div>}</section>;})}
          </div>}
        </article>)}</div></>:<div className="report-empty"><h2>No useful suggestions in this report</h2><p>This report is saved. You can try another time period.</p><button onClick={startNew}>New report</button></div>}
      </>:<><section className="grammar-report-ready" aria-label="Saved grammar report"><p>Review recurring grammar errors in your saved report.</p><button className="primary" onClick={()=>void act(()=>window.stomylos.command('patternOpen',{id:detail.id}))}>Open report</button></section>
        <details className="report-sources"><summary>Source conversations <span className="note">({detail.sources.length})</span></summary><div className="report-source-list">{detail.sources.map(s=><div className="report-source-row" key={s.session_id}><div><p>{date(s.ended_at)}</p><p className="note">{countLabel(s.units.length,'message')}{s.deleted?' · Original conversation deleted':''}</p></div>{!s.deleted&&<button className="quiet" onClick={()=>void act(()=>source(s.session_id))}>Open conversation</button>}</div>)}</div></details></>)
      :!generating&&<div className="report-empty"><h2>{detail.status==='queued'?'Report is waiting':'Report couldn’t finish'}</h2><p>{message(detail.failure??detail.status)}</p>{detail.canRetry&&<><p className="note">Retry uses the saved selection. An interrupted request may already have incurred a charge.</p><button className="primary" disabled={busy||disabled||!keyPresent} onClick={()=>void act(()=>window.stomylos.command('patternRetry',{id:detail.id,operationId:crypto.randomUUID()}))}>Retry generation</button></>}{detail.sources.some(s=>s.deleted)&&<p>A source was deleted. Create a new report instead.</p>}</div>}
    </>:<>{progress}<div className="report-empty"><h1>Reports</h1><p>{selected?'Loading report…':'Select a report or create one from your conversations.'}</p><button className="primary" onClick={startNew}>New report</button></div></>}
  </div></section>
  <Dialog.Root open={removing} onOpenChange={v=>{if(!busy)setRemoving(v);}}><Dialog.Portal><Dialog.Overlay className="modal-overlay"/><Dialog.Content className="dialog" aria-describedby={undefined}><Dialog.Title>Delete this report?</Dialog.Title><p>The saved report, evidence copy and attempts will be removed. Your conversations remain.</p><div className="dialog-actions"><button disabled={busy} onClick={()=>setRemoving(false)}>Cancel</button><button disabled={busy||disabled} onClick={()=>void act(async()=>{if(!detail)return;await window.stomylos.command('patternDelete',{id:detail.id});setRemoving(false);setDetail(null);setSelected(null);setOffset(0);})}>Delete report</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
