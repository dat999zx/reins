import { useEffect, useState } from 'react';
import { showText } from '../../core/src/display.js';
import { ApiError, post } from './api.js';
import { NO_CODE_BUTTON, TRUST_BUTTON, applyBody, planOf, problemsFrom, summaryLines, type PreviewSummary } from './importLines.js';

const MAX_FILE = 1024 * 1024;
const sayErr = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

/** The preview of a block, condition or card mod also lists what it adds (from its manifest; absent in an older reply or for a provider). */
export type KindSummary = PreviewSummary & { adds?: string[]; hash?: string; trusted?: boolean };

/** The preview of a `reinsMods` file (a workflow with the mods it needs): one summary per mod, then what the workflow would do. */
export type EnvelopeSummary = { envelope: true; mods: KindSummary[]; adds: string[]; workflow?: { name: string; exists: boolean; diagnostics: string[] }; warnings: string[] };
export const isEnvelope = (s: KindSummary | EnvelopeSummary): s is EnvelopeSummary => 'envelope' in s;

/** The import request of an envelope: each code mod the user trusted, by the hash that was shown (never `true`), and the built-ins the user confirmed. */
export function envelopeBody(file: string, s: EnvelopeSummary, trust: ReadonlySet<string>, replace: ReadonlySet<string>) {
  const hashes = Object.fromEntries(s.mods.filter((m) => trust.has(m.id) && m.hasCode && m.hash !== undefined).map((m) => [m.id, m.hash]));
  return { file, ...(Object.keys(hashes).length ? { trust: hashes } : {}), ...(replace.size ? { replaceBuiltin: [...replace] } : {}) };
}
/** Whether the file can be imported now: its workflow name is free, and every mod that takes a built-in's place was confirmed. */
export const envelopeReady = (s: EnvelopeSummary, replace: ReadonlySet<string>) => !s.workflow?.exists && s.mods.every((m) => m.replaces !== 'builtin' || replace.has(m.id));

/** One mod of an envelope: its summary, then ONE choice for its code (the prompt, and a box that is empty until the user ticks it), and the built-in confirm. */
function EnvelopeMod({ m, trust, replace, flip }: { m: KindSummary; trust: ReadonlySet<string>; replace: ReadonlySet<string>; flip: (set: 'trust' | 'replace', id: string) => void }) {
  return (
    <section aria-label={`Mod ${m.id}`}>
      <h4>{showText(m.id)}</h4>
      <SummaryList summary={m} />
      {m.hasCode && m.codePrompt && (
        <>
          <p className="pconfirm" role="alert">{m.codePrompt}</p>
          <label><input type="checkbox" checked={trust.has(m.id)} onChange={() => flip('trust', m.id)} /> {TRUST_BUTTON}: {showText(m.id)}{m.trusted ? ' (you trusted this exact code before)' : ''}</label>
        </>
      )}
      {m.replaces === 'builtin' && <label><input type="checkbox" checked={replace.has(m.id)} onChange={() => flip('replace', m.id)} /> Replace the built-in {showText(m.id)}</label>}
    </section>
  );
}

/** Every line of the summary: the server's `adds` come right after the kind, before the files and the code line. */
export function linesOf(s: KindSummary): string[] {
  const lines = summaryLines(s);
  const at = lines.indexOf(`Kind: ${s.kind}`) + 1;
  return [...lines.slice(0, at), ...(s.adds ?? []), ...lines.slice(at)];
}

/** The lines as text (never HTML). */
export function SummaryList({ summary }: { summary: KindSummary }) {
  return (
    <ul className="isummary" aria-label="What importing does">
      {linesOf(summary).map((l, i) => <li key={i}>{showText(l, { lines: true })}</li>)}
    </ul>
  );
}

