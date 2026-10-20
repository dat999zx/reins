import { useState } from 'react';
import { ApiError, post } from './api.js';
import { NO_CODE_BUTTON, TRUST_BUTTON, applyBody, planOf, problemsFrom, summaryLines, type PreviewSummary } from './importLines.js';

const MAX_FILE = 1024 * 1024;
const sayErr = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

/** The import dialog (spec 7.7): a file or pasted text, what importing it would do, the code prompt, the built-in confirm. All text, never HTML. */
export function ImportPanel({ onDone, onCancel }: { onDone: (said: string) => void; onCancel: () => void }) {
  const [text, setText] = useState('');
  const [summary, setSummary] = useState<PreviewSummary | undefined>();
  const [problems, setProblems] = useState<string[]>([]);
  // The choice made on the code prompt, waiting for the built-in confirm.
  const [pending, setPending] = useState<{ trust: boolean } | undefined>();
  const [busy, setBusy] = useState(false);
  const plan = planOf(summary, problems);

  async function preview(file: string) {
    setSummary(undefined);
    setPending(undefined);
    setProblems([]);
    setBusy(true);
    try {
      setSummary((await post<{ summary: PreviewSummary }>('/api/mods/import/preview', { file })).summary);
    } catch (e) {
      setProblems(e instanceof ApiError ? problemsFrom(e.body, e.message) : [sayErr(e)]);
    } finally {
      setBusy(false);
    }
  }
  async function pick(f: File | undefined) {
    if (!f) return;
    if (f.size > MAX_FILE) return void setProblems(['The file is larger than 1 MB.']);
    const t = await f.text();
    setText(t);
    await preview(t);
  }
  async function apply(trust: boolean, replaceBuiltin: boolean) {
    setBusy(true);
    try {
      const r = await post<{ id: string; problems?: string[] }>('/api/mods/import', applyBody(text, { trust, replaceBuiltin }));
      onDone(`Imported ${r.id}.${r.problems?.length ? ` ${r.problems.join(' ')}` : ''}`);
    } catch (e) {
      setProblems(e instanceof ApiError ? problemsFrom(e.body, e.message) : [sayErr(e)]);
      setPending(undefined);
      setBusy(false);
    }
  }
  /** A click on the import choice: go on, or ask about the built-in first. */
  const choose = (trust: boolean) => (plan.confirmBuiltin ? setPending({ trust }) : void apply(trust, false));

  return (
    <section className="pform" aria-label="Import a mod file">
      <h3>Import a mod file</h3>
      <label className="ffield">File (.json)
        <input type="file" accept=".json,application/json" onChange={(e) => void pick(e.target.files?.[0])} />
      </label>
      <label className="ffield">Or paste the file text
        <textarea aria-label="Mod file text" rows={5} value={text} onChange={(e) => { setText(e.target.value); setSummary(undefined); setProblems([]); setPending(undefined); }} />
      </label>
      <div className="pactions">
        <button disabled={busy || !text.trim()} onClick={() => void preview(text)}>Preview</button>
      </div>
      {problems.map((p) => <p key={p} className="ferr" role="alert">{p}</p>)}
      {summary && (
        <ul className="isummary" aria-label="What importing does">
          {summaryLines(summary).map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      )}
      {plan.codePrompt && <p className="pconfirm" role="alert">{plan.codePrompt}</p>}
      {pending && (
        <div className="pconfirm" role="dialog" aria-label="Replace the built-in provider">
          <p>This mod replaces the built-in {summary?.id}. Your sessions on it will use this mod instead.</p>
          <button className="danger" onClick={() => void apply(pending.trust, true)}>Replace the built-in {summary?.id}</button>
          <button onClick={() => setPending(undefined)}>Keep the built-in</button>
        </div>
      )}
      <div className="pactions">
        {plan.trustChoice ? (
          <>
            <button className="primary" disabled={busy || !plan.canImport || !!pending} onClick={() => choose(true)}>{TRUST_BUTTON}</button>
            <button disabled={busy || !plan.canImport || !!pending} onClick={() => choose(false)}>{NO_CODE_BUTTON}</button>
          </>
        ) : (
          <button className="primary" disabled={busy || !plan.canImport || !!pending} onClick={() => choose(false)}>Import</button>
        )}
        <button onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}
