import { Icon } from './icons';
import { useSyncExternalStore, useState, useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ASR, dictationWarning, type DictationRecord, type DictationSnapshot } from '../shared/asr';
import { currentDraft, editDraft, flushDraft, attachDictation, detachDictation } from './drafts';
import { lockSpeechForCapture, stopSpeech } from './speech';
import { installVoiceShortcuts, voiceComposer, voiceOverlay } from './voice-shortcuts';

type Capture = {
  id: string; sessionId: string; cancelled: boolean; stopping: boolean;
  begin?: Promise<void>; stream?: MediaStream; context?: AudioContext; node?: AudioWorkletNode;
  tail: Promise<void>; reason: NonNullable<DictationRecord['stopReason']>;
  stopQueued?: boolean; ready?: boolean; finalizing?: boolean; timer?: ReturnType<typeof setTimeout>;
};
let capture: Capture | null = null, selected: string | null = null;
let snapshot: DictationSnapshot = { revision: -1, records: [], activeId: null, progress: null, warning: null, audioId: null, unsavedIds: [] };
let error = '', pending = false;
let notice = '';
let transcriptionVersion = 0;
let focusReturn: { sessionId: string; node: HTMLTextAreaElement; start: number; end: number; direction: 'forward' | 'backward' | 'none' } | null = null;
function rememberFocus(sessionId: string) {
  const node = document.querySelector<HTMLTextAreaElement>(voiceComposer);
  focusReturn = node && document.activeElement?.matches(`${voiceComposer}, .record-button, .dictation *`) ?
    { sessionId, node, start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection } : null;
}
function restoreFocus(inserted = false) {
  const target = focusReturn; focusReturn = null;
  if (!target) return;
  setTimeout(() => {
    if (selected !== target.sessionId || !target.node.isConnected || !document.hasFocus() || document.hidden ||
      document.querySelector(voiceOverlay) || !document.activeElement?.matches(`body, ${voiceComposer}, .record-button, .dictation *`)) return;
    target.node.focus({ preventScroll: true });
    target.node.setSelectionRange(inserted ? target.node.value.length : target.start, inserted ? target.node.value.length : target.end, target.direction);
  }, 0);
}
document.addEventListener('focusin', event => {
  if (event.target instanceof Element && !event.target.matches(`${voiceComposer}, .record-button, .dictation *`)) focusReturn = null;
});
document.addEventListener('compositionstart', () => { focusReturn = null; }, true);
window.addEventListener('blur', () => { focusReturn = null; });
let awaiting: { id: string; sessionId: string; revision: number } | null = null;
const used = new Map<string, { sessionId: string; before: string | null; after: string; marked: boolean }>();
const listeners = new Set<() => void>();
let confirmation: { promise: Promise<boolean>; resolve: (value: boolean) => void } | null = null;
let state = { snapshot, error, pending, capturing: false, locked: false, confirmation: false };
function notify() {
  const active = snapshot.records.find(r => r.id === snapshot.activeId);
  state = { snapshot, error, pending, capturing: !!capture, locked: !!capture || pending || active?.phase === 'transcribing', confirmation: !!confirmation };
  for (const listener of listeners) listener();
}
export function dictationBusy() { return state.locked; }
export function useDictation() { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state); }
function explain(cause: unknown) {
  const code = cause instanceof DOMException ? `${cause.name}: ${cause.message}` : cause instanceof Error ? cause.message : String(cause);
  if (code.includes('NotAllowed') || code.includes('Permission')) return 'Microphone access was denied. Allow it in your system settings, then try Record again.';
  if (code.includes('NotFound')) return 'No microphone was found. Connect a microphone and try again.';
  if (code === 'asr_open_timeout') return 'The microphone did not open in time. Recording was cancelled; try Record again.';
  if (code === 'asr_stop_timeout') return 'Recording could not stop normally and was cancelled. Your draft is unchanged; try Record again.';
  if (code === 'asr_invalid_audio') return 'No usable audio was captured. Discard this recording and try again; your draft is unchanged.';
  if (code === 'asr_draft_size') return 'This recognized text will not fit in the draft. Copy it below; your current draft is unchanged.';
  if (code.includes('save')) return 'Dictation could not be saved. Your text is retained here; retry saving without another transcription request.';
  if (code.includes('cancelled') || code.includes('interrupted_unknown')) return 'Transcription was cancelled or interrupted. An uploaded request may still be billed.';
  if (code.includes('audio_not_retained')) return 'Recording was interrupted. Audio is not kept after restart; saved text remains available.';
  if (code.includes('size') || code.includes('duration')) return 'This recording exceeds an upload limit. You can replay or discard it; it will not be shortened or uploaded automatically.';
  if (code.includes('timeout')) return 'Transcription timed out. Retry only if you want to send the recording again.';
  if (code.includes('draft_changed')) return 'Your draft changed. The recognized text is kept below for review and explicit insertion.';
  return `Dictation could not finish (${code}). Your original draft is preserved.`;
}
async function act(fn: () => Promise<unknown>) { error = ''; notify(); try { await fn(); } catch (cause) { error = explain(cause); } finally { notify(); } }
function releaseMedia(op: Capture) {
  op.stream?.getTracks().forEach(track => track.stop());
  op.node?.disconnect();
  if (op.context) void op.context.close().catch(() => undefined);
}
function watchCapture(op: Capture, milliseconds: number, code: string) {
  clearTimeout(op.timer);
  op.timer = setTimeout(() => {
    if (capture !== op || op.cancelled) return;
    void act(async () => { await cancel(true); error = explain(code); });
  }, milliseconds);
}
async function start(sessionId: string) {
  if (state.locked) return;
  rememberFocus(sessionId); notice = '';
  stopSpeech(); lockSpeechForCapture(true);
  document.querySelectorAll<HTMLMediaElement>('audio,video').forEach(media => media.pause());
  const op: Capture = { id: crypto.randomUUID(), sessionId, cancelled: false, stopping: false, tail: Promise.resolve(), reason: 'manual' };
  capture = op; watchCapture(op, 15_000, 'asr_open_timeout'); notify();
  try {
    await flushDraft(sessionId);
    if (op.cancelled) return;
    const draft = currentDraft(sessionId);
    op.begin = window.stomylos.command('asrBegin', { id: op.id, sessionId, revision: draft.revision, text: draft.text });
    await op.begin;
    if (op.cancelled) { await window.stomylos.command('asrCancel', { id: op.id, discard: true }); return; }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: ASR.rate, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
    op.stream = stream;
    if (op.cancelled) { releaseMedia(op); return; }
    const context = new AudioContext({ sampleRate: ASR.rate }); op.context = context;
    if (context.sampleRate !== ASR.rate) throw new Error('asr_sample_rate_unavailable');
    await context.audioWorklet.addModule('/asr-capture.js');
    if (op.cancelled) { releaseMedia(op); return; }
    const node = new AudioWorkletNode(context, 'dictation-capture', { channelCount: 1, channelCountMode: 'explicit', numberOfOutputs: 1 }); op.node = node;
    node.port.onmessage = ({ data }) => {
      if (op.cancelled) return;
      if (data.type === 'chunk') {
        op.tail = op.tail.then(async () => {
          if (op.cancelled) return;
          const progress = await window.stomylos.command('asrChunk', { id: op.id, sequence: data.sequence, pcm: data.pcm });
          node.port.postMessage('ack');
          if (progress.stop) requestStop(op, progress.stop);
        }).catch(cause => { error = explain(cause); requestStop(op, 'interrupted'); notify(); });
      } else if (data.type === 'stopped') {
        if (data.reason !== 'manual') op.reason = data.reason;
        void finalize(op);
      }
    };
    const source = context.createMediaStreamSource(stream);
    source.connect(node); node.connect(context.destination); // Worklet output is silence.
    stream.getTracks().forEach(track => track.addEventListener('ended', () => { if (!op.stopping && !op.cancelled) requestStop(op, 'interrupted'); }));
    context.addEventListener('statechange', () => { if (context.state === 'suspended' && !op.cancelled && !op.stopping) requestStop(op, 'interrupted'); });
    await context.resume();
    if (op.cancelled) { releaseMedia(op); return; }
    op.ready = true;
    clearTimeout(op.timer);
    if (op.stopQueued) requestStop(op, 'manual');
    notify();
  } catch (cause) {
    releaseMedia(op);
    if (!op.cancelled) {
      error = explain(cause); op.cancelled = true;
      if (op.begin) await window.stomylos.command('asrCancel', { id: op.id, discard: true }).catch(() => undefined);
    }
    clearTimeout(op.timer); releaseMedia(op);
    if (capture === op) { capture = null; lockSpeechForCapture(false); restoreFocus(); }
    notify();
  }
}
function requestStop(op: Capture, reason: Capture['reason']) {
  if (op.cancelled) return;
  if (reason !== 'manual' || !op.stopping) op.reason = reason;
  if (op.stopping) return;
  op.stopping = true;
  if (op.node) { watchCapture(op, 5_000, 'asr_stop_timeout'); op.node.port.postMessage('stop'); }
  else void act(() => cancel(true));
  notify();
}
async function finalize(op: Capture) {
  if (op.finalizing || op.cancelled) return;
  op.finalizing = true;
  op.stopping = true; releaseMedia(op); notify();
  await op.tail;
  if (op.cancelled) return;
  try {
    await window.stomylos.command('asrFinish', { id: op.id, reason: op.reason });
    clearTimeout(op.timer);
    const latest = await window.stomylos.command('asrSnapshot', undefined);
    accept(latest);
    const record = latest.records.find(r => r.id === op.id);
    if (!op.cancelled && record?.phase === 'ready' && record.stopReason === 'manual' && op.reason === 'manual') {
      if (capture === op) capture = null;
      await transcribe(record);
    }
  } catch (cause) { if (!op.cancelled) error = explain(cause); }
  finally {
    clearTimeout(op.timer);
    if (capture === op) { capture = null; restoreFocus(); }
    if (!capture) lockSpeechForCapture(false);
    notify();
  }
}
async function cancel(discard: boolean) {
  transcriptionVersion++;
  awaiting = null;
  const op = capture;
  try {
    if (op) {
      op.cancelled = true; clearTimeout(op.timer); op.node?.port.postMessage('cancel'); releaseMedia(op);
      notice = 'Recording cancelled. Nothing was uploaded.'; notify();
      if (op.begin) { await op.begin.catch(() => undefined); await window.stomylos.command('asrCancel', { id: op.id, discard: true }); }
    } else if (snapshot.activeId) await window.stomylos.command('asrCancel', { id: snapshot.activeId, discard });
  } finally {
    if (capture === op) capture = null;
    if (!capture) lockSpeechForCapture(false); restoreFocus(); notify();
  }
}
async function transcribe(record: DictationRecord) {
  if (pending || record.sessionId !== selected) return;
  const version = ++transcriptionVersion;
  pending = true; notice = ''; notify();
  try {
    await flushDraft(record.sessionId);
    if (version !== transcriptionVersion || record.sessionId !== selected) return;
    awaiting = { id: record.id, sessionId: record.sessionId, revision: currentDraft(record.sessionId).revision };
    await window.stomylos.command('asrTranscribe', { id: record.id });
  } catch (cause) { awaiting = null; restoreFocus(); throw cause; }
  finally { pending = false; notify(); }
}
async function insert(record: DictationRecord) {
  if (record.text === undefined || record.discarded || record.submitted || used.has(record.id)) return;
  const draft = currentDraft(record.sessionId);
  if (!draft || selected !== record.sessionId) throw new Error('draft_changed');
  const text = draft.text + (draft.text && !draft.text.endsWith('\n') ? '\n' : '') + record.text;
  if (new TextEncoder().encode(text).length > ASR.textBytes) throw new Error('asr_draft_size');
  attachDictation(record.sessionId, record.id);
  used.set(record.id, { sessionId: record.sessionId, before: draft.text, after: text, marked: false });
  editDraft(record.sessionId, text);
  await prepareDictationSend(record.sessionId); notice = 'Recognized text added. Review your draft before sending.'; notify(); restoreFocus(true);
}
export async function prepareDictationSend(sessionId: string) {
  await flushDraft(sessionId);
  for (const [id, insertion] of used) if (insertion.sessionId === sessionId && !insertion.marked) {
    const draft = currentDraft(sessionId);
    await window.stomylos.command('asrInserted', { id, sessionId, revision: draft.revision, text: draft.text }); insertion.marked = true;
  }
  return [...used].filter(([, value]) => value.sessionId === sessionId).map(([id]) => id);
}
export function dictationSent(sessionId: string) {
  for (const [id, insertion] of used) if (insertion.sessionId === sessionId) used.delete(id);
  notice = '';
  notify();
}
async function textHash(text: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function restoreBindings(sessionId: string) {
  const draft = currentDraft(sessionId); if (!draft?.text || !snapshot.records.some(r => r.sessionId === sessionId && r.draftBinding && !used.has(r.id) && !r.submitted && !r.discarded)) return;
  const hash = await textHash(draft.text);
  for (const record of snapshot.records.toSorted((a, b) => (a.inserted?.revision ?? 0) - (b.inserted?.revision ?? 0))) {
    if (record.sessionId !== sessionId || !record.inserted || record.discarded || record.submitted || used.has(record.id) || record.draftBinding?.textHash !== hash) continue;
    let before: string | null = null;
    if (record.text && draft.text.endsWith(record.text)) {
      const prefix = draft.text.slice(0, -record.text.length);
      if (await textHash(prefix) === record.baseDraftHash) before = prefix;
      else if (prefix.endsWith('\n') && await textHash(prefix.slice(0, -1)) === record.baseDraftHash) before = prefix.slice(0, -1);
    }
    if (currentDraft(sessionId)?.revision !== draft.revision || selected !== sessionId) return;
    used.set(record.id, { sessionId, before, after: draft.text, marked: true }); attachDictation(sessionId, record.id); notify();
  }
}
function accept(next: DictationSnapshot) {
  if (next.revision < snapshot.revision) return;
  snapshot = next; notify();
  const expected = awaiting;
  if (!expected) return;
  const record = snapshot.records.find(r => r.id === expected.id);
  if (record && ['failed', 'cancelled', 'save_pending'].includes(record.phase)) { awaiting = null; restoreFocus(); return; }
  if (record?.phase !== 'complete') return;
  awaiting = null;
  if (selected !== expected.sessionId || currentDraft(expected.sessionId)?.revision !== expected.revision) {
    error = explain('draft_changed'); notify(); restoreFocus(); return;
  }
  if (record.text?.trim()) void act(async () => { try { await insert(record); } finally { restoreFocus(); } });
  else { notice = 'No readable speech was recognized. Your draft is unchanged.'; notify(); restoreFocus(); }
}
window.stomylos.subscribe(event => {
  if (event.type === 'dictation') accept(event.snapshot);
  if (event.type === 'dictation-interrupt' && capture) requestStop(capture, 'interrupted');
});
void window.stomylos.command('asrSnapshot', undefined).then(accept).catch(() => undefined);
document.addEventListener('visibilitychange', () => { if (document.hidden && capture) requestStop(capture, 'interrupted'); });
installVoiceShortcuts({
  cancel: () => {
    if (!capture || confirmation) return false;
    if (!capture.cancelled) void act(() => cancel(true)); return true;
  },
  toggle: () => {
    if (capture) {
      if (capture.stopping || capture.cancelled) return;
      if (!capture.ready) { capture.stopQueued = true; notify(); }
      else requestStop(capture, 'manual');
      return;
    }
    if (state.locked) return;
    const active = snapshot.records.find(record => record.id === snapshot.activeId);
    if (snapshot.unsavedIds.length || snapshot.audioId && active && !['complete'].includes(active.phase)) {
      notice = 'Use Transcribe, Retry or Discard for the retained recording before recording again.'; notify(); return;
    }
    const button = document.querySelector<HTMLButtonElement>('.record-button');
    if (button && !button.disabled) button.click();
  }
});
export function selectDictationSession(id: string) { if (selected !== id) { notice = ''; focusReturn = null; } selected = id; void window.stomylos.command('asrContext', { sessionId: id }).catch(cause => { error = explain(cause); notify(); }); }
export async function beforeDictationNavigation() {
  if (confirmation) return confirmation.promise;
  const active = snapshot.records.find(r => r.id === snapshot.activeId);
  if (capture || snapshot.audioId && active && ['ready', 'failed'].includes(active.phase)) {
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    confirmation = { promise, resolve }; notify(); return promise;
  }
  if (active?.phase === 'transcribing') await cancel(true);
  return true;
}
export function DictationNavigationDialog() {
  const value = useDictation();
  const decide = async (leave: boolean) => {
    const previous = confirmation; if (!previous) return;
    if (leave) await cancel(true);
    confirmation = null; previous.resolve(leave); notify();
  };
  return <Dialog.Root open={value.confirmation} onOpenChange={open => { if (!open) void decide(false); }}><Dialog.Portal>
    <Dialog.Overlay className="modal-overlay" /><Dialog.Content className="dialog" aria-describedby="dictation-leave-description">
      <Dialog.Title>Discard this recording?</Dialog.Title><Dialog.Description id="dictation-leave-description">Stay to finish or transcribe it. Discard stops recording without uploading it and keeps your original draft.</Dialog.Description>
      <div className="dialog-actions"><button onClick={() => void decide(false)}>Stay</button><button onClick={() => void act(() => decide(true))}>Discard and continue</button></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
export function RecordButton({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const value = useDictation();
  return <button className="icon-button record-button" aria-label="Record" aria-keyshortcuts="F8" title="Record voice input · F8" disabled={disabled || value.locked} onClick={() => void act(() => start(sessionId))}>
    <Icon name="mic" />
  </button>;
}
export function DictationPanel({ sessionId, disabled = false }: { sessionId: string; disabled?: boolean }) {
  const value = useDictation(); const [copied, setCopied] = useState('');
  const active = value.snapshot.records.find(r => r.id === value.snapshot.activeId && r.sessionId === sessionId);
  const progress = value.snapshot.progress, seconds = progress ? progress.samples / ASR.rate : active?.duration ?? 0;
  const records = value.snapshot.records.filter(r => r.sessionId === sessionId && r.text !== undefined && !r.discarded && !r.submitted);
  const warning = dictationWarning(progress);
  const recording = value.capturing && capture?.sessionId === sessionId;
  const busy = active?.phase === 'transcribing' || value.pending;
  const play = value.snapshot.audioId === active?.id && !recording;
  const undo = [...used].findLast(([, v]) => v.sessionId === sessionId);
  const needsDecision = play && active && !['complete', 'save_pending'].includes(active.phase);
  const hasDetails = records.length > 0 || !!undo || (play && !needsDecision);
  useEffect(() => { void restoreBindings(sessionId); }, [sessionId, value.snapshot.revision]);
  if (!recording && !busy && !play && !hasDetails && !value.error && !notice && !active?.error && !value.snapshot.warning && !value.snapshot.unsavedIds.length) return null;
  return <section className="dictation" aria-label="Voice input">
    <div className="dictation-actions">
      {recording && <><button aria-keyshortcuts="F8" disabled={!capture?.node || capture.stopping || capture.cancelled} onClick={() => capture && requestStop(capture, 'manual')}>Stop and transcribe</button><button aria-keyshortcuts="Escape" disabled={capture?.cancelled} onClick={() => void act(() => cancel(true))}>Cancel recording</button><span role="timer">{Math.floor(seconds / 60)}:{String(Math.floor(seconds % 60)).padStart(2, '0')} / 10:00</span></>}
      {busy && <><span role="status">Transcribing…</span><button onClick={() => void act(() => cancel(false))}>Cancel transcription</button></>}
      {play && active && !busy && !['complete', 'save_pending'].includes(active.phase) && <>
        <button disabled={disabled || value.locked || !!active.error && ['asr_audio_size', 'asr_request_size', 'asr_invalid_audio'].includes(active.error)} onClick={() => void act(() => transcribe(active))}>{active.attempts.length ? 'Retry transcription' : 'Transcribe'}</button>
        <button onClick={() => void act(() => cancel(true))}>Discard recording</button>
      </>}
      {value.snapshot.unsavedIds.map(id => <button key={id} onClick={() => void act(() => window.stomylos.command('asrRetrySave', { id }))}>Retry saving dictation</button>)}
    </div>
    {recording && <p className="note" role="status">{capture?.cancelled ? 'Recording cancelled. Finishing cleanup…' : capture?.stopping ? 'Stopping recording… Esc cancels before upload.' : capture?.node ? warning ? 'Recording is approaching its limit. It will stop and keep the audio for your decision.' : 'Recording locally. F8 stops and transcribes with OpenRouter; Esc cancels without uploading.' : capture?.stopQueued ? 'Opening microphone… Stop requested. Esc cancels without uploading.' : 'Opening microphone… F8 requests stop and transcription; Esc cancels.'}</p>}
    {!recording && !busy && notice && <p className="note" role="status">{notice}</p>}
    {play && active?.stopReason && active.stopReason !== 'manual' && <p className="note">Recording stopped {active.stopReason === 'time' ? 'at ten minutes' : active.stopReason === 'size' ? 'at the size limit' : 'because capture was interrupted'}. The audio is retained. Choose Transcribe or Discard; nothing was uploaded automatically.</p>}
    {needsDecision && <audio controls preload="metadata" src={`stomylos://app/dictation/${value.snapshot.audioId}`} aria-label="Recorded audio" />}
    {(value.error || active?.error || value.snapshot.warning) && <p role="status" className="speech-error">{value.error || explain(active?.error ?? value.snapshot.warning)}</p>}
    {hasDetails && <details className="dictation-details"><summary>Voice input details{records.length ? ` · ${records.length}` : ''}</summary>
    {play && !needsDecision && <audio controls preload="metadata" src={`stomylos://app/dictation/${value.snapshot.audioId}`} aria-label="Recorded audio" />}
    {undo && <button disabled={value.locked || disabled || undo[1].before === null || currentDraft(sessionId)?.text !== undo[1].after} onClick={() => void act(async () => {
      detachDictation(sessionId, undo[0]); editDraft(sessionId, undo[1].before!); await flushDraft(sessionId);
      await window.stomylos.command('asrCancel', { id: undo[0], discard: true }); used.delete(undo[0]); notify();
    })}>Remove last dictation</button>}
    {records.map(record => <details key={record.id} className="dictation-result"><summary>{used.has(record.id) ? 'Recognized text added to draft' : 'Saved recognized text'} · {new Date(record.createdAt).toLocaleTimeString()}</summary>
      <textarea readOnly aria-label="Recognized text" value={record.text} />
      {!record.text?.trim() && <p className="note">No readable speech was recognized. Your draft has not changed.</p>}
      <button onClick={() => void act(async () => { await navigator.clipboard.writeText(record.text!); setCopied(record.id); })}>{copied === record.id ? 'Copied' : 'Copy recognized text'}</button>
      {!used.has(record.id) && <button disabled={disabled || value.locked || record.phase !== 'complete'} onClick={() => void act(() => insert(record))}>Add to draft</button>}
      {used.has(record.id) && !used.get(record.id)!.marked && <button onClick={() => void act(() => prepareDictationSend(sessionId))}>Retry saving draft</button>}
    </details>)}
    </details>}
    {!recording && !busy && records.length > 0 && <p className="note">Review your draft before sending.</p>}
  </section>;
}

export function recoveryDictationText() { return snapshot.records.filter(record => record.text && !record.submitted && !record.discarded).map(record => `Recognized text (${record.id})\n${record.text}`).join('\n\n'); }