/** The import dialog (spec 7.7): a file or pasted text, what importing it would do, the code prompt, the built-in confirm. All text, never HTML. */
export function ImportPanel({ onDone, onCancel, shown, initial }: { onDone: (said: string) => void; onCancel: () => void; shown?: KindSummary; initial?: string }) {
  // `initial`: a file that is already chosen (Customize): the dialog opens on its preview, and the import is the same one a chosen file makes.
  const [text, setText] = useState(initial ?? '');
  // `shown`: a preview that is already there (the first render of a test); the dialog starts from a file and asks the server.
  const [summary, setSummary] = useState<KindSummary | undefined>(shown);
  // A file with several mods (and maybe a workflow): its own preview, and a choice per code mod. Nothing is trusted until the user ticks it.
  const [env, setEnv] = useState<EnvelopeSummary | undefined>();
  const [trust, setTrust] = useState<ReadonlySet<string>>(new Set());
  const [replace, setReplace] = useState<ReadonlySet<string>>(new Set());
  const flip = (set: 'trust' | 'replace', id: string) => (set === 'trust' ? setTrust : setReplace)((was) => { const n = new Set(was); if (!n.delete(id)) n.add(id); return n; });
  const [problems, setProblems] = useState<string[]>([]);
  // The choice made on the code prompt, waiting for the built-in confirm.
  const [pending, setPending] = useState<{ trust: boolean } | undefined>();
  const [busy, setBusy] = useState(false);
  const plan = planOf(summary, problems);

  async function preview(file: string) {
    setSummary(undefined);
    setEnv(undefined);
    setTrust(new Set());
    setReplace(new Set());
    setPending(undefined);
    setProblems([]);
    setBusy(true);
    try {
      const got = (await post<{ summary: KindSummary | EnvelopeSummary }>('/api/mods/import/preview', { file })).summary;
      if (isEnvelope(got)) setEnv(got); else setSummary(got);
    } catch (e) {
      setProblems(e instanceof ApiError ? problemsFrom(e.body, e.message) : [sayErr(e)]);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { if (initial) void preview(initial); }, []);
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
  async function applyEnvelope() {
    setBusy(true);
    try {
      const r = await post<{ ids: string[]; problems?: string[]; workflow?: { name: string; diagnostics: string[] } }>('/api/mods/import', envelopeBody(text, env!, trust, replace));
      onDone(`Imported ${r.ids.length} ${r.ids.length === 1 ? 'mod' : 'mods'}${r.workflow ? ` and the workflow ${r.workflow.name}` : ''}.${[...(r.workflow?.diagnostics ?? []), ...(r.problems ?? [])].map((p) => ` ${p}`).join('')}`);
    } catch (e) {
      setProblems(e instanceof ApiError ? problemsFrom(e.body, e.message) : [sayErr(e)]);
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
        <textarea aria-label="Mod file text" rows={5} value={text} onChange={(e) => { setText(e.target.value); setSummary(undefined); setEnv(undefined); setProblems([]); setPending(undefined); }} />
      </label>
      <div className="pactions">
        <button disabled={busy || !text.trim()} onClick={() => void preview(text)}>Preview</button>
      </div>
      {problems.map((p) => <p key={p} className="ferr" role="alert">{p}</p>)}
      {summary && <SummaryList summary={summary} />}
      {env && (
        <div aria-label="What importing the file does">
          {env.mods.map((m) => <EnvelopeMod key={m.id} m={m} trust={trust} replace={replace} flip={flip} />)}
          {env.workflow && <p>Workflow: {showText(env.workflow.name)}{env.workflow.diagnostics.map((d) => ` · ${d}`).join('')}</p>}
          {env.warnings.map((w, i) => <p key={i} className="hint">{showText(w)}</p>)}
        </div>
      )}
      {plan.codePrompt && <p className="pconfirm" role="alert">{plan.codePrompt}</p>}
      {pending && (
        <div className="pconfirm" role="dialog" aria-label="Replace the built-in provider">
          <p>This mod replaces the built-in {summary?.id}. Your sessions on it will use this mod instead.</p>
          <button className="danger" onClick={() => void apply(pending.trust, true)}>Replace the built-in {summary?.id}</button>
          <button onClick={() => setPending(undefined)}>Keep the built-in</button>
        </div>
      )}
      {env && (
        <div className="pactions">
          <button className="primary" disabled={busy || !envelopeReady(env, replace)} onClick={() => void applyEnvelope()}>Import the file</button>
          <button onClick={onCancel}>Cancel</button>
        </div>
      )}
      <div className="pactions" hidden={!!env}>
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
