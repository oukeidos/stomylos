import { useEffect, useId, useRef, useState } from 'react';
import type { Settings } from '../shared/types';
import { validApiKey, type KeyAction, type KeyMode } from '../shared/credentials';

const sources = { secure: 'System secure storage', env: '.env file', none: 'Not available', test: 'Isolated test key' };
export function CredentialSettings({ active, settings, errorText }: {
  active: boolean; settings: Settings; errorText(error: unknown): string;
}) {
  const id = useId(), epoch = useRef(0), pending = useRef(false);
  const [key, setKey] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [notice, setNotice] = useState(''), [confirm, setConfirm] = useState(false);
  const status = settings.credentials;
  const editable = !settings.development && !!status;
  useEffect(() => {
    epoch.current++; setKey(''); setError(''); setNotice(''); setConfirm(false);
    return () => { epoch.current++; };
  }, [active]);
  const run = async (change?: KeyAction) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    const started = epoch.current;
    try {
      if (change) await window.stomylos.command('manageKey', change);
      else await window.stomylos.command('refreshKey', undefined);
      if (started !== epoch.current) return;
      setKey(''); setConfirm(false);
      if (change?.action === 'save' || change?.action === 'import') setNotice('Saved securely. Used for the next API request. Authentication has not been checked.');
      if (change?.action === 'import') setNotice('Saved securely. The original .env file was kept. Authentication has not been checked.');
      if (change?.action === 'delete') setNotice('Saved key deleted. API access is disabled until you save a key or choose a source.');
    } catch (cause) { if (started === epoch.current) setError(errorText(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <section className="setting credential-settings">
    <div className="settings-row"><div><strong>OpenRouter API key</strong>
      <small>Using: {status ? sources[status.source] : settings.keyPresent ? 'Available' : 'Not available'}</small>
    </div><button disabled={busy} onClick={() => void run()}>Reload key status</button></div>
    {status?.problem && <p className="speech-error" role="alert">{errorText(new Error(status.problem))}</p>}
    {error && <p className="speech-error" role="alert">{error}</p>}
    {notice && <p className="note" role="status">{notice}</p>}
    {editable ? <>
      {!status.secureAvailable && <p className="note">System secure storage is unavailable or locked. Unlock your system keyring and reload, or use a .env file.</p>}
      <form className="credential-form" onSubmit={event => { event.preventDefault(); if (validApiKey(key.trim())) void run({ action: 'save', key }); }}>
        <label htmlFor={`${id}-key`}>{status.saved ? 'Replacement API key' : 'API key'}</label>
        <input id={`${id}-key`} type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" maxLength={4100}
          value={key} disabled={busy || !status.secureAvailable} onChange={event => setKey(event.target.value)} />
        <div className="credential-actions"><button className="primary" type="submit" disabled={busy || !status.secureAvailable || !validApiKey(key.trim())}>Save securely</button>
          {(status.saved || status.problem === 'credential_file_unreadable') && <button type="button" disabled={busy} onClick={() => setConfirm(true)}>Delete saved key</button>}</div>
      </form>
      {confirm && <div className="settings-confirm"><p className="note">Delete the saved key and disable API access? The .env file will be kept and will not be activated automatically.</p>
        <div className="credential-actions"><button disabled={busy} onClick={() => setConfirm(false)}>Keep key</button><button className="delete-confirm" disabled={busy} onClick={() => void run({ action: 'delete' })}>Confirm delete key</button></div></div>}
      <details className="settings-details"><summary>Key source &amp; .env fallback</summary>
        <div className="credential-source"><label htmlFor={`${id}-source`}>Key source</label>
          <select id={`${id}-source`} value={status.mode} disabled={busy} onChange={event => void run({ action: 'mode', mode: event.target.value as KeyMode })}>
            <option value="auto">System secure storage first (recommended)</option><option value="env">Use .env file</option><option value="disabled">Disable API access</option>
          </select>
        </div>
        <p className="note">The recommended mode uses .env only when no secure key is saved. Storage or authentication errors never switch keys automatically.</p>
        <p className="note">Add OPENROUTER_API_KEY to this file, then reload. Keep it private; .env stores the key as plain text.</p><code>{settings.keyPath}</code>
        <div className="credential-actions"><button disabled={busy || !status.secureAvailable} onClick={() => void run({ action: 'import' })}>Import .env key into secure storage</button></div>
        <p className="note">Import keeps the original file for other tools. Removing that plain-text copy is a separate choice. Secure keys are local to this computer and OS account; enter your key again on another computer.</p>
      </details>
    </> : <p className="note">{settings.simulation ? 'Isolated test data and a dummy key are used in this preview.' : 'This development build uses isolated data.'} Normal API keys and system secure storage are not accessed. Key management is disabled.</p>}
  </section>;
}
