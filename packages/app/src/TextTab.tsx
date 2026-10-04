import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Diagnostic, StepKind, Workflow } from '@reins/core';
import { addStep, deleteStep, newId, setCond } from './blocks.js';
import { COND_KINDS } from './condKinds.js';
import { ApiError, get, post, put } from './api.js';
import { restoreFile, restoreStep, type CanvasView, type EditorState, type Tab } from './editorState.js';
import { highlight, lineOffset } from './highlight.js';
import type { Sess } from './state.js';
import { runRows, stepStatus } from './stepStatus.js';
import { BlockPanel } from './BlockPanel.js';
import { flatSteps } from './canvas.js';
import { KINDS } from './canvasKinds.js';
import { Canvas, StatusCtx } from './CanvasPane.js';
import { BlocksPane } from './BlocksPane.js';
import { Palette } from './Palette.js';
import { StepChips } from './StepChips.js';

interface Listed { path: string; name: string; scope: 'project' | 'user'; diagnostics: Diagnostic[] }
interface Step { id: string; kind: string; title?: string; depth: number; cond?: string }
interface Preview {
  diagnostics: Diagnostic[]; steps: Step[]; turn?: string; name?: string;
  workflow?: Workflow; reformats?: boolean; text?: string;
  for?: string; // the text this preview was made for
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const template = (name: string) =>
  `---\nreins: 1\nname: ${name}\nbudget: { turns: 10, minutes: 30 }\nalways: []\n---\n\n## phase plan\n> Plan the change.\n\n## phase build\n> Make the change.\n`;

export function TextTab({ view, onView, sess, restore, onState, onDirty, onRun }: {
  view: Exclude<Tab, 'chat'>; onView: (t: 'text') => void;
  sess: Sess; restore?: EditorState; onState: (patch: Partial<EditorState>) => void; onDirty: (dirty: boolean) => void; onRun: () => void;
}) {
  const base = `/api/sessions/${sess.id}`;
  const [list, setList] = useState<Listed[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [prev, setPrev] = useState<Preview | null>(null);
  const [stepId, setStepId] = useState<string | undefined>();
  const [dragging, setDragging] = useState<'step' | 'cond'>();
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const dirty = file !== null && text !== saved;
  // `restore` is read at mount only; later changes to it are our own reports coming back.
  const first = useRef(restore);
  const wantStep = useRef<string | undefined>(undefined);
  // Hold back onState until the restore finished, so a half-restored view never overwrites the stored state.
  const [restored, setRestored] = useState(!restore?.workflow);

  const refresh = () => get<{ workflows: Listed[] }>(`/api/workflows?cwd=${encodeURIComponent(sess.cwd)}`).then((r) => { setList(r.workflows); return r.workflows; }).catch((e) => { setMsg(e.message); return undefined; });
  useEffect(() => {
    void refresh().then(async (l) => {
      const want = first.current;
      if (!want?.workflow) return;
      if (!l) return setRestored(true);
      const path = restoreFile(want.workflow, l);
      if (path && await open(path, true)) {
        wantStep.current = want.stepId;
        if (want.stepId === undefined) setRestored(true);
      } else {
        onState({ workflow: undefined, stepId: undefined });
        setRestored(true);
      }
    });
  }, [sess.id]);
  useEffect(() => {
    if (restored && file !== null) onState({ workflow: file, stepId });
  }, [file, stepId, restored]);
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty]);

  const leave = () => !dirty || window.confirm('Discard unsaved changes?');
  const open = async (path: string, force = false) => {
    if (!force && !leave()) return;
    try {
      const r = await get<{ path: string; text: string }>(`${base}/workflow?path=${encodeURIComponent(path)}`);
      const t = r.text.replace(/\r\n/g, '\n');
      setFile(r.path); setText(t); setSaved(t); setStepId(undefined); setMsg(''); setPrev(null);
      return true;
    } catch (e) {
      setMsg((e as Error).message);
      return false;
    }
  };

  useEffect(() => {
    if (file === null) return;
    let stale = false;
    const t = setTimeout(() => {
      post<Preview>(`${base}/preview`, { text, path: file, ...(stepId ? { stepId } : {}) }).then((p) => {
        if (stale) return;
        setPrev({ ...p, for: text });
        if (wantStep.current !== undefined) {
          const keep = restoreStep(wantStep.current, p.steps);
          wantStep.current = undefined;
          setStepId((cur) => cur ?? keep);
          setRestored(true);
        }
      }).catch(() => {
        if (!stale && wantStep.current !== undefined) { wantStep.current = undefined; setRestored(true); }
      });
    }, 300);
    return () => { stale = true; clearTimeout(t); };
  }, [text, file, stepId]);

