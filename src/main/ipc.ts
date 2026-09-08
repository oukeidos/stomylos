import { validBudget } from '../shared/usage';
import { isVoice } from '../shared/voice';
import { validateExplainCommand } from './explain-ipc';
import { explainCommands } from '../shared/explain';
import { patternCommands } from '../shared/pattern-report';
import { validatePatternCommand } from './pattern-report-ipc';
import type { CommandArgs } from '../shared/types';
import { AppFailure } from './errors';
import { genieCommands } from '../shared/genie';
import { validateGenieCommand } from './genie-ipc';
import { ASR } from '../shared/asr';
import { dictationId } from './asr-store';
import { validApiKey } from '../shared/credentials';

const commands: (keyof CommandArgs)[] = [...explainCommands, ...patternCommands, ...genieCommands, 'usageSnapshot', 'usageBudget', 'setSessionBookmark', 'deleteSession', 'retryDeletionCleanup', 'asrSnapshot', 'asrContext', 'asrBegin', 'asrChunk', 'asrFinish', 'asrTranscribe', 'asrCancel', 'asrRetrySave', 'asrInserted', 'speechVoice', 'speechPreview', 'speechPreviewStop', 'speechRecover', 'speechSnapshot', 'speechMode', 'speechContext', 'speechListen', 'speechRetrySave', 'speechStop', 'speechClear', 'currentMemory', 'snapshot', 'listSessions', 'loadSession', 'saveDraft', 'replaceStarter', 'setOpening', 'selectPartner', 'changePartner', 'useSelectedPartner', 'retryPartnerSelection',
  'searchMode', 'sendMessage', 'retryReply', 'endSession', 'newSession', 'retryAnalysis', 'retryStarterRenewal', 'retryIntentionQuestions', 'retryMemory', 'skipMemory', 'retrySaving', 'backupExport', 'backupRestore', 'refreshKey', 'manageKey', 'close'];
