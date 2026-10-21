import { useState } from 'react';
import { ApiError, post } from './api.js';
import { BUILT_IN_LINE, installIds, needsLine, preTicked, resultLine, type ChooserEntry, type InstallResult } from './firstRunCards.js';
import { cx } from './generic.js';

/** The first screen of a new Reins home (spec 7.3): pick providers to install, or skip. Skip always works. */
export function FirstRun({ cards, onLeave }: { cards: ChooserEntry[]; onLeave: () => void }) {
  const [ticked, setTicked] = useState(() => preTicked(cards));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [results, setResults] = useState<InstallResult[]>([]);
  const toggle = (id: string) => setTicked((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));

  async function install() {
    setBusy(true);
    setProblem('');
    try {
      const r = await post<{ results: InstallResult[] }>('/api/mods/install', { ids: installIds(cards, ticked) });
      setResults(r.results);
      if (r.results.length && r.results.every((x) => x.ok)) onLeave();
      else if (r.results.some((x) => x.ok)) setTicked((t) => t.filter((id) => !r.results.some((x) => x.ok && x.id === id)));
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function skip() {
    try {
      await post('/api/mods/first-run/done');
    } catch {
      // Skip never blocks the app: the screen goes even when the mark could not be saved.
    }
    onLeave();
  }

  return (
    <main className="firstrun" aria-label="First run">
      <h2>Choose your providers</h2>
      <p className="hint">{BUILT_IN_LINE}</p>
      <ul className="plist">
        {cards.map((c) => (
          <li key={c.id} className={cx('prow', 'card', ticked.includes(c.id) && 'on')} data-id={c.id}>
            <label className="phead">
              <input type="checkbox" checked={ticked.includes(c.id)} onChange={() => toggle(c.id)} />
              <b>{c.label}</b> <code>{c.id}</code>
              {c.untested && <span className="badge">untested</span>}
            </label>
            {c.description && <div>{c.description}</div>}
            <div className="pmeta">{[c.host, needsLine(c)].filter(Boolean).join(' · ')}</div>
          </li>
        ))}
      </ul>
      {problem && <p className="ferr" role="alert">{problem}</p>}
      {results.length > 0 && (
        <ul className="plist" aria-label="Install results">
          {results.map((r) => <li key={r.id} className={r.ok ? 'pmsg' : 'ferr'} role="status">{resultLine(r)}</li>)}
        </ul>
      )}
      <div className="pactions">
        {cards.length > 0 && <button className="primary" disabled={busy || !ticked.length} onClick={() => void install()}>Install</button>}
        <button onClick={() => void skip()}>Skip</button>
      </div>
    </main>
  );
}
