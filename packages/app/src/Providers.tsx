import { useEffect, useState } from 'react';
import { ApiError, del, get, post, put } from './api.js';
import { cx } from './generic.js';
import { ImportPanel } from './ImportSummary.js';
import { editBody, emptyForm, emptyModel, errorsByField, formToManifest, manifestToForm, type AuthStyle, type ProviderForm } from './providerForm.js';
import { AGENTS_LINE, KEYS_LINE, apiProtocols, rowInfo, type ModRow } from './providersStatus.js';

const url = (id: string, tail = '') => `/api/mods/${encodeURIComponent(id)}${tail}`;
const sayErr = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);
const problemsOf = (e: unknown): string[] => (e instanceof ApiError && Array.isArray(e.body?.problems) ? e.body.problems : [sayErr(e)]);

/** One choice from a short list, shown as buttons. */
function Choice<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: Array<[T, string]>; onPick: (v: T) => void }) {
  return (
    <span className="choice" role="group" aria-label={label}>
      {options.map(([v, text]) => <button key={v} type="button" aria-pressed={value === v} className={cx(value === v && 'on')} onClick={() => onPick(v)}>{text}</button>)}
    </span>
  );
}

function FormView({ initial, editing, protocols, original, onDone, onCancel }: {
  initial: ProviderForm; editing: boolean; protocols: Array<{ id: string; label: string }>; original?: unknown; onDone: () => void; onCancel: () => void;
}) {
  const [f, setF] = useState(initial);
  const [server, setServer] = useState<{ byField: Record<string, string[]>; general: string[] }>({ byField: {}, general: [] });
  const [local, setLocal] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<ProviderForm>) => setF((o) => ({ ...o, ...p }));
  const row = (i: number, p: Partial<ProviderForm['models'][number]>) => set({ models: f.models.map((m, j) => (j === i ? { ...m, ...p } : m)) });
  const eff = (i: number, p: Partial<ProviderForm['efforts'][number]>) => set({ efforts: f.efforts.map((m, j) => (j === i ? { ...m, ...p } : m)) });
  const errs = (k: string) => [...(local[k] ? [local[k]!] : []), ...(server.byField[k] ?? [])];
  const Err = ({ k }: { k: string }) => <>{errs(k).map((t) => <span key={t} className="ferr" role="alert">{t}</span>)}</>;

  async function save() {
    const made = editing ? editBody(f, original) : formToManifest(f);
    const errors = made.errors;
    setLocal(errors);
    setServer({ byField: {}, general: [] });
    if (Object.keys(errors).length) return;
    setBusy(true);
    try {
      if (editing) await put(url(f.id), (made as ReturnType<typeof editBody>).body);
      else await post('/api/mods/custom', { ...(made as ReturnType<typeof formToManifest>).manifest, ...(f.auth !== 'none' && f.key.trim() ? { key: f.key } : {}) });
      onDone();
    } catch (e) {
      setServer(errorsByField(problemsOf(e)));
    } finally {
      setBusy(false);
    }
  }
  const text = (k: 'label' | 'id' | 'baseUrl' | 'modelsUrl', name: string, ph: string, locked = false) => (
    <label className="ffield">{name}
      <input value={f[k]} placeholder={ph} readOnly={locked} onChange={(e) => set({ [k]: e.target.value })} />
      <Err k={k} />
    </label>
  );
  return (
    <form className="pform" aria-label={editing ? 'Edit endpoint' : 'Add custom endpoint'} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h3>{editing ? `Edit ${f.id}` : 'Add custom endpoint'}</h3>
      {server.general.map((t) => <p key={t} className="ferr" role="alert">{t}</p>)}
      {text('label', 'Label', 'My provider')}
      {text('id', 'Id', 'my-provider', editing)}
      <div className="ffield">Protocol
        {editing ? <code>{f.protocol}</code> : <Choice label="Protocol" value={f.protocol} options={protocols.map((p) => [p.id, p.label])} onPick={(v) => set({ protocol: v })} />}
        <Err k="protocol" />
      </div>
      {text('baseUrl', 'Base URL', 'https://api.example.com/v1')}
      {text('modelsUrl', 'Models URL (optional)', 'same address as the base URL')}
      <div className="ffield">Authentication
        <Choice<AuthStyle> label="Authentication" value={f.auth} options={[['bearer', 'Bearer key'], ['header', 'Header key'], ['none', 'None']]} onPick={(v) => set({ auth: v })} />
        <Err k="auth" />
      </div>
      {f.auth === 'header' && <label className="ffield">Header name<input value={f.header} onChange={(e) => set({ header: e.target.value })} /><Err k="header" /></label>}
      {f.auth !== 'none' && (
        <>
          <label className="ffield">Environment variable name (instead of a key)
            <input value={f.keyEnv} placeholder="MY_PROVIDER_API_KEY" onChange={(e) => set({ keyEnv: e.target.value })} /><Err k="keyEnv" />
          </label>
          {!editing && <label className="ffield">Key (saved to Reins, not to the endpoint file)
            <input type="password" autoComplete="off" value={f.key} onChange={(e) => set({ key: e.target.value })} /><Err k="key" />
          </label>}
        </>
      )}
      <fieldset className="ffield"><legend>Models</legend>
        {f.models.map((m, i) => (
          <div className="mrow" key={i}>
            <input aria-label="Model id" placeholder="model id" value={m.id} onChange={(e) => { row(i, { id: e.target.value }); if (!f.defaultModel && i === 0) set({ defaultModel: e.target.value }); }} />
            <input aria-label="Window" placeholder="window" size={8} value={m.context} onChange={(e) => row(i, { context: e.target.value })} />
            <input aria-label="Max output" placeholder="max output" size={8} value={m.maxOutput} onChange={(e) => row(i, { maxOutput: e.target.value })} />
            <Choice<'' | 'yes' | 'no'> label="Tools" value={m.tools} options={[['', 'Tools: default'], ['yes', 'Tools: yes'], ['no', 'Tools: no']]} onPick={(v) => row(i, { tools: v })} />
            <input aria-label="Price in" placeholder="$/M in" size={6} value={m.priceIn} onChange={(e) => row(i, { priceIn: e.target.value })} />
            <input aria-label="Price out" placeholder="$/M out" size={6} value={m.priceOut} onChange={(e) => row(i, { priceOut: e.target.value })} />
            <button type="button" aria-label="Remove model" onClick={() => set({ models: f.models.filter((_, j) => j !== i) })}>x</button>
          </div>
        ))}
        <button type="button" onClick={() => set({ models: [...f.models, emptyModel()] })}>Add model</button>
        <label className="ffield">Default model<input value={f.defaultModel} onChange={(e) => set({ defaultModel: e.target.value })} /><Err k="defaultModel" /></label>
        <Err k="models" />
      </fieldset>
      <div className="ffield">Default price, USD per million tokens (optional)
        <span className="mrow"><input aria-label="Default price in" placeholder="in" size={6} value={f.priceIn} onChange={(e) => set({ priceIn: e.target.value })} />
          <input aria-label="Default price out" placeholder="out" size={6} value={f.priceOut} onChange={(e) => set({ priceOut: e.target.value })} /></span>
        <Err k="price" />
      </div>
      <fieldset className="ffield"><legend>Efforts (optional)</legend>
        {f.efforts.map((x, i) => (
          <div className="mrow" key={i}>
            <input aria-label="Effort id" placeholder="id" size={8} value={x.id} onChange={(e) => eff(i, { id: e.target.value })} />
            <input aria-label="Effort label" placeholder="label" size={10} value={x.label} onChange={(e) => eff(i, { label: e.target.value })} />
            <input aria-label="Effort body" placeholder='JSON body, like {"reasoning_effort":"high"}' value={x.body} onChange={(e) => eff(i, { body: e.target.value })} />
            <button type="button" aria-label="Remove effort" onClick={() => set({ efforts: f.efforts.filter((_, j) => j !== i) })}>x</button>
          </div>
        ))}
        <button type="button" onClick={() => set({ efforts: [...f.efforts, { id: '', label: '', body: '' }] })}>Add effort</button>
        <label className="ffield">Default effort<input value={f.defaultEffort} onChange={(e) => set({ defaultEffort: e.target.value })} /><Err k="defaultEffort" /></label>
        <Err k="efforts" />
      </fieldset>
      <div className="pactions">
        <button type="submit" className="primary" disabled={busy}>{editing ? 'Save' : 'Add endpoint'}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

interface TestReply { result: string; message: string; host?: string }

function Row({ row, reload, edit }: { row: ModRow; reload: () => Promise<void>; edit: (r: ModRow) => void }) {
  const info = rowInfo(row);
  const [msg, setMsg] = useState('');
  const [bad, setBad] = useState(false);
  const [ask, setAsk] = useState<string | undefined>();
  const [draft, setDraft] = useState('');
  const [keying, setKeying] = useState(false);
  const [sure, setSure] = useState(false);
  const run = async (what: () => Promise<unknown>, after?: () => void) => {
    setBad(false);
    try {
      await what();
      after?.();
      await reload();
    } catch (e) {
      setBad(true);
      setMsg(sayErr(e));
    }
  };
  const test = () => run(async () => {
    setMsg('Testing...');
    const r = await post<TestReply>(url(row.id, '/test'));
    if (r.result === 'needs-consent') { setAsk(r.host ?? info.host ?? ''); setMsg(''); } else setMsg(r.message);
  });
  const allow = () => run(async () => {
    await post(url(row.id, '/consent'), {});
    setAsk(undefined);
    const r = await post<TestReply>(url(row.id, '/test'));
    setMsg(r.message);
  });
  const exportIt = () => run(async () => {
    const file = await get<unknown>(url(row.id, '/export'));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
    a.download = `${row.id}.reins-mod.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  return (
    <li className={cx('prow', !row.enabled && 'dim')} data-id={row.id}>
      <div className="phead">
        <b>{row.label}</b> <code>{row.id}</code>
        {info.untested && <span className="badge">untested</span>}
        <span className="pstatus">{info.status}</span>
      </div>
      <div className="pmeta">
        {[info.host, `${info.models} ${info.models === 1 ? 'model' : 'models'}`, info.replaces, info.keyShown].filter(Boolean).join(' · ')}
      </div>
      <div className="pactions">
        {info.canTest && <button onClick={() => void test()}>Test connection</button>}
        {info.canSetKey && <button onClick={() => setKeying(!keying)}>Set key</button>}
        {info.canClearKey && <button onClick={() => void run(() => del(url(row.id, '/key')))}>Clear key</button>}
        {info.canEdit && <button onClick={() => edit(row)}>Edit</button>}
        <button onClick={() => void run(() => post(url(row.id, row.enabled ? '/disable' : '/enable')))}>{row.enabled ? 'Disable' : 'Enable'}</button>
        {row.kind === 'provider' && !row.bundled && <button onClick={() => void exportIt()}>Export</button>}
        {info.canReinstall && <button onClick={() => void run(() => post(url(row.id, '/reinstall')))}>Re-install</button>}
        {info.canRemove && !sure && <button className="danger" onClick={() => setSure(true)}>Remove</button>}
      </div>
      {sure && (
        <div className="pconfirm" role="alert">Remove {row.label}? Its saved key stays.
          <button className="danger" onClick={() => void run(() => del(url(row.id)))}>Remove {row.id}</button>
          <button onClick={() => setSure(false)}>Keep</button>
        </div>
      )}
      {keying && (
        <form className="pconfirm" onSubmit={(e) => { e.preventDefault(); void run(() => put(url(row.id, '/key'), { key: draft }), () => { setDraft(''); setKeying(false); }); }}>
          <input type="password" autoComplete="off" aria-label={`Key for ${row.id}`} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" disabled={!draft.trim()}>Save key</button>
        </form>
      )}
      {ask !== undefined && (
        <div className="pconfirm" role="dialog" aria-label="Allow sending">
          <p>Reins will send your key to <b>{ask}</b> to ask for its list of models. Your prompts and files are not part of this test.</p>
          <button className="primary" onClick={() => void allow()}>Allow</button>
          <button onClick={() => { setAsk(undefined); setMsg('Not tested. Nothing was sent.'); }}>Cancel</button>
        </div>
      )}
      {msg && <p className={cx('pmsg', bad && 'bad')} role="status">{msg}</p>}
    </li>
  );
}

export function Providers({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<ModRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [problem, setProblem] = useState('');
  const [importing, setImporting] = useState(false);
  const [said, setSaid] = useState('');
  const [form, setForm] = useState<{ initial: ProviderForm; editing: boolean; original?: unknown } | undefined>();
  const reload = async () => {
    try {
      setRows((await get<{ mods: ModRow[] }>('/api/mods')).mods);
      setProblem('');
    } catch (e) {
      setProblem(sayErr(e));
    }
    setLoaded(true);
  };
  useEffect(() => { void reload(); }, []);
  const protocols = apiProtocols(rows);
  return (
    <main className="providers" aria-label="Providers">
      <header className="phead2"><h2>Settings: Providers</h2><button onClick={onClose}>Close</button></header>
      {problem && <p className="ferr" role="alert">{problem}</p>}
      <p className="hint">{KEYS_LINE}</p>
      <p className="hint">{AGENTS_LINE}</p>
      <div className="pactions">
        <button className="primary" onClick={() => setForm({ initial: emptyForm(protocols[0]?.id ?? ''), editing: false })}>Add custom endpoint</button>
        <button onClick={() => setImporting(true)}>Import</button>
      </div>
      {said && <p className="pmsg" role="status">{said}</p>}
      {importing && <ImportPanel onCancel={() => setImporting(false)} onDone={(m) => { setImporting(false); setSaid(m); void reload(); }} />}
      {form && (
        <FormView key={form.initial.id || 'new'} {...form} protocols={protocols} onCancel={() => setForm(undefined)} onDone={() => { setForm(undefined); void reload(); }} />
      )}
      {!loaded ? <p className="hint">Loading...</p> : (
        <ul className="plist">
          {rows.filter((r) => r.kind === 'provider').map((r) => (
            <Row key={r.id} row={r} reload={reload} edit={(x) => setForm({ initial: manifestToForm(x.manifest), editing: true, original: x.manifest })} />
          ))}
        </ul>
      )}
    </main>
  );
}