  const fileRef = useRef(file);
  const textRef = useRef(text);
  fileRef.current = file;
  textRef.current = text;
  const busy = useRef(false);
  const confirmed = useRef(new Set<string>());
  // Canvas edits go model -> server print -> this same buffer. One at a time; a reply for another file or text is dropped.
  // ponytail: the 300 ms text preview fires once more for the new text and re-syncs every draft field, so text typed within ~300 ms of an edit is lost; debounce it away if it bites
  const edit = (fn: (w: Workflow) => Workflow) => {
    if (busy.current || file === null || !prev?.workflow || prev.for !== text) return false;
    if (prev.reformats && !confirmed.current.has(file)) {
      if (!window.confirm('Editing here rewrites this file in the standard form. Comments, unknown lines, frontmatter comments and unknown keys, and custom order are not kept. Continue?')) return false;
      confirmed.current.add(file);
    }
    const next = fn(prev.workflow);
    if (next === prev.workflow) return false; // a no-op edit sends nothing
    busy.current = true;
    const at = { file, text };
    post<Preview>(`${base}/preview`, { path: file, workflow: next, ...(stepId ? { stepId } : {}) })
      .then((r) => {
        if (fileRef.current !== at.file || textRef.current !== at.text || r.text === undefined) return;
        setText(r.text);
        setPrev({ ...r, for: r.text });
      })
      .catch((e) => setMsg((e as Error).message))
      .finally(() => { busy.current = false; });
    return true;
  };
  // ponytail: a step is added as a sibling after the selection; into a container only by dragging
  const add = (kind: StepKind) => { if (prev?.workflow && edit((w) => addStep(w, kind, stepId))) setStepId(newId(prev.workflow, kind)); };
  // ponytail: no confirm, no undo; nothing is written until Save
  const del = (id: string) => { if (edit((w) => deleteStep(w, id)) && id === stepId) setStepId(undefined); };
  // Read live from `restore`, never copied: a late editor-state load must not be overwritten by an early drag.
  const setView = (patch: CanvasView) => {
    if (!restored || file === null) return;
    const next = { ...restore?.canvas?.[file], ...patch };
    onState({ canvas: { ...restore?.canvas, [file]: next } });
  };

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
  const latest = useMemo(() => runRows(sess.rows), [sess.rows]);
  const status = useMemo(() => stepStatus(latest.rows), [latest]);
  const showStatus = prev?.name !== undefined && prev.name === latest.workflow && !dirty;

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
    const el = ta.current;
    if (!el) return;
    el.focus();
    const o = lineOffset(text, line);
    el.setSelectionRange(o, o);
  };
  const pendingLine = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (view !== 'text' || pendingLine.current === undefined) return;
    jump(pendingLine.current);
    pendingLine.current = undefined;
  }, [view]);
  const visual = view !== 'text';
  // a step of a kind the app has no entry for (a stray `## Notes` heading) would crash the visual tabs
  const known = !prev?.workflow || flatSteps(prev.workflow.steps).every((s) => s.kind in KINDS);
  const sel = stepId && prev?.workflow ? flatSteps(prev.workflow.steps).find((s) => s.id === stepId) : undefined;

  // The slot is checked before edit(): a declined rewrite confirm or a busy editor must not show this note.
  const cond = (t: string) => {
    if (!sel || !KINDS[sel.kind].line.includes('cond')) return setMsg('Select a wait until, repeat until or if block first.');
    if (sel.cond && 'a' in sel.cond) return setMsg('This condition has and / or / not: drop a card on one part of it, or edit it in Text.');
    edit((w) => setCond(w, sel.id, [], COND_KINDS[t]!.fresh()));
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
        {view === 'blocks' && prev?.workflow && known && <Palette onAdd={add} onCond={cond} onDrag={setDragging} />}
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
            {visual && prev && !(prev.workflow && known) && <p className="hint">This file does not parse. Fix it in the Text tab.</p>}
            {visual && prev?.workflow && known && (
              <div className="canvaswrap" tabIndex={-1}
                onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); } }}>
                <StatusCtx.Provider value={{ status, show: showStatus }}>
                  {view === 'map'
                    ? <Canvas w={prev.workflow} steps={prev.steps} diags={prev.diagnostics} text={prev.for ?? text} selected={stepId}
                      view={restore?.canvas?.[file] ?? {}} onView={setView} onSelect={setStepId} />
                    : <BlocksPane w={prev.workflow} steps={prev.steps} diags={prev.diagnostics} text={prev.for ?? text} selected={stepId}
                      rev={prev} dragging={dragging} onEdit={edit} onSelect={setStepId} onDelete={del} />}
                </StatusCtx.Provider>
                {sel && <BlockPanel key={sel.id} step={sel} all={flatSteps(prev.workflow.steps)} cond={prev.steps.find((s) => s.id === sel.id)?.cond}
                  turn={prev.turn} rev={prev} onEdit={edit} onDelete={() => del(sel.id)} onEditInText={() => { pendingLine.current = sel.pos?.line ?? 1; onView('text'); }} />}
              </div>
            )}
            {view === 'text' && <div className="ed">
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
            </div>}
            <ul className="diags" aria-label="Diagnostics">
              {(prev?.diagnostics ?? []).map((d, i) => (
                <li key={i}><button className={d.severity === 'error' ? 'bad' : 'warn'} onClick={() => jump(d.pos.line)}>line {d.pos.line}: {d.message}</button></li>
              ))}
              {prev && prev.diagnostics.length === 0 && <li className="ok">No problems.</li>}
            </ul>
            {view === 'text' && <div className="receives">
              <h3>What the agent receives</h3>
              <ol>
                {(prev?.steps ?? []).map((s) => (
                  <li key={s.id} style={{ paddingLeft: s.depth * 14 }}>
                    <button aria-pressed={s.id === stepId} onClick={() => setStepId(s.id)}>{s.kind}{s.title ? ` ${s.title}` : ''}</button>
                    {/* ponytail: a use step gets no chip; its inlined steps run as block/id, which no listed id matches */}
                    {showStatus && status[s.id] && <StepChips i={status[s.id]!} />}
                  </li>
                ))}
              </ol>
              {stepId && <pre className="turn">{prev?.turn ?? 'This step sends no turn.'}</pre>}
            </div>}
          </>
        )}
        {msg && <div className="note" role="status">{msg}</div>}
      </section>
    </div>
  );
}
