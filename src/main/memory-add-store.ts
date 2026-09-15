import { validateMemoryMetadata } from './memory-metadata';
import { ColdMemoryStore } from './cold-memory-store';
import type Database from 'better-sqlite3';
import type { Json, Message } from '../shared/types';
import type { RecordedTime } from '../shared/time';
import { memoryPreference, memoryPolicy, memoryWriteAllowed } from './memory-control';
import { memoryHash, memoryJson } from './memory-updater';
import { addAndFifo, memoryAddBody, memoryAddRequestVersion, sessionMemoryAddBody, sessionMemoryAddVersion } from './memory-add';
import {linkBatches,sourceOrder,sourceAnchor,validateSources,sourceLinkVersion,sourceLinkIdentity,sourceLinkPrompt} from './memory-source-link';
import { AppFailure } from './errors';
const now=()=>new Date().toISOString();
// Display order is derived from the transcript, independently of global job identity.
const inputNumberSql = `(SELECT COUNT(*) FROM messages m WHERE m.session_id=j.session_id
  AND m.role='user' AND m.origin='learner'
  AND m.sequence <= (SELECT sequence FROM messages WHERE id=j.message_id))`;

export class MemoryAddStore {
  constructor(private db:Database.Database) {}
  private row(sql:string,...args:any[]):Json|undefined {return this.db.prepare(sql).get(...args) as Json|undefined;}
  private run(sql:string,...args:any[]) {return this.db.prepare(sql).run(...args);}
  jobs(session?:string): Json[] {
    const jobs = this.db.prepare(`SELECT j.ordinal,j.session_id,j.message_id,j.source_kind,j.created_at,j.state,j.failure,j.changes,
      CASE WHEN EXISTS(SELECT 1 FROM memory_source_checkpoints c WHERE c.job_id=j.ordinal) THEN 'link' ELSE 'extract' END phase,
      ${inputNumberSql} AS input_number FROM memory_add_jobs j` +
      (session ? ' WHERE j.session_id=?' : " WHERE j.state NOT IN ('completed','skipped')") + ' ORDER BY j.ordinal')
      .all(...(session ? [session] : [])) as Json[];
    // Mutation history survives explicit deletion from Older, preserving the original outcome.
    const archived = this.db.prepare("SELECT 1 FROM cold_mutations WHERE memory_id=? AND kind='archive' LIMIT 1");
    return jobs.map(job => ({...job, archived_ids: job.changes
      ? JSON.parse(job.changes).evicted.filter((item:{id:string}) => archived.get(item.id)).map((item:{id:string}) => item.id)
      : []}));
  }
  attempts(session:string):import('../shared/memory').MemoryAddAttemptView[] {
    return this.db.prepare(`SELECT a.id,a.job_id,j.message_id,j.source_kind,${inputNumberSql} AS input_number,a.status,a.created_at,CASE WHEN EXISTS(SELECT 1 FROM memory_source_attempts l WHERE l.attempt_id=a.id) THEN 'link' ELSE 'extract' END phase,
      json_extract(a.body,'$.model') model,json_extract(a.body,'$.reasoning.effort') reasoning,a.metadata,a.failure
      FROM memory_add_attempts a JOIN memory_add_jobs j ON j.ordinal=a.job_id
      WHERE j.session_id=? ORDER BY j.ordinal,a.rowid`).all(session) as import('../shared/memory').MemoryAddAttemptView[];
  }
  freeze(message:Message, previous:Message|undefined, sent:RecordedTime) {
    if (!memoryWriteAllowed(this.db,message.session_id) || this.row('SELECT memory_add_scope FROM sessions WHERE id=?',message.session_id)?.memory_add_scope === 'session') return;
    const input=JSON.stringify({timezone:sent.timezone,current_user:{content:message.content,sent_at:sent.utc},
      previous_assistant:previous?.role==='assistant'&&previous.delivery==='complete'?{content:previous.content}:null});
    const config=JSON.stringify({version:memoryAddRequestVersion,body:memoryAddBody(JSON.parse(input),sent),identity:{allowed_models:['openai/gpt-5.6-luna','openai/gpt-5.6-luna-20260709'],provider:null},timeout_ms:120000});
    this.run("INSERT INTO memory_add_jobs(session_id,message_id,input_json,input_hash,config,config_hash,created_at,state) VALUES(?,?,?,?,?,?,?,'pending')",message.session_id,message.id,input,memoryHash(input),config,memoryHash(config),sent.utc);
  }
  cancel(session?:string, reason='memory_disabled') {
    const where=session?' AND session_id=?':'', args=session?[session]:[];
    this.run(`UPDATE memory_add_attempts SET status='cancelled',failure=? WHERE status IN ('queued','dispatched','received') AND job_id IN (SELECT ordinal FROM memory_add_jobs WHERE state NOT IN ('completed','skipped')${where})`,reason,...args);
    this.run(`UPDATE memory_add_jobs SET state='skipped',failure=? WHERE state NOT IN ('completed','skipped')${where}`,reason,...args);
  }
  end(session:string, source:Message[]) {
    const policy=memoryPolicy(this.db,session);
    if(policy.firstEnabled===null)this.cancel(session,'chat_not_dispatched');
    const saved=this.row('SELECT memory_add_scope,ended_at FROM sessions WHERE id=?',session)!;
    if(saved.memory_add_scope!=='session'||policy.firstEnabled!==true||!memoryWriteAllowed(this.db,session))return;
    const messages=source.filter(m=>m.delivery==='complete' && (m.role==='assistant' || m.role==='user'&&m.origin==='learner'));
    const anchor=messages.findLast(m=>m.role==='user');
    if(!anchor || this.row("SELECT 1 FROM memory_add_jobs WHERE session_id=? AND source_kind='session'",session))return;
    const input=JSON.stringify({conversation:messages.map(({role,content})=>({role,content}))});
    const manifest=JSON.stringify({ended_at:saved.ended_at,messages:messages.map(m=>({id:m.id,role:m.role,delivery:m.delivery,sequence:m.sequence,
      sent_at:this.row('SELECT sent_at_utc FROM message_times WHERE message_id=?',m.id)?.sent_at_utc??null}))});
    const config=JSON.stringify({version:sessionMemoryAddVersion,body:sessionMemoryAddBody(JSON.parse(input)),source_manifest_hash:memoryHash(manifest),
      linker:{version:sourceLinkVersion,prompt:sourceLinkPrompt,identity:sourceLinkIdentity,timeout_ms:180000},
      identity:{allowed_models:['openai/gpt-5.6-terra'],provider:null},timeout_ms:180000});
    this.run("INSERT INTO memory_add_jobs(session_id,message_id,input_json,input_hash,config,config_hash,created_at,state,source_kind,source_manifest) VALUES(?,?,?,?,?,?,?,'pending','session',?)",
      session,anchor.id,input,memoryHash(input),config,memoryHash(config),saved.ended_at,manifest);
  }
  private validateManifest(job:Json) {
    if(job.source_kind==='session' && (!job.source_manifest || memoryHash(job.source_manifest)!==JSON.parse(job.config).source_manifest_hash))throw new AppFailure('memory_source_changed');
  }
  recover() {
    this.run("UPDATE memory_add_jobs SET state='interrupted',failure=CASE WHEN EXISTS (SELECT 1 FROM memory_add_attempts a WHERE a.job_id=memory_add_jobs.ordinal AND a.status='queued') THEN 'queued_not_dispatched' ELSE 'interrupted_unknown_outcome' END WHERE state='running'");
    this.run("UPDATE memory_add_attempts SET status='interrupted',failure=CASE WHEN status='queued' THEN 'queued_not_dispatched' ELSE 'interrupted_unknown_outcome' END WHERE status IN ('queued','dispatched')");
    if(!memoryPreference(this.db).enabled)this.cancel();
  }
  private canExtract(session: string) {
    if(this.row('SELECT memory_add_scope FROM sessions WHERE id=?',session)?.memory_add_scope==='session')
      return memoryPolicy(this.db,session).firstEnabled===true && !!this.row("SELECT 1 FROM sessions WHERE id=? AND state='ended'",session);
    if (memoryPolicy(this.db, session).firstEnabled === true) return true;
    // A first associative query may run before chat dispatch, but only after
    // the baseline was frozen independently of this input's new notes.
    return !!this.row(`SELECT 1 FROM sessions s JOIN session_memories m ON m.session_id=s.id
      WHERE s.id=? AND s.state='active'
      AND json_extract(s.chat_config,'$.associative_context_version')='stomylos_associative_recall_v1'`, session);
  }
  ready():Json|null {
    // A failed/unknown earlier source blocks later sources, never chat dispatch.
    const job=this.row("SELECT * FROM memory_add_jobs WHERE state NOT IN ('completed','skipped') ORDER BY ordinal LIMIT 1");
    if(!job)return null;
    if(!memoryWriteAllowed(this.db,job.session_id)){this.cancel(job.session_id);return this.ready();}
    if(!this.canExtract(job.session_id) || !['pending','received'].includes(job.state))return null;
    return job;
  }
  private checkpoint(ordinal:number):Json|undefined {
    const c=this.row('SELECT * FROM memory_source_checkpoints WHERE job_id=?',ordinal);
    if(c && memoryHash(c.records)!==c.records_hash)throw new AppFailure('memory_source_changed');
    return c;
  }
  private linkedAttempt(a:Json):Json {
    const link=this.row('SELECT batch_index FROM memory_source_attempts WHERE attempt_id=?',a.id);
    return {...a,phase:link?'link':'extract',batch_index:link?.batch_index};
  }
  private prepareBatches(ordinal:number) {
    try {
      const c=this.checkpoint(ordinal);if(!c || this.row('SELECT 1 FROM memory_source_batches WHERE job_id=?',ordinal))return;
      const job=this.row('SELECT * FROM memory_add_jobs WHERE ordinal=?',ordinal)!;
      if(memoryHash(job.input_json)!==job.input_hash || memoryHash(job.config)!==job.config_hash)throw new AppFailure('memory_source_changed');
      this.validateManifest(job);
      const bodies=linkBatches(JSON.parse(job.input_json).conversation,JSON.parse(c.records).add,JSON.parse(job.config).linker.prompt);
      this.db.transaction(()=>bodies.forEach((body,index)=>{
        const encoded=JSON.stringify(body);
        this.run('INSERT INTO memory_source_batches(job_id,batch_index,body,body_hash) VALUES(?,?,?,?)',ordinal,index,encoded,memoryHash(encoded));
      }))();
    }catch(e){this.run("UPDATE memory_add_jobs SET state='failed',failure=? WHERE ordinal=?",e instanceof AppFailure?e.code:'operation_failed',ordinal);throw e;}
  }
  prepare(ordinal:number,id:string):Json {
    this.prepareBatches(ordinal);
    return this.db.transaction(()=>{
      const old=this.row('SELECT * FROM memory_add_attempts WHERE id=?',id);
      if(old) {if(old.job_id!==ordinal)throw new AppFailure('memory_add_conflict');return this.linkedAttempt(old);}
      const job=this.ready();if(!job||job.ordinal!==ordinal)throw new AppFailure('memory_add_not_ready');
      if(job.state==='received')return this.linkedAttempt(this.row("SELECT * FROM memory_add_attempts WHERE job_id=? AND status='received'",ordinal)!);
      if(memoryHash(job.input_json)!==job.input_hash)throw new AppFailure('memory_source_changed');
      if(memoryHash(job.config)!==job.config_hash)throw new AppFailure('memory_source_changed');
      this.validateManifest(job);
      const batch=this.row('SELECT * FROM memory_source_batches WHERE job_id=? AND sources IS NULL ORDER BY batch_index LIMIT 1',ordinal);
      const body=batch?.body??JSON.stringify(JSON.parse(job.config).body);
      if(batch && memoryHash(body)!==batch.body_hash)throw new AppFailure('memory_source_changed');
      if(this.checkpoint(ordinal)&&!batch)throw new AppFailure('memory_source_changed');
      this.run("INSERT INTO memory_add_attempts(id,job_id,body,body_hash,status,created_at) VALUES(?,?,?,?,'queued',?)",id,ordinal,body,memoryHash(body),now());
      if(batch)this.run('INSERT INTO memory_source_attempts(attempt_id,job_id,batch_index) VALUES(?,?,?)',id,ordinal,batch.batch_index);
      this.run("UPDATE memory_add_jobs SET state='running',failure=NULL WHERE ordinal=?",ordinal);
      return this.linkedAttempt(this.row('SELECT * FROM memory_add_attempts WHERE id=?',id)!);
    })();
  }
  dispatch(id:string) {
    return this.db.transaction(()=>{
      const a=this.row('SELECT a.*,j.session_id FROM memory_add_attempts a JOIN memory_add_jobs j ON j.ordinal=a.job_id WHERE a.id=?',id);
      if(!a||a.status!=='queued'||!memoryWriteAllowed(this.db,a.session_id)||!this.canExtract(a.session_id)||memoryHash(a.body)!==a.body_hash)throw new AppFailure('memory_add_not_ready');
      this.run("UPDATE memory_add_attempts SET status='dispatched' WHERE id=?",id);
    })();
  }
  receive(id:string,content:string,metadata:Json) {
    this.db.transaction(()=>{
      const a=this.row('SELECT * FROM memory_add_attempts WHERE id=?',id);
      if(!a||['cancelled','succeeded'].includes(a.status))return;
      if(a.status==='received')return;
      if(a.status!=='dispatched')throw new AppFailure('memory_add_not_dispatched');
      this.run("UPDATE memory_add_attempts SET status='received',response_content=?,metadata=? WHERE id=?",content,JSON.stringify(metadata),id);
      this.run("UPDATE memory_add_jobs SET state='received' WHERE ordinal=?",a.job_id);
    })();
  }
  accept(id:string) {
    const next=this.db.transaction(()=>{
      const a=this.row('SELECT a.*,j.session_id,j.message_id,j.created_at observed_at,j.source_kind,j.source_manifest,j.input_json,j.input_hash,j.config,j.config_hash FROM memory_add_attempts a JOIN memory_add_jobs j ON j.ordinal=a.job_id WHERE a.id=?',id);
      if(!a)throw new AppFailure('memory_add_missing');
      if(['cancelled','succeeded'].includes(a.status))return;
      if(!memoryWriteAllowed(this.db,a.session_id)){this.cancel(a.session_id);return;}
      if(a.status!=='received'||this.ready()?.ordinal!==a.job_id)throw new AppFailure('memory_add_not_ready');
      if(memoryHash(a.input_json)!==a.input_hash || memoryHash(a.config)!==a.config_hash || memoryHash(a.body)!==a.body_hash)throw new AppFailure('memory_source_changed');
      this.validateManifest(a);
      const link=this.row('SELECT * FROM memory_source_attempts WHERE attempt_id=?',id);
      const batch=link?this.row('SELECT * FROM memory_source_batches WHERE job_id=? AND batch_index=?',a.job_id,link.batch_index):undefined;
      const expected=batch?.body??JSON.stringify(JSON.parse(a.config).body);
      if(a.body!==expected || batch && memoryHash(batch.body)!==batch.body_hash)throw new AppFailure('memory_source_changed');
      const sessionSource=a.source_kind==='session';
      const linker=JSON.parse(a.config).linker;
      let content=a.response_content,order:number[]|undefined;
      if(sessionSource && linker){
        if(linker.version!==sourceLinkVersion)throw new AppFailure('memory_source_changed');
        if(!link){
          // Validate extraction without applying it. Persist success before link preflight.
          const validated=addAndFifo({character_id:'shared',revision:0,database_records:[]},content,a.session_id,sessionMemoryAddVersion);
          if(validated.changes.added.length){
            this.run('INSERT INTO memory_source_checkpoints(job_id,records,records_hash) VALUES(?,?,?)',a.job_id,content,memoryHash(content));
            this.run("UPDATE memory_add_attempts SET status='succeeded' WHERE id=?",id);
            this.run("UPDATE memory_add_jobs SET state='pending',failure=NULL WHERE ordinal=?",a.job_id);
            return a.job_id as number;
          }
        }else{
          if(!batch || batch.sources!==null)throw new AppFailure('memory_source_changed');
          const sources=JSON.stringify(validateSources(JSON.parse(batch.body),content));
          this.run('UPDATE memory_source_batches SET sources=?,sources_hash=? WHERE job_id=? AND batch_index=?',sources,memoryHash(sources),a.job_id,link.batch_index);
          if(this.row('SELECT 1 FROM memory_source_batches WHERE job_id=? AND sources IS NULL',a.job_id)){
            this.run("UPDATE memory_add_attempts SET status='succeeded' WHERE id=?",id);
            this.run("UPDATE memory_add_jobs SET state='pending' WHERE ordinal=?",a.job_id);return;
          }
          const c=this.checkpoint(a.job_id);if(!c)throw new AppFailure('memory_source_changed');content=c.records;
          const batches=this.db.prepare('SELECT * FROM memory_source_batches WHERE job_id=? ORDER BY batch_index').all(a.job_id) as Json[];
          const maps=batches.flatMap(b=>{
            if(memoryHash(b.body)!==b.body_hash||memoryHash(b.sources)!==b.sources_hash)throw new AppFailure('memory_source_changed');
            return validateSources(JSON.parse(b.body),JSON.stringify({sources:JSON.parse(b.sources)}));
          });
          const conversation=JSON.parse(a.input_json).conversation,manifest=JSON.parse(a.source_manifest).messages;
          order=sourceOrder(conversation,maps);
          const projection=JSON.stringify(order.map((original,index)=>{
            const source=maps.find(s=>s.id===original+1)!,anchor=sourceAnchor(conversation,source);
            return {record_id:original+1,item_index:index,anchor_id:anchor,anchor_role:conversation[anchor-1].role,
              source_message_ids:source.ids.map(id=>manifest[id-1].id)};
          }));
          this.run('UPDATE memory_source_checkpoints SET projection=?,projection_hash=? WHERE job_id=?',projection,memoryHash(projection),a.job_id);
        }
      }

      if(sessionSource)a.observed_at=JSON.parse(a.source_manifest).messages.findLast((m:Json)=>m.role==='user')?.sent_at??null;
      const saved=this.row('SELECT * FROM shared_memory WHERE id=1')!;
      if(memoryHash(saved.document)!==saved.document_hash)throw new AppFailure('memory_document_hash');
      validateMemoryMetadata(this.db,JSON.parse(saved.document));
      const {document,changes}=addAndFifo(JSON.parse(saved.document),content,sessionSource?a.session_id:a.message_id,sessionSource?sessionMemoryAddVersion:undefined,order);
      const encoded=memoryJson(document);
      changes.added.forEach((r,index)=>this.run("INSERT INTO memory_item_metadata(id,source_order,item_index,source_message_id,source_session_id,observed_at,origin) VALUES(?,?,?,?,?,?, 'add')",r.id,a.job_id,index,sessionSource?null:a.message_id,a.session_id,a.observed_at));
      new ColdMemoryStore(this.db).archive(changes.evicted);
      this.run('UPDATE shared_memory SET document=?,document_hash=? WHERE id=1',encoded,memoryHash(encoded));
      changes.evicted.forEach(r=>this.run('DELETE FROM memory_item_metadata WHERE id=?',r.id));
      validateMemoryMetadata(this.db,document);
      this.run("UPDATE memory_add_attempts SET status='succeeded' WHERE id=?",id);
      this.run("UPDATE memory_add_jobs SET state='completed',changes=? WHERE ordinal=?",JSON.stringify(changes),a.job_id);
    })();
    if(typeof next==='number')this.prepareBatches(next);
  }
  fail(id:string,failure:string,interrupted=false,content:string|null=null,metadata:Json={}) {
    this.db.transaction(()=>{
      const a=this.row('SELECT * FROM memory_add_attempts WHERE id=?',id);
      if(!a||['succeeded','cancelled','failed','interrupted'].includes(a.status))return;
      if(a.status==='queued'&&failure!=='memory_add_input_limit')failure='queued_not_dispatched';
      // A valid received response survives a local save failure. Retry saves it
      // locally; it must not buy another extraction or linking completion.
      if(a.status==='received' && ['operation_failed','memory_document_hash'].includes(failure)){
        this.run("UPDATE memory_add_jobs SET state='failed',failure=? WHERE ordinal=?",failure,a.job_id);return;
      }
      const state=interrupted?'interrupted':'failed';
      this.run('UPDATE memory_add_attempts SET status=?,failure=?,response_content=COALESCE(response_content,?),metadata=? WHERE id=?',state,failure,content,JSON.stringify({...JSON.parse(a.metadata),...metadata}),id);
      this.run('UPDATE memory_add_jobs SET state=?,failure=? WHERE ordinal=?',state,failure,a.job_id);
    })();
  }
  retry(session:string,ordinal?:number) {
    const job=this.jobs(session).find(j=>(ordinal===undefined||j.ordinal===ordinal)&&['failed','interrupted'].includes(j.state));
    if(!job)throw new AppFailure('memory_add_not_retryable');
    if(!memoryWriteAllowed(this.db,session))throw new AppFailure('memory_disabled');
    const received=this.row("SELECT 1 FROM memory_add_attempts WHERE job_id=? AND status='received'",job.ordinal);
    this.run("UPDATE memory_add_jobs SET state=?,failure=NULL WHERE ordinal=?",received?'received':'pending',job.ordinal);
  }
  skip(session:string,ordinal?:number) {
    const job=this.jobs(session).find(j=>(ordinal===undefined||j.ordinal===ordinal)&&['failed','interrupted'].includes(j.state));
    if(!job)throw new AppFailure('memory_add_not_retryable');
    this.run("UPDATE memory_add_jobs SET state='skipped',failure='user_skipped' WHERE ordinal=?",job.ordinal);
  }
  manual(id:string,deleted:boolean) {
    if (deleted) {
      new ColdMemoryStore(this.db).revoke(id);
      this.run('DELETE FROM memory_item_metadata WHERE id=?',id);
    } else this.run("UPDATE memory_item_metadata SET origin='manual',edited_at=? WHERE id=?",now(),id);
  }
}
