import { useState, type ReactNode } from 'react';
import { showText } from '../../core/src/display.js';
import { cleanBlock, groupedIds, mergeBlock, mergeWords, parallelGroups, type ParallelView } from './parallel.js';
import { railGroups, title, type Sess, type State } from './state.js';

const ago = (ts: number) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

function Item({ s, selected, badge, onSelect, onRename }: { s: Sess; selected: boolean; badge: boolean; onSelect: () => void; onRename: (t: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  return (
    <li className={s.status === 'closed' || s.missing ? 'dim' : ''} title={s.missing}>
      {editing ? (
        <form className="rename" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) onRename(draft.trim()); setEditing(false); }}>
          <input aria-label="Session title" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => setEditing(false)} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)} />
        </form>
      ) : (
        <button className="item" aria-current={selected ? 'true' : undefined} onClick={onSelect}
          onDoubleClick={() => { setDraft(title(s)); setEditing(true); }}>
          <span className={`dot ${s.status}`} title={s.status} role="img" aria-label={s.status} />
          <span className="ititle">{title(s)}</span>
          {badge && <span className="badge">{s.open.length || 1}</span>}
          <span className="ago">{ago(s.lastTs)}</span>
        </button>
      )}
    </li>
  );
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export function Rail({ state, selected, onSelect, onNew, onPlus, onRename, onSettings, pathBox, parallelStart, parallel = [], onStopAll = () => {}, onResumeAll = () => {}, onCap = () => {}, onMerge = () => {}, onClean = () => {} }: {
  state: State; selected: string | null; onSelect: (id: string) => void; onNew: () => void; onPlus: (cwd: string) => void;
  onRename: (id: string, title: string) => void; onSettings: () => void; pathBox: ReactNode;
  parallel?: ParallelView[]; onStopAll?: (id: string) => void; onResumeAll?: (id: string) => void; onCap?: (id: string, usd: number | null) => void;
  parallelStart?: ReactNode; onMerge?: (id: string) => void; onClean?: (id: string) => void;
}) {
  const { waiting, groups } = railGroups(state, groupedIds(parallel));
  const item = (s: Sess) => <Item key={s.id} s={s} selected={s.id === selected} badge={s.status === 'waiting'} onSelect={() => onSelect(s.id)} onRename={(t) => onRename(s.id, t)} />;
  return (
    <nav className="rail" aria-label="Sessions">
      <button className="primary new" onClick={onNew}>New session <kbd>Ctrl+O</kbd></button>
      {pathBox}
      {parallelStart}
      {waiting.length === 0 && groups.length === 0 && parallel.length === 0 && <p className="hint">No sessions yet. New session, or Ctrl+O</p>}
      {waiting.length > 0 && <ul className="waiting" aria-label="Waiting for you">{waiting.map(item)}</ul>}
      {parallelGroups(state, parallel).map((g) => (
        <section key={g.run.id} className="group parallel">
          <header title={g.run.title}><span>{g.run.title}</span></header>
          {g.run.approve === 'fence' && <p className="approve">auto-approve: fence</p>}
          {g.run.job && <p className="phase">{g.run.phase}</p>}
          {g.run.job && g.run.job.words !== '' && <pre className="words">{showText(g.run.job.words, { lines: true })}</pre>}
          <p className="counts">{`${g.counts.running} running · ${g.counts.waiting} waiting · ${g.counts.paused} paused · ${g.counts.done} done`}</p>
          <p className={g.over ? 'cost over' : 'cost'}>{`${g.costUnknown ? 'at least ' : ''}${usd(g.cost)}${g.cap !== undefined ? ` of ${usd(g.cap)}` : ''}`}</p>
          <div className="actions">
            <button onClick={() => { if (window.confirm(`Stop all ${g.sessions.length} tasks? Their worktrees are kept.`)) onStopAll(g.run.id); }}>Stop all</button>
            <button onClick={() => onResumeAll(g.run.id)}>Resume all</button>
            {g.run.job && (
              <>
                <button disabled={!!mergeBlock(g.run, g.sessions)} title={mergeBlock(g.run, g.sessions)} onClick={() => { if (window.confirm(mergeWords(g.run, g.sessions))) onMerge(g.run.id); }}>Merge</button>
                <button disabled={!!cleanBlock(g.run)} title={cleanBlock(g.run)} onClick={() => { if (window.confirm('Close the tasks and remove their worktrees and branches? Ignored files are deleted with them, except what reports names. A task not merged stays on disk.')) onClean(g.run.id); }}>Clean</button>
              </>
            )}
            <label>Cap USD
              <input type="number" min="0" step="any" aria-label="Cap in USD" defaultValue={g.cap ?? ''} placeholder="no cap"
                onBlur={(e) => { const v = e.target.value.trim(); const n = Number(v); if (v === '' ? g.cap !== undefined : n > 0 && n !== g.cap) onCap(g.run.id, v === '' ? null : n); }} />
            </label>
          </div>
          {g.run.job && mergeBlock(g.run, g.sessions) && <p className="why">{`Merge: ${mergeBlock(g.run, g.sessions)}`}</p>}
          {g.run.job && cleanBlock(g.run) && <p className="why">{`Clean: ${cleanBlock(g.run)}`}</p>}
          <ul>{g.sessions.map(item)}</ul>
        </section>
      ))}
      {groups.map((g) => (
        <section key={g.cwd} className="group">
          <header title={g.cwd}><span>{g.name}</span><button className="plus" aria-label={`New session in ${g.name}`} onClick={() => onPlus(g.cwd)}>+</button></header>
          <ul>{g.sessions.map(item)}</ul>
        </section>
      ))}
      <button className="gear" aria-label="Settings: Providers" onClick={onSettings}>⚙ Providers</button>
    </nav>
  );
}
