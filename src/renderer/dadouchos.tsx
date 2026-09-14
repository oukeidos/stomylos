import { useEffect, useSyncExternalStore } from 'react';
import { TooltipButton } from './tooltip-button';
import { Icon } from './icons';
import type { DadouchosSnapshot } from '../shared/dadouchos';
let snapshot: DadouchosSnapshot={revision:-1,sessionId:null,open:false,phase:'idle',text:null,error:null};
let pending=false,localError:string|null=null,errorSession:string|null=null,version=0;
const listeners=new Set<()=>void>();
const notify=()=>{version++;listeners.forEach(f=>f());};
function receive(s:DadouchosSnapshot){if(s.revision<snapshot.revision)return;snapshot=s;notify();}
window.stomylos.subscribe(e=>{if(e.type==='dadouchos')receive(e.snapshot);});
void window.stomylos.command('dadouchosSnapshot',undefined).then(receive).catch(()=>undefined);
function useDadouchos(){useSyncExternalStore(f=>{listeners.add(f);return()=>{listeners.delete(f);};},()=>version);return snapshot;}
const errorText=(code:string|null)=>code?.includes('api_key_missing')?'Add your API key in Settings.':code?.includes('input_limit')?'This conversation is too large for guidance.':code?.includes('unavailable')||code?.includes('stale')?'Wait for a complete reply before requesting guidance.':code?.includes('cancel')?'Guidance was interrupted.':code?.includes('timeout')?'Dadouchos took too long to respond.':'Could not get guidance. Please try again.';
async function run(sessionId:string,retry=false){
 if(pending)return;pending=true;localError=null;errorSession=sessionId;notify();
 try{receive(await window.stomylos.command(retry?'dadouchosRetry':'dadouchosOpen',{sessionId,operationId:crypto.randomUUID()}));}
 catch(e){localError=String(e);}finally{pending=false;notify();}
}
export function DadouchosDock({sessionId,hidden,disabled}:{sessionId:string;hidden:boolean;disabled:boolean}){
 const s=useDadouchos(),error=errorSession===sessionId?localError:null;
 useEffect(()=>()=>{void window.stomylos.command('dadouchosDispose',{sessionId}).catch(()=>undefined);localError=null;},[sessionId]);
 if(hidden || (s.sessionId!==sessionId || !s.open) && !error)return null;
 return <section className="dadouchos-dock" aria-label="Dadouchos guidance">
   <div className="dadouchos-heading"><Icon name="dadouchos"/><span>Dadouchos</span></div>
   <div role={error || s.phase==='failed'?'alert':'status'}>
     {error?<p>{errorText(error)}</p>:s.phase==='waiting'?<p>Thinking…</p>:s.phase==='ready'?<p>{s.text}</p>:<p>{errorText(s.error)}</p>}
   </div>
   {(error || ['failed','interrupted'].includes(s.phase)) && <button disabled={disabled||pending} onClick={()=>void run(sessionId,!error)}>Retry</button>}
 </section>;
}
export function DadouchosButton({sessionId,disabled}:{sessionId:string;disabled:boolean}){
 const s=useDadouchos(),open=s.sessionId===sessionId&&s.open || (errorSession===sessionId && !!localError);
 return <TooltipButton className="icon-button dadouchos-action" aria-label="Dadouchos" tooltip="Dadouchos · Illuminating with a torch" aria-expanded={open} aria-pressed={open} disabled={pending || (!open && disabled)}
  onClick={()=>{if(open){localError=null;notify();void window.stomylos.command('dadouchosClose',{sessionId}).catch(()=>undefined);}else void run(sessionId);}}><Icon name="dadouchos"/></TooltipButton>;
}
