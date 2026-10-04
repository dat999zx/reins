import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TagEntry } from '@reins/server/tags.js';
import { post } from './api.js';
import { Composer } from './Composer.js';
import type { EditorState, Tab } from './editorState.js';
import { renderRow, type Actions } from './rows.js';
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
  const rows = useMemo(() => mergeOutput(sess.rows), [sess.rows]);
  const busy = sess.status === 'running' || sess.status === 'waiting';

  const act: Actions = {
    answer: async (questionId, answer) => { await post(`${base}/answer`, { questionId, answer }); },
    resume: (runId) => { post(`${base}/resume`, { runId }).catch((e) => onError(e.message)); },
  };

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
        {(['chat', 'blocks', 'map', 'text'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => onTab(t)}>{{ chat: 'Chat', blocks: 'Blocks', map: 'Map', text: 'Text' }[t]}</button>
        ))}
      </div>
      {tab === 'chat' ? (
        <>
          <div className="log" ref={log} onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (stick.current) setFresh(false);
          }}>
            {rows.length === 0 && <p className="hint">Say something to start.</p>}
            {rows.map((r) => {
              const el = renderRow(r, { sess, act });
              return el === null ? null : <div className="entry" key={r.seq}>{el}</div>;
            })}
          </div>
          {fresh && <button className="pill" onClick={() => { stick.current = true; setFresh(false); log.current!.scrollTop = log.current!.scrollHeight; }}>new activity ↓</button>}
          <Composer key={sess.id} id={sess.id} cwd={sess.cwd} busy={busy} catalogue={catalogue} takeRefill={takeRefill} />
        </>
      ) : (
        <TextTab view={tab} onView={onTab} sess={sess} restore={restore} onState={onState} onDirty={onDirty} onRun={() => onTab('chat')} />
      )}
    </main>
  );
}
