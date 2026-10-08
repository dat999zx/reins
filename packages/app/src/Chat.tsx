import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TagEntry } from '@reins/server/tags.js';
import { post } from './api.js';
import { Composer } from './Composer.js';
import type { EditorState, Tab } from './editorState.js';
import { Feed } from './FeedView.js';
import { feed } from './feed.js';
import type { Actions } from './rows.js';
import { runView } from './runState.js';
import { TextTab } from './TextTab.js';
import { mergeOutput, title, type Sess } from './state.js';

export function Chat({ sess, catalogue, takeRefill, tab, onTab, restore, onState, onDirty, onError }: {
  sess: Sess; catalogue: TagEntry[]; takeRefill: (input: string) => string; tab: Tab; onTab: (t: Tab) => void;
  restore?: EditorState; onState: (patch: Partial<EditorState>) => void;
  onDirty: (dirty: boolean) => void; onError: (message: string) => void;
}) {
  const base = `/api/sessions/${sess.id}`;
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [fresh, setFresh] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({}); // the user's open / closed choice per knot, in memory
  const [reveal, setReveal] = useState<{ runId: string; id: string; n: number }>();
  const [focus, setFocus] = useState<{ key: string; n: number }>();
  const rows = useMemo(() => mergeOutput(sess.rows), [sess.rows]);
  const busy = sess.status === 'running' || sess.status === 'waiting';
  const run = useMemo(() => runView(sess), [sess]);
  const f = useMemo(() => feed(rows, run, new Set(sess.open)), [rows, run, sess.open]);

  const act: Actions = {
    answer: async (questionId, answer) => { await post(`${base}/answer`, { questionId, answer }); },
    resume: (runId) => { post(`${base}/resume`, { runId }).catch((e) => onError(e.message)); },
  };

  // Blocks ↗ on a knot: the Blocks tab shows that step of that run (TextTab checks the run is still the newest and the file still matches)
  const toBlock = (runId: string, step: string) => {
    setReveal((p) => ({ runId, id: step, n: (p?.n ?? 0) + 1 }));
    onTab('blocks');
  };
  // Show in Chat: the newest run's last knot of that step opens and takes the focus
  const onChat = (step?: string) => {
    const strand = f.pieces.find((p) => p.type === 'run' && p.newest);
    const k = step === undefined || strand?.type !== 'run' ? undefined : strand.items.flatMap((i) => ('knot' in i ? [i.knot] : [])).filter((x) => x.step === step).at(-1);
    if (k) {
      setOpen((o) => ({ ...o, [k.key]: true }));
      setFocus((p) => ({ key: k.key, n: (p?.n ?? 0) + 1 }));
    }
    onTab('chat');
  };

  // Show in Chat: the knot's toggle comes into view and takes the focus, once. Here, not in Feed: the Composer (a later child) focuses itself on mount and would win.
  useEffect(() => {
    if (!focus || tab !== 'chat') return;
    const el = log.current?.querySelector<HTMLElement>(`[data-knot="${CSS.escape(focus.key)}"] .sx-kbtn`);
    el?.scrollIntoView({ block: 'start' });
    el?.focus({ preventScroll: true });
    setFocus(undefined);
  }, [focus?.n, tab]);

  useLayoutEffect(() => {
    const el = log.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else setFresh(true);
  }, [sess.rows.length, tab]);

  return (
    <main className="chat">
      <header className="chead">
        <div>
          <h2>{title(sess)}</h2>
          <div className="faint" title={sess.cwd}>{sess.cwd}</div>
        </div>
        <span className={`status ${sess.status}`}><span className={`dot ${sess.status}`} /> {sess.status}</span>
        <span className="faint" aria-label="Session cost">${sess.cost.toFixed(4)}</span>
        <label className="switch">
          <input type="checkbox" checked={sess.autoApprove} onChange={(e) => post(`${base}/settings`, { autoApprove: e.target.checked }).catch((e) => onError(e.message))} />
          Auto-approve
        </label>
        <button disabled={sess.status === 'closed'} onClick={() => { if (window.confirm('Close this session?')) post(`${base}/close`).catch((e) => onError(e.message)); }}>Close</button>
      </header>
      <div className="tabs" role="tablist">
        {(['chat', 'blocks', 'text'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => onTab(t)}>{{ chat: 'Chat', blocks: 'Blocks', text: 'Text' }[t]}</button>
        ))}
      </div>
      {tab === 'chat' ? (
        <>
          <Feed f={f} sess={sess} run={run} act={act} open={open} logRef={log}
            onToggle={(key, next) => setOpen((o) => ({ ...o, [key]: next }))} onBlock={toBlock}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              if (stick.current) setFresh(false);
            }} />
          {fresh && <button className="pill" onClick={() => { stick.current = true; setFresh(false); log.current!.scrollTop = log.current!.scrollHeight; }}>new activity ↓</button>}
          <Composer key={sess.id} id={sess.id} cwd={sess.cwd} busy={busy} catalogue={catalogue} takeRefill={takeRefill} />
        </>
      ) : (
        restore === undefined ? <p className="hint">Loading…</p>
          : <TextTab view={tab} onView={onTab} sess={sess} run={run} act={act} restore={restore} onState={onState} onDirty={onDirty} onRun={() => onTab('chat')}
            reveal={reveal} onRevealed={() => setReveal(undefined)} onChat={onChat} />
      )}
    </main>
  );
}
