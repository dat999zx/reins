import { useState, type ReactNode } from 'react';
import { railGroups, title, type Sess, type State } from './state.js';

const ago = (ts: number) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

function Item({ s, selected, badge, onSelect, onRename }: { s: Sess; selected: boolean; badge: boolean; onSelect: () => void; onRename: (t: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  return (
    <li className={s.status === 'closed' ? 'dim' : ''}>
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

export function Rail({ state, selected, onSelect, onNew, onPlus, onRename, pathBox }: {
  state: State; selected: string | null; onSelect: (id: string) => void; onNew: () => void; onPlus: (cwd: string) => void;
  onRename: (id: string, title: string) => void; pathBox: ReactNode;
}) {
  const { waiting, groups } = railGroups(state);
  const item = (s: Sess) => <Item key={s.id} s={s} selected={s.id === selected} badge={s.status === 'waiting'} onSelect={() => onSelect(s.id)} onRename={(t) => onRename(s.id, t)} />;
  return (
    <nav className="rail" aria-label="Sessions">
      <button className="primary new" onClick={onNew}>New session <kbd>Ctrl+O</kbd></button>
      {pathBox}
      {waiting.length === 0 && groups.length === 0 && <p className="hint">No sessions yet — New session, or Ctrl+O</p>}
      {waiting.length > 0 && <ul className="waiting" aria-label="Waiting for you">{waiting.map(item)}</ul>}
      {groups.map((g) => (
        <section key={g.cwd} className="group">
          <header title={g.cwd}><span>{g.name}</span><button className="plus" aria-label={`New session in ${g.name}`} onClick={() => onPlus(g.cwd)}>+</button></header>
          <ul>{g.sessions.map(item)}</ul>
        </section>
      ))}
    </nav>
  );
}
