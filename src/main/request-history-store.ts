import type Database from 'better-sqlite3';
import type { Json } from '../shared/types';
import { requestSettings, type RequestAttempt } from '../shared/request-history';
const parse = (text: string | null | undefined): Json => text ? JSON.parse(text) : {};

/** Read original attempt tables, independently of currently active feature views. */
export function requestHistory(db: Database.Database, sessionId: string): RequestAttempt[] {
  const rows = (sql: string) => db.prepare(sql).all(sessionId) as Json[];
  const result: RequestAttempt[] = [];
  const add = (row: Json, kind: string, source: Json, fallbackModel?: string, notes?: string[]) => {
    const wire = parse(row.provider_request).body;
    const settings = requestSettings(wire ?? source), config = parse(row.config);
    const provenance = Object.fromEntries(['source_hash','config_hash','input_hash','body_hash'].filter(key => row[key]).map(key => [key,row[key]]));
    for (const key of ['version','prompt_id','prompt_sha256','schema_sha256']) if (config[key]) provenance[key] = config[key];
    provenance.settings_source = wire ? 'Effective request snapshot' : 'Saved generation settings';
    result.push({ id: row.id, kind, status: row.status ?? row.state,
      createdAt: row.created_at ?? row.dispatched_at ?? null, dispatchedAt: row.dispatched_at,
      finishedAt: row.finished_at, parentId: row.parent_id, messageId: row.message_id,
      model: settings.model ?? fallbackModel, settings, metadata: parse(row.metadata), failure: row.failure, notes, provenance,
      retainedText: kind === 'Conversation' && row.status !== 'succeeded' ? row.response_content : undefined });
  };
  for (const row of rows('SELECT r.*,s.model session_model FROM model_requests r JOIN sessions s ON s.id=r.session_id WHERE r.session_id=?')) {
    const config = parse(row.config), target = config.request_partner?.target;
    add(row, row.role === 'chat' ? 'Conversation' : row.role === 'grammar' ? 'Grammar analysis' :
      config.purpose === 'partner_reselection' ? 'Partner reselection' : 'Partner selection',
      config.parameters ?? {...target}, row.role === 'chat' ? target?.model ?? row.session_model : undefined,
      config.purpose === 'partner_reselection' ? [`Excluded: ${config.excluded_model} · ${config.source_message_ids?.length ?? 0} recent messages · ${config.omitted_groups} earlier turns omitted`] : undefined);
  }
  for (const row of rows('SELECT a.*,a.user_message_id message_id,t.decision,t.permitted FROM search_router_attempts a JOIN search_turns t ON t.user_message_id=a.user_message_id WHERE t.session_id=?'))
    add(row, `Search routing · ${row.ordinal === 0 ? 'Primary' : 'Fallback'}`, parse(row.config), undefined, [row.decision === 'router_unavailable' ? 'Router unavailable; bounded search permitted' : row.permitted === 1 ? 'Search permitted by routing' : row.permitted === 0 ? 'Search not needed' : 'Awaiting routing']);
  for (const row of rows('SELECT a.*,j.config,j.model FROM starter_renewal_attempts a JOIN starter_renewal_jobs j ON j.id=a.job_id WHERE j.session_id=?')) {
    const config = parse(row.config); add(row, 'Starter generation', config.parameters ?? config.request_parameters ?? {}, row.model);
  }
  for (const row of rows('SELECT a.*,j.config FROM memory_attempts a JOIN memory_jobs j ON j.ordinal=a.job_id WHERE j.session_id=?')) {
    const config = parse(row.config); add(row, 'Memory update', config.parameters ?? config.request_parameters ?? {});
  }
  for (const row of rows(`SELECT a.*,LAG(a.id) OVER (PARTITION BY a.job_id ORDER BY a.rowid) parent_id,j.message_id,(SELECT COUNT(*) FROM messages m WHERE m.session_id=j.session_id AND m.origin='learner' AND m.sequence<=(SELECT sequence FROM messages WHERE id=j.message_id)) input_number
    FROM memory_add_attempts a JOIN memory_add_jobs j ON j.ordinal=a.job_id WHERE j.session_id=?`))
    add(row, `Memory update · Input ${row.input_number}`, parse(row.body));
  for (const row of rows('SELECT a.*,c.config FROM memory_cleanup_attempts a JOIN memory_candidates c ON c.session_id=a.session_id WHERE a.session_id=?')) {
    const config = parse(row.config); add(row, 'Memory cleanup (legacy)', config.parameters ?? config.request_parameters ?? {});
  }
  for (const row of rows('SELECT a.*,j.config FROM intention_question_attempts a JOIN intention_question_jobs j ON j.id=a.job_id WHERE j.session_id=?')) {
    const config = parse(row.config), route = config.routes?.[row.route];
    add(row, 'Intention starter generation (legacy)', route?.parameters ?? config.parameters ?? {}, undefined, [`Run ${row.run} · route ${row.route + 1}`]);
  }
  for (const row of rows('SELECT a.*,e.request_body,e.message_id,LAG(a.id) OVER (PARTITION BY a.explanation_id ORDER BY a.rowid) parent_id FROM explanation_attempts a JOIN explanations e ON e.id=a.explanation_id WHERE e.session_id=?'))
    add(row, 'Explain', parse(row.request_body));
  for (const row of rows('SELECT a.*,o.body,o.body_hash FROM opener_attempts a JOIN conversation_openers o ON o.session_id=a.session_id WHERE a.session_id=?')) add(row, 'Conversation opener', parse(row.body));
  for (const row of rows('SELECT * FROM genie_request_attempts WHERE session_id=?')) add(row, 'Genie', parse(row.settings));
  return result;
}
