import { voices, type VoiceId } from '../shared/voice';
import { Icon } from './icons';
import { useSyncExternalStore, useState, useEffect } from 'react';
import type { AppEvent, Message, SpeechSnapshot } from '../shared/types';

let snapshot: SpeechSnapshot = { voice: 'ara', selectionRevision: 0, preview: null, recoveries: [], revision: -1, mode: 'manual', warning: null, cacheBytes: 0, items: [] };
let captureMuted = false;
let token = 0; let selected: string | null = null; let contextReady = Promise.resolve();
const listeners = new Set<() => void>();
const audio = new Audio(); audio.preload = 'metadata';
type Play = Extract<AppEvent, { type: 'speech-play' }> | (Extract<AppEvent, { type: 'speech-preview-play' }> & { messageId: string; sessionId: string | null; automatic: false });
let previewActive = false;
let current: Play | null = null; let queue: Play[] = [];
let playback = { messageId: '', state: 'idle', time: 0, duration: 0, error: '' };
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; };
function stopLocal(automaticOnly = false) {
  queue = automaticOnly ? queue.filter(p => !p.automatic) : [];
  if (!automaticOnly || current?.automatic) {
    audio.pause(); audio.removeAttribute('src'); audio.load(); current = null;
    playback = { messageId: '', state: 'idle', time: 0, duration: 0, error: '' }; notify();
  }
}
async function play(p: Play) {
  if (captureMuted || p.token !== token || p.sessionId !== selected || (p.selectionRevision !== undefined && p.selectionRevision !== snapshot.selectionRevision) || (p.type === 'speech-preview-play' && !previewActive)) return;
  current = p; audio.src = `stomylos://app/speech/${p.audioId}`;
  playback = { messageId: p.messageId, state: 'loading', time: 0, duration: 0, error: '' }; notify();
  try { await audio.play(); }
  catch { if (current === p) { playback = { ...playback, state: 'error', error: 'Playback could not start. Try Play again; no new speech request is needed.' }; notify(); } }
}
for (const name of ['play', 'pause', 'timeupdate', 'loadedmetadata', 'ended', 'error']) audio.addEventListener(name, () => {
  if (!current) return;
  playback = { ...playback, time: audio.currentTime || 0, duration: Number.isFinite(audio.duration) ? audio.duration : 0,
    state: audio.error ? 'error' : audio.ended ? 'ended' : audio.paused ? 'paused' : 'playing',
    error: audio.error ? 'This saved audio could not be played. Check the playback environment; no new request was made.' : '' };
  notify();
  if (name === 'ended' && queue.length) void play(queue.shift()!);
});
window.stomylos.subscribe(event => {
  if (event.type === 'speech' && event.snapshot.revision >= snapshot.revision) { snapshot = event.snapshot; notify(); }
  if (event.type === 'speech-preview-stop' && current?.type === 'speech-preview-play') stopLocal();
  if (event.type === 'speech-preview-play' && previewActive && !captureMuted && event.token === token && event.selectionRevision === snapshot.selectionRevision) {
    stopLocal(); void play({ ...event, messageId: 'preview', sessionId: selected, automatic: false });
  }
  if (event.type === 'speech-stop') stopLocal(event.automaticOnly);
  if (!captureMuted && event.type === 'speech-play' && event.token === token && event.sessionId === selected && (event.selectionRevision === undefined || event.selectionRevision === snapshot.selectionRevision)) {
    if (event.automatic && current && !audio.ended && !audio.paused) queue.push(event);
    else { stopLocal(); void play(event); }
  }
});
void window.stomylos.command('speechSnapshot', undefined).then(value => { if (value.revision >= snapshot.revision) { snapshot = value; notify(); } }).catch(() => undefined);
export function selectSpeechSession(sessionId: string) {
  stopLocal(); selected = sessionId; token++;
  contextReady = window.stomylos.command('speechContext', { sessionId, token });
  void contextReady.catch(() => undefined);
}
export function lockSpeechForCapture(locked: boolean) {
  captureMuted = locked;
  if (locked) {
    stopLocal(); token++;
    if (selected) contextReady = window.stomylos.command('speechContext', { sessionId: selected, token });
    void contextReady.catch(() => undefined);
  }
  notify();
}
export function stopSpeech() { stopLocal(); void window.stomylos.command('speechStop', undefined).catch(() => undefined); }
function useSpeech() { return useSyncExternalStore(subscribe, () => snapshot); }
function usePlayback() { return useSyncExternalStore(subscribe, () => playback); }
function explain(code?: string) {
  if (code === 'speech_text_too_long') return 'This reply is too long for speech. The full text is preserved.';
  if (code === 'api_key_missing') return 'Add your OpenRouter key in Settings to generate speech.';
  if (code === 'speech_cache_full') return 'Speech storage is full. Clear saved speech in Settings to generate more.';
  if (code === 'speech_cache_invalid') return 'Saved speech is damaged. Clear saved speech in Settings before generating it again.';
  if (code === 'speech_preferences_invalid') return 'Speech preferences are unreadable. Manual mode is active; the original file has been preserved.';
  if (code?.includes('cancelled')) return 'Speech generation was cancelled. An already sent request may still be billed.';
  if (code?.includes('interrupted')) return 'Speech was interrupted. Its remote outcome may be unknown.';
  if (code?.includes('timeout')) return 'Speech generation timed out. Retry only if you want another request.';
  return 'Speech could not finish. Your conversation is saved.';
}
export function SpeechControl({ message }: { message: Message }) {
  const muted = useSyncExternalStore(subscribe, () => captureMuted);
  const speech = useSpeech(); const player = usePlayback(); const [error, setError] = useState('');
  if (message.role !== 'assistant' || message.delivery !== 'complete' || !message.content.trim()) return null;
  const item = speech.items.find(i => i.messageId === message.id);
  const active = player.messageId === message.id;
  const busy = item?.state === 'queued' || item?.state === 'generating';
  const retry = !!item && ['failed', 'interrupted', 'cancelled'].includes(item.state);
  const invoke = async () => {
    if (captureMuted) return;
    setError('');
    if (active && player.state === 'playing') { audio.pause(); return; }
    if (active && player.state === 'paused' && !audio.error) { try { await audio.play(); } catch { setError('Playback could not resume.'); } return; }
    try {
      await contextReady;
      if (item?.state === 'save_pending') await window.stomylos.command('speechRecover', { assetKey: item.assetKey!, attemptId: item.attemptId! });
      else await window.stomylos.command('speechListen', { sessionId: message.session_id, messageId: message.id, token, retry, ...(retry && item?.assetKey && item.attemptId ? { assetKey: item.assetKey, attemptId: item.attemptId } : {}) });
    } catch (e) { setError(explain(e instanceof Error ? e.message : '')); }
  };
  const actionLabel = active && player.state === 'playing' ? 'Pause speech' : busy ? 'Generating speech' : item?.state === 'save_pending' ? 'Retry saving speech' : retry ? 'Retry speech' : item?.state === 'ready' ? 'Play speech' : 'Listen';
  const needsRecovery = item?.state === 'save_pending' || retry;
  return <div className="speech-controls" data-speech-message={message.id}>
    <button className={needsRecovery ? "quiet" : "icon-button"} title={actionLabel} disabled={busy || muted} onClick={() => void invoke()} aria-label={actionLabel}>
      {needsRecovery ? actionLabel : <Icon name={active && player.state === 'playing' ? 'pause' : busy ? 'refresh' : item?.state === 'ready' ? 'play' : 'speaker'} className={busy ? 'spinning' : ''} />}</button>
    {(active || busy) && <button className="icon-button" onClick={stopSpeech} aria-label="Stop speech" title="Stop speech"><Icon name="stop" /></button>}
    {active && player.duration > 0 && <><input type="range" aria-label="Speech position" min={0} max={player.duration} step={0.1} value={player.time} onChange={e => { audio.currentTime = Number(e.target.value); }} /><small>{Math.floor(player.time)} / {Math.floor(player.duration)}s</small></>}
    {(error || item?.error || (active && player.error)) && <small className="speech-error" role="status">{error || (active && player.error) || explain(item?.error)}</small>}
  </div>;
}
export function SpeechSettings({ section = 'voice', active = true }: { section?: 'voice' | 'data'; active?: boolean }) {
  const speech = useSpeech(); const player = usePlayback(); const muted = useSyncExternalStore(subscribe, () => captureMuted);
  useEffect(() => {
    if (section !== 'voice') return;
    previewActive = active;
    return () => { previewActive = false; if (current?.type === 'speech-preview-play') stopLocal(); void window.stomylos.command('speechPreviewStop', undefined).catch(() => undefined); };
  }, [active, section]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [confirm, setConfirm] = useState(false);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(explain(e instanceof Error ? e.message : '')); } finally { setBusy(false); } };
  const previewGenerating = speech.preview?.state === 'queued' || speech.preview?.state === 'generating';
  const previewPlaying = player.messageId === 'preview' && ['loading', 'playing', 'paused'].includes(player.state);
  const previewCanStop = previewGenerating || previewPlaying;
  const previewRetry = !!speech.preview && ['failed', 'cancelled', 'interrupted'].includes(speech.preview.state);
  const previewLabel = previewGenerating ? 'Cancel preview generation' : previewPlaying ? 'Stop voice sample' : previewRetry ? 'Retry voice sample' : 'Play voice sample';
  return <section className="setting">
    {section === 'voice' ? <>
      <div className="settings-row voice-selection"><label htmlFor="speech-voice"><strong>Voice</strong></label>
        <select id="speech-voice" value={speech.voice} disabled={busy} onChange={e => void act(() => window.stomylos.command('speechVoice', { voice: e.target.value as VoiceId }))}>
          {voices.map(voice => <option key={voice} value={voice}>{voice[0].toUpperCase() + voice.slice(1)}</option>)}
        </select>
        <button className="icon-button" aria-label={previewLabel} title={previewLabel}
          disabled={muted || !active || (!previewCanStop && (busy || speech.preview?.state === 'save_pending'))}
          onClick={() => {
            if (previewCanStop) {
              if (current?.type === 'speech-preview-play') stopLocal();
              void window.stomylos.command('speechPreviewStop', undefined).catch(e => setError(explain(e instanceof Error ? e.message : '')));
            } else void act(async () => {
              await contextReady;
              await window.stomylos.command('speechPreview', { token, retry: previewRetry });
            });
          }}>
          <Icon name={previewGenerating ? 'refresh' : previewPlaying ? 'stop' : 'play'} className={previewGenerating ? 'spinning' : ''} />
        </button>
      </div>
      <p className="note">Applies to the next Listen or new automatic reply. Preview generation uses API credits; saved samples replay for free.</p>
      {(speech.preview?.error || (player.messageId === 'preview' && player.error)) && <p role="status" className="speech-error">{player.messageId === 'preview' && player.error || explain(speech.preview?.error)}</p>}
      {speech.recoveries.map(recovery => <div className="settings-row" key={recovery.assetKey}>
        <span>Received {recovery.voice[0].toUpperCase() + recovery.voice.slice(1)} {recovery.messageId ? 'reply' : 'preview'} audio needs saving.</span>
        <button disabled={busy} onClick={() => void act(() => window.stomylos.command('speechRecover', { assetKey: recovery.assetKey, attemptId: recovery.attemptId }))}>Retry saving audio</button>
      </div>)}
      <label className="settings-switch"><span><strong>Automatic speech</strong><span className="note">Generate and play new replies. Uses API credits.</span></span>
        <input aria-label="Automatic speech" type="checkbox" checked={speech.mode === 'automatic'} disabled={busy} onChange={e => void act(() => window.stomylos.command('speechMode', { mode: e.target.checked ? 'automatic' : 'manual' }))} /></label>
      <details className="settings-details"><summary>Voice details</summary><p className="note">Grok · {speech.voice[0].toUpperCase() + speech.voice.slice(1)}. When automatic speech is off, use Listen on a reply. Replaying saved audio uses no API credits.</p></details>
    </> : <>
      <div className="settings-row"><div><strong>Saved speech</strong><small>{(speech.cacheBytes / 1024 / 1024).toFixed(1)} MiB on this computer</small></div>
        {!confirm && <button disabled={busy} onClick={() => setConfirm(true)}>Clear saved speech</button>}</div>
      {confirm && <div className="settings-confirm"><p className="note">Remove saved audio? Later listening will regenerate audio and use API credits. Conversation text stays saved.</p><div className="dialog-actions"><button disabled={busy} onClick={() => setConfirm(false)}>Keep speech</button><button disabled={busy} onClick={() => void act(async () => { await window.stomylos.command('speechClear', undefined); setConfirm(false); })}>Confirm clear speech</button></div></div>}
    </>}
    {(error || speech.warning) && <p className="speech-error" role="status">{error || explain(speech.warning!)}</p>}
  </section>;
}
