import { validateMemoryMetadata } from './memory-metadata';
import { ColdMemoryStore } from './cold-memory-store';
import type Database from 'better-sqlite3';
import type { Json, Message } from '../shared/types';
import type { RecordedTime } from '../shared/time';
import { memoryPreference, memoryPolicy, memoryWriteAllowed } from './memory-control';
import { memoryHash, memoryJson } from './memory-updater';
import { addAndFifo, memoryAddBody, memoryAddRequestVersion } from './memory-add';
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
    const jobs = this.db.prepare(`SELECT j.ordinal,j.session_id,j.message_id,j.created_at,j.state,j.failure,j.changes,
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
    return this.db.prepare(`SELECT a.id,a.job_id,j.message_id,${inputNumberSql} AS input_number,a.status,a.created_at,
      json_extract(a.body,'$.model') model,json_extract(a.body,'$.reasoning.effort') reasoning,a.metadata,a.failure
      FROM memory_add_attempts a JOIN memory_add_jobs j ON j.ordinal=a.job_id
      WHERE j.session_id=? ORDER BY j.ordinal,a.rowid`).all(session) as import('../shared/memory').MemoryAddAttemptView[];
  }
  freeze(message:Message, previous:Message|undefined, sent:RecordedTime) {
    if (!memoryWriteAllowed(this.db,message.session_id)) return;
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
  end(session:string) {if(memoryPolicy(this.db,session).firstEnabled===null)this.cancel(session,'chat_not_dispatched');}
  recover() {
    this.run("UPDATE memory_add_jobs SET state='interrupted',failure=CASE WHEN EXISTS (SELECT 1 FROM memory_add_attempts a WHERE a.job_id=memory_add_jobs.ordinal AND a.status='queued') THEN 'queued_not_dispatched' ELSE 'interrupted_unknown_outcome' END WHERE state='running'");
    this.run("UPDATE memory_add_attempts SET status='interrupted',failure=CASE WHEN status='queued' THEN 'queued_not_dispatched' ELSE 'interrupted_unknown_outcome' END WHERE status IN ('queued','dispatched')");
    if(!memoryPreference(this.db).enabled)this.cancel();
  }
  ready():Json|null {
    // A failed/unknown earlier source blocks later sources, never chat dispatch.
    const job=this.row("SELECT * FROM memory_add_jobs WHERE state NOT IN ('completed','skipped') ORDER BY ordinal LIMIT 1");
    if(!job)return null;
    if(!memoryWriteAllowed(this.db,job.session_id)){this.cancel(job.session_id);return this.ready();}
    if(memoryPolicy(this.db,job.session_id).firstEnabled!==true || !['pending','received'].includes(job.state))return null;
    return job;
  }
  prepare(ordinal:number,id:string):Json {
    return this.db.transaction(()=>{
      const old=this.row('SELECT * FROM memory_add_attempts WHERE id=?',id);
      if(old) {if(old.job_id!==ordinal)throw new AppFailure('memory_add_conflict');return old;}
      const job=this.ready();if(!job||job.ordinal!==ordinal)throw new AppFailure('memory_add_not_ready');
      if(job.state==='received')return this.row("SELECT * FROM memory_add_attempts WHERE job_id=? AND status='received'",ordinal)!;
      if(memoryHash(job.input_json)!==job.input_hash)throw new AppFailure('memory_source_changed');
      if(memoryHash(job.config)!==job.config_hash)throw new AppFailure('memory_source_changed');
      const body=JSON.stringify(JSON.parse(job.config).body);
      this.run("INSERT INTO memory_add_attempts(id,job_id,body,body_hash,status,created_at) VALUES(?,?,?,?,'queued',?)",id,ordinal,body,memoryHash(body),now());
      this.run("UPDATE memory_add_jobs SET state='running',failure=NULL WHERE ordinal=?",ordinal);
      return this.row('SELECT * FROM memory_add_attempts WHERE id=?',id)!;
    })();
  }
  dispatch(id:string) {
    return this.db.transaction(()=>{
      const a=this.row('SELECT a.*,j.session_id FROM memory_add_attempts a JOIN memory_add_jobs j ON j.ordinal=a.job_id WHERE a.id=?',id);
      if(!a||a.status!=='queued'||!memoryWriteAllowed(this.db,a.session_id)||memoryPolicy(this.db,a.session_id).firstEnabled!==true||memoryHash(a.body)!==a.body_hash)throw new AppFailure('memory_add_not_ready');
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
    return this.db.transaction(()=>{
      const a=this.row('SELECT a.*,j.session_id,j.message_id,j.created_at observed_at,j.input_json,j.input_hash,j.config,j.config_hash FROM memory_add_attempts a JOIN memory_add_jobs j ON j.ordinal=a.job_id WHERE a.id=?',id);
      if(!a)throw new AppFailure('memory_add_missing');
      if(['cancelled','succeeded'].includes(a.status))return;
      if(!memoryWriteAllowed(this.db,a.session_id)){this.cancel(a.session_id);return;}
      if(a.status!=='received'||this.ready()?.ordinal!==a.job_id)throw new AppFailure('memory_add_not_ready');
      if(memoryHash(a.input_json)!==a.input_hash || memoryHash(a.config)!==a.config_hash || memoryHash(a.body)!==a.body_hash || a.body!==JSON.stringify(JSON.parse(a.config).body))throw new AppFailure('memory_source_changed');
      const saved=this.row('SELECT * FROM shared_memory WHERE id=1')!;
      if(memoryHash(saved.document)!==saved.document_hash)throw new AppFailure('memory_document_hash');
      validateMemoryMetadata(this.db,JSON.parse(saved.document));
      const {document,changes}=addAndFifo(JSON.parse(saved.document),a.response_content,a.message_id);
      const encoded=memoryJson(document);
      changes.added.forEach((r,index)=>this.run("INSERT INTO memory_item_metadata(id,source_order,item_index,source_message_id,source_session_id,observed_at,origin) VALUES(?,?,?,?,?,?, 'add')",r.id,a.job_id,index,a.message_id,a.session_id,a.observed_at));
      new ColdMemoryStore(this.db).archive(changes.evicted);
      this.run('UPDATE shared_memory SET document=?,document_hash=? WHERE id=1',encoded,memoryHash(encoded));
      changes.evicted.forEach(r=>this.run('DELETE FROM memory_item_metadata WHERE id=?',r.id));
      validateMemoryMetadata(this.db,document);
      this.run("UPDATE memory_add_attempts SET status='succeeded' WHERE id=?",id);
      this.run("UPDATE memory_add_jobs SET state='completed',changes=? WHERE ordinal=?",JSON.stringify(changes),a.job_id);
    })();
  }
  fail(id:string,failure:string,interrupted=false,content:string|null=null,metadata:Json={}) {
    this.db.transaction(()=>{
      const a=this.row('SELECT * FROM memory_add_attempts WHERE id=?',id);
      if(!a||['succeeded','cancelled','failed','interrupted'].includes(a.status))return;
      if(a.status==='queued')failure='queued_not_dispatched';
      const state=interrupted?'interrupted':'failed';
      this.run('UPDATE memory_add_attempts SET status=?,failure=?,response_content=COALESCE(response_content,?),metadata=? WHERE id=?',state,failure,content,JSON.stringify({...JSON.parse(a.metadata),...metadata}),id);
      this.run('UPDATE memory_add_jobs SET state=?,failure=? WHERE ordinal=?',state,failure,a.job_id);
    })();
  }
  retry(session:string,ordinal?:number) {
    const job=this.jobs(session).find(j=>(ordinal===undefined||j.ordinal===ordinal)&&['failed','interrupted'].includes(j.state));
    if(!job)throw new AppFailure('memory_add_not_retryable');
    if(!memoryWriteAllowed(this.db,session))throw new AppFailure('memory_disabled');
    this.run("UPDATE memory_add_jobs SET state='pending',failure=NULL WHERE ordinal=?",job.ordinal);
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