const noArgs = new Set(['usageSnapshot', 'speechPreviewStop', 'retryDeletionCleanup', 'asrSnapshot', 'speechSnapshot', 'speechStop', 'speechClear', 'currentMemory', 'snapshot', 'newSession', 'retrySaving', 'backupExport', 'backupRestore', 'refreshKey', 'close']);
export function validateCommand(name: unknown, args: unknown): asserts name is keyof CommandArgs {
  const bad = () => { throw new AppFailure('invalid_command'); };
  if (typeof name !== 'string' || !commands.includes(name as keyof CommandArgs)) return bad();
  if (name.startsWith('explain')) { validateExplainCommand(name, args); return; }
  if (name.startsWith('pattern')) { validatePatternCommand(name, args); return; }
  if (name.startsWith('genie')) { validateGenieCommand(name, args); return; }
  if (noArgs.has(name)) { if (args !== undefined) bad(); return; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return bad();
  const value = args as Record<string, unknown>;
  if (name === 'usageBudget') {
    if (Object.keys(value).length !== 1 || !validBudget(value.amount)) bad();
    return;
  }
  if (name === 'manageKey') {
    if (value.action === 'save') {
      if (Object.keys(value).length !== 2 || typeof value.key !== 'string' || value.key.length > 4100 || !validApiKey(value.key.trim())) bad();
    } else if (value.action === 'mode') {
      if (Object.keys(value).length !== 2 || !['auto', 'env', 'disabled'].includes(value.mode as string)) bad();
    } else if (!['import', 'delete'].includes(value.action as string) || Object.keys(value).length !== 1) bad();
    return;
  }
  if (name === 'asrContext') {
    if (Object.keys(value).length !== 1 || typeof value.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.sessionId)) bad();
    return;
  }
  if (name.startsWith('asr')) {
    if (!dictationId(value.id)) bad();
    const expected = ['id'];
    if (name === 'asrBegin' || name === 'asrInserted') {
      expected.push('sessionId', 'text', 'revision');
      if (typeof value.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.sessionId) ||
          typeof value.text !== 'string' || Buffer.byteLength(value.text) > ASR.textBytes ||
          !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) bad();
    }
    if (name === 'asrChunk') {
      expected.push('sequence', 'pcm');
      if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 ||
          !(value.pcm instanceof Int16Array) || !value.pcm.length || value.pcm.length > ASR.chunkSamples) bad();
    }
    if (name === 'asrFinish') { expected.push('reason'); if (!['manual', 'time', 'size', 'interrupted'].includes(value.reason as string)) bad(); }
    if (name === 'asrCancel') { expected.push('discard'); if (typeof value.discard !== 'boolean') bad(); }
    if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) bad();
    return;
  }
  if (name === 'speechVoice') {
    if (Object.keys(value).length !== 1 || !isVoice(value.voice)) bad(); return;
  }
  if (name === 'speechPreview') {
    if (Object.keys(value).length !== 2 || !Number.isSafeInteger(value.token) || (value.token as number) < 0 || typeof value.retry !== 'boolean') bad(); return;
  }
  if (name === 'speechRecover') {
    if (Object.keys(value).length !== 2 || typeof value.assetKey !== 'string' || !/^(?:preview-)?[a-f0-9]{64}$/.test(value.assetKey) ||
      typeof value.attemptId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.attemptId)) bad(); return;
  }
  if (name === 'speechMode') {
    if (Object.keys(value).length !== 1 || !['manual', 'automatic'].includes(value.mode as string)) bad();
    return;
  }
  if (name === 'listSessions') {
    if (Object.keys(value).some(key => !['offset', 'filter'].includes(key)) || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0 ||
      (Object.hasOwn(value, 'filter') && !['all', 'bookmarked'].includes(value.filter as string))) bad();
    return;
  }
  const fields = ['sessionId'];
  if (typeof value.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.sessionId)) bad();
  if (['speechListen', 'speechRetrySave'].includes(name)) {
    fields.push('messageId');
    if (typeof value.messageId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.messageId)) bad();
  }
  if (['speechContext', 'speechListen'].includes(name)) {
    fields.push('token'); if (!Number.isSafeInteger(value.token) || (value.token as number) < 0) bad();
  }
  if (name === 'speechListen' && (Object.hasOwn(value, 'assetKey') || Object.hasOwn(value, 'attemptId'))) {
    fields.push('assetKey', 'attemptId');
    if (typeof value.assetKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.assetKey) || typeof value.attemptId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.attemptId)) bad();
  }
  if (name === 'speechListen') { fields.push('retry'); if (typeof value.retry !== 'boolean') bad(); }
  if (name === 'saveDraft' || name === 'sendMessage') {
    fields.push('text', 'revision');
    if (typeof value.text !== 'string' || Buffer.byteLength(value.text) > 100_000 ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) bad();
  }
  if (['sendMessage', 'saveDraft'].includes(name) && Object.hasOwn(value, 'dictationIds')) {
    fields.push('dictationIds');
    if (!Array.isArray(value.dictationIds) || value.dictationIds.length > 100 || !value.dictationIds.every(dictationId) ||
        new Set(value.dictationIds).size !== value.dictationIds.length) bad();
  }
  if (name === 'setSessionBookmark') { fields.push('bookmarked'); if (typeof value.bookmarked !== 'boolean') bad(); }
  if (name === 'selectPartner' || name === 'changePartner') { fields.push('character'); if (value.character !== null && (typeof value.character !== 'string' || value.character.length > 100)) bad(); }
  if (name === 'changePartner') {
    fields.push('operationId', 'expectedRevision');
    if (typeof value.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.operationId) || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) bad();
  }
  if (name === 'searchMode') { fields.push('mode'); if (!['auto', 'off'].includes(value.mode as string)) bad(); }
  if (name === 'replaceStarter') {
    fields.push('operationId', 'expectedQuestionId');
    for (const key of ['operationId', 'expectedQuestionId']) {
      if (typeof value[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value[key] as string)) bad();
    }
  }
  if (name === 'setOpening') {
    fields.push('operationId', 'kind');
    if (typeof value.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.operationId) || !['starter', 'user'].includes(value.kind as string)) bad();
  }
  if (name === 'setOpening' || (name === 'replaceStarter' && Object.hasOwn(value, 'expectedRevision'))) {
    fields.push('expectedRevision');
    if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) bad();
  }
  if (name === 'endSession' && Object.hasOwn(value, 'command')) { fields.push('command'); if (typeof value.command !== 'boolean') bad(); }
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) bad();
}
