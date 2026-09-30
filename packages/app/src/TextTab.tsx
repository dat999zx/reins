import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Diagnostic } from '@reins/core';
import { ApiError, get, post, put } from './api.js';
import { highlight, lineOffset } from './highlight.js';
import type { Sess } from './state.js';

interface Listed { path: string; name: string; scope: 'project' | 'user'; diagnostics: Diagnostic[] }
interface Step { id: string; kind: string; title?: string; depth: number }
interface Preview { diagnostics: Diagnostic[]; steps: Step[]; turn?: string }

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const template = (name: string) =>
  `---\nreins: 1\nname: ${name}\nbudget: { turns: 10, minutes: 30 }\nalways: []\n---\n\n## phase plan\n> Plan the change.\n\n## phase build\n> Make the change.\n`;

export function TextTab({ sess, onDirty, onRun }: { sess: Sess; onDirty: (dirty: boolean) => void; onRun: () => void }) {
  const base = `/api/sessions/${sess.id}`;
  const [list, setList] = useState<Listed[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [prev, setPrev] = useState<Preview | null>(null);
  const [stepId, setStepId] = useState<string | undefined>();
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const dirty = file !== null && text !== saved;

  const refresh = () => get<{ workflows: Listed[] }>(`/api/workflows?cwd=${encodeURIComponent(sess.cwd)}`).then((r) => setList(r.workflows)).catch((e) => setMsg(e.message));
  useEffect(() => { void refresh(); }, [sess.id]);
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty]);

  const leave = () => !dirty || window.confirm('Discard unsaved changes?');
  const open = async (path: string, force = false) => {
    if (!force && !leave()) return;
    try {
      const r = await get<{ path: string; text: string }>(`${base}/workflow?path=${encodeURIComponent(path)}`);
      const t = r.text.replace(/\r\n/g, '\n');
      setFile(r.path); setText(t); setSaved(t); setStepId(undefined); setMsg(''); setPrev(null);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  useEffect(() => {
    if (file === null) return;
    let stale = false;
    const t = setTimeout(() => {
      post<Preview>(`${base}/preview`, { text, path: file, ...(stepId ? { stepId } : {}) }).then((p) => { if (!stale) setPrev(p); }).catch(() => {});
    }, 300);
    return () => { stale = true; clearTimeout(t); };
  }, [text, file, stepId]);

  const save = async () => {
    if (file === null) return;
    try {
      await put(`${base}/workflow`, { path: file, text });
      setSaved(text); setMsg('Saved.');
      void refresh();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const create = async () => {
    if (!NAME.test(name)) return setMsg('Use lowercase letters, digits and dashes, starting with a letter or digit.');
    const rel = `.reins/workflows/${name}.reins.md`;
    try {
      if (!leave()) return;
      await put(`${base}/workflow`, { path: rel, text: template(name), create: true });
      setName('');
      await refresh();
      await open(rel, true);
    } catch (e) {
      setMsg(e instanceof ApiError && e.status === 409 ? 'A workflow with that name already exists.' : (e as Error).message);
    }
  };
  const run = () => post(`${base}/run`, { path: file }).then(onRun).catch((e) => setMsg(e.message));

  const marks = useMemo(() => {
    const m = new Map<number, 'error' | 'warning'>();
    for (const d of prev?.diagnostics ?? []) if (m.get(d.pos.line) !== 'error') m.set(d.pos.line, d.severity);
    return m;
  }, [prev]);
  const lines = useMemo(() => highlight(text), [text]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
    else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const el = e.currentTarget;
      el.setRangeText('  ', el.selectionStart, el.selectionEnd, 'end');
      setText(el.value);
    }
  };
  const mirror = () => {
    if (!ta.current) return;
    for (const el of [pre.current, gutter.current]) if (el) { el.scrollTop = ta.current.scrollTop; el.scrollLeft = ta.current.scrollLeft; }
  };
  const jump = (line: number) => {
    const el = ta.current!;
    el.focus();
    const o = lineOffset(text, line);
    el.setSelectionRange(o, o);
  };

  return (
    <div className="texttab">
      <aside className="wflist">
        <form onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <input aria-label="Workflow name" placeholder="new-workflow-name" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" disabled={!name}>New workflow</button>
        </form>
        <ul>
          {list.map((w) => (
            <li key={w.path}>
              <button aria-current={w.path === file ? 'true' : undefined} onClick={() => void open(w.path)}>
                {w.name} <span className="faint">{w.scope}</span>{w.diagnostics.some((d) => d.severity === 'error') && <span className="bad"> ●</span>}
              </button>
            </li>
          ))}
          {list.length === 0 && <li className="hint">No workflows yet.</li>}
        </ul>
      </aside>
      <section className="editor">
        {file === null ? <p className="hint">Pick a workflow, or make a new one.</p> : (
          <>
            <div className="ebar">
              <b>{file.split(/[\\/]/).at(-1)}</b>{dirty && <span className="dirty" title="Unsaved changes" role="img" aria-label="unsaved changes"> ●</span>}
              <span className="grow" />
              <button onClick={() => void save()} disabled={!dirty}>Save</button>
              <button className="primary" onClick={() => void run()} disabled={dirty}>Run</button>
            </div>
            <div className="ed">
              <div className="gutter" ref={gutter} aria-hidden>
                {lines.map((l) => <div key={l.line} className={`ln ${marks.get(l.line) ?? ''}`}>{marks.has(l.line) ? '●' : l.line}</div>)}
              </div>
              <div className="edbody">
                <pre ref={pre} aria-hidden>
                  {lines.map((l) => (
                    <div key={l.line} className={`ln ${marks.get(l.line) ? `wavy ${marks.get(l.line)}` : ''}`}>
                      {l.spans.length === 0 ? ' ' : l.spans.map((s, i) => <span key={i} className={`hl-${s.cls}`}>{s.text}</span>)}
                    </div>
                  ))}
                </pre>
                <textarea ref={ta} aria-label="Workflow text" spellCheck={false} wrap="off" value={text}
                  onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onScroll={mirror} />
              </div>
            </div>
            <ul className="diags" aria-label="Diagnostics">
              {(prev?.diagnostics ?? []).map((d, i) => (
                <li key={i}><button className={d.severity === 'error' ? 'bad' : 'warn'} onClick={() => jump(d.pos.line)}>line {d.pos.line}: {d.message}</button></li>
              ))}
              {prev && prev.diagnostics.length === 0 && <li className="ok">No problems.</li>}
            </ul>
            <div className="receives">
              <h3>What the agent receives</h3>
              <ol>
                {(prev?.steps ?? []).map((s) => (
                  <li key={s.id} style={{ paddingLeft: s.depth * 14 }}>
                    <button aria-pressed={s.id === stepId} onClick={() => setStepId(s.id)}>{s.kind}{s.title ? ` ${s.title}` : ''}</button>
                  </li>
                ))}
              </ol>
              {stepId && <pre className="turn">{prev?.turn ?? 'This step sends no turn.'}</pre>}
            </div>
          </>
        )}
        {msg && <div className="note" role="status">{msg}</div>}
      </section>
    </div>
  );
}
