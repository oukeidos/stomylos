import { randomUUID } from 'node:crypto';
import type { DadouchosSnapshot } from '../shared/dadouchos';
import type { Json } from '../shared/types';
import { requestSettings } from '../shared/request-history';
import { AppFailure, failureCode } from './errors';
import { CompletionFailure, type Gateway } from './transport';
import { prepareProviderRequest } from './provider-policy';
import { dadouchosBody, dadouchosContract, dadouchosIdentity, dadouchosPromptHash, parseDadouchos, type DadouchosSource } from './dadouchos';
type Hooks = {
  source(id: string): Promise<DadouchosSource>; emit(s: DadouchosSnapshot): void;
  start(id: string, session: string, parent: string | null, settings: Json): Promise<void>;
  finish(id: string, metadata: Json, failure: string | null, session: string): Promise<void>;
};
export class DadouchosController {
  private state: DadouchosSnapshot={revision:0,sessionId:null,open:false,phase:'idle',text:null,error:null};
  private source: DadouchosSource | null=null;
  private flight: {abort:AbortController; done:Promise<void>} | null=null;
  private parent: string | null=null;
  private epoch=0;
  private openingSession:string|null=null;
  private operations=new Map<string,string>();
  constructor(private gateway:Gateway, private hooks:Hooks) {}
  snapshot(){return {...this.state};}
  get busy(){return !!this.flight;}
  private publish(){this.state.revision++;this.hooks.emit(this.snapshot());}
  async open(sessionId:string,operationId:string,retry=false){
    const epoch=this.epoch;this.openingSession=sessionId;
    let source:DadouchosSource;
    try{source=await this.hooks.source(sessionId);}finally{if(this.openingSession===sessionId)this.openingSession=null;}
    if(epoch!==this.epoch) throw new AppFailure('dadouchos_stale');
    const key=JSON.stringify([sessionId,source.hash,retry]),seen=this.operations.get(operationId);
    if(seen && seen!==key) throw new AppFailure('dadouchos_operation_conflict');
    if(seen) return this.snapshot();
    if(this.operations.size>=1024) throw new AppFailure('dadouchos_input_limit');
    this.operations.set(operationId,key);
    if(this.source?.hash===source.hash){
      this.state.open=true;
      if(!retry || this.busy || !['failed','interrupted'].includes(this.state.phase)){this.publish();return this.snapshot();}
    }else{
      this.dispose();this.source=source;this.parent=null;
      this.operations.set(operationId,key);
    }
    dadouchosBody(source);this.source=source;this.state={...this.state,sessionId,open:true,phase:'waiting',text:null,error:null};
    this.dispatch(source);return this.snapshot();
  }
  /** Hiding a ready result preserves it; pending requests are cancelled, never replayed. */
  hide(sessionId?:string){if(sessionId && this.state.sessionId!==sessionId)return;this.cancel();this.state.open=false;this.publish();}
  cancel(){if(this.flight && this.state.phase==='waiting'){this.epoch++;this.flight.abort.abort();this.state.phase='interrupted';this.state.error='request_cancelled';this.publish();}}
  dispose(sessionId?:string){
    if(sessionId && this.state.sessionId!==sessionId && this.openingSession!==sessionId)return;
    this.openingSession=null;this.epoch++;this.flight?.abort.abort();this.source=null;this.parent=null;this.operations.clear();
    this.state={revision:this.state.revision,sessionId:null,open:false,phase:'idle',text:null,error:null};this.publish();
  }
  async settle(){await this.flight?.done;}
  private dispatch(source:DadouchosSource){
    const previous=this.flight?.done,epoch=this.epoch,abort=new AbortController(),id=randomUUID(),parent=this.parent;
    this.parent=id;
    const current=()=>this.epoch===epoch && this.source===source && !abort.signal.aborted;
    const done=(async()=>{
      let recorded=false,dispatched=false,metadata:Json={},failure:string|null=null;
      const started=performance.now();
      try{
        await previous;
        if(!current())return;
        const routed=prepareProviderRequest(dadouchosBody(source),dadouchosIdentity);
        await this.hooks.start(id,source.sessionId,parent,{...requestSettings(routed.body),contract:dadouchosContract.version,prompt_sha256:dadouchosPromptHash});recorded=true;
        if(!current())throw new AppFailure('queued_not_dispatched');
        const latest=await this.hooks.source(source.sessionId);
        if(!current() || latest.hash!==source.hash)throw new AppFailure('dadouchos_stale');
        dispatched=true;
        const result=await this.gateway.complete(routed.body,routed.identity!,abort.signal,dadouchosContract.timeout_ms);
        metadata=result.metadata;
        if(!current())return;
        const fresh=await this.hooks.source(source.sessionId);
        if(!current())return;
        if(fresh.hash!==source.hash)throw new AppFailure('dadouchos_stale');
        this.state.text=parseDadouchos(result.content);this.state.phase='ready';this.state.error=null;
      }catch(error){
        failure=failureCode(error);if(error instanceof CompletionFailure)metadata=error.metadata;
        if(current()){this.state.phase='failed';this.state.error=failure;}
      }finally{
        if(!current())failure=dispatched?'request_cancelled':'queued_not_dispatched';
        if(recorded){metadata.elapsed_seconds=(performance.now()-started)/1000;await this.hooks.finish(id,metadata,failure,source.sessionId);}
        if(this.flight?.abort===abort)this.flight=null;
        if(this.source===source)this.publish();
      }
    })();
    this.flight={abort,done};this.publish();
    // Storage hooks own visible save recovery; teardown failures must not be unhandled.
    void done.catch(()=>undefined);
  }
}
