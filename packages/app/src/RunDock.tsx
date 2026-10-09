import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Workflow } from '@reins/core';
import { sendCard } from './api.js';
import { QuestionCard } from './QuestionCard.js';
import type { Actions } from './rows.js';
import { receiptFields } from './rows/receipt.js';
import { meter, PHASE, type Pos, type RunCard, type RunView } from './runState.js';
import type { Sess } from './state.js';

const CARD_STATE: Record<RunCard['state'], string> = { queued: 'queued', delivered: 'delivered', unsent: 'not sent' };

export function RunDock(p: {
  run: RunView; sess: Sess; act: Actions; budget?: Workflow['budget']; pos?: Pos;
  match: boolean; open: boolean; onOpen(o: boolean): void; starting?: string; onChat(): void; onDismiss(): void;
}): ReactNode {
  const { run, sess, act, open, onOpen } = p;
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  const seen = useRef(new Set<string>());
  const ids = run.open.map((r) => (r.data as { id: string }).id);
  const steer = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now);
  const phase = PHASE[run.phase];
  // ponytail: the budget shown is the open file's; step N of M counts as the agent's header does.
  const items = p.budget ? meter(run, p.budget, now) : [];
  const near = items.find((i) => i.key === 'turns' && i.level === 'near');
  const words = (p.starting ?? phase.words(run, p.pos)) + (!p.starting && near ? ` · Near the turn budget: ${run.turns} of ${p.budget!.turns}.` : '');
  useEffect(() => {
    if (!run.live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.live, run.runId]);
  useEffect(() => {
    if (ids.some((q) => !seen.current.has(q))) onOpen(true);
    for (const q of ids) seen.current.add(q);
  }, [ids.join('|')]);
  useLayoutEffect(() => {
    if (!open || !(moveFocus.current || document.activeElement === document.body)) return;
    const box = steer.current && !steer.current.disabled ? steer.current : undefined;
    (body.current?.querySelector<HTMLButtonElement>('.qcard button') ?? box ?? toggle.current)?.focus({ preventScroll: true });
    moveFocus.current = false;
  }, [ids.join('|'), open]);
  // ponytail: a steer that races the session going idle starts a plain chat turn (session.ts card()); a steer left unsent comes back in the Composer.
  const working = sess.status === 'running' || sess.status === 'waiting';
  const send = (kind: 'steer' | 'now' | 'stop') => {
    setError(undefined);
    const text = kind === 'stop' ? '' : draft.trim();
    sendCard(sess.id, kind, text)
      .then(() => { if (kind !== 'stop') setDraft((d) => (d.trim() === text ? '' : d)); }) // text typed since the send stays
      .catch((e: Error) => setError(e.message));
  };
  return <section className="sx-dock" aria-label="Run">
    <div className="sx-dockline">
      <span className="sx-dockstatus" role="status" title={words}>{words}</span>
      {/* an ended run's status line already says its turns, time and cost */}
      {!phase.ended && items.map((i) => <span key={i.key} className={`sx-meter ${i.level === 'ok' ? '' : 'warn'}`} title={i.text}>{i.text}</span>)}
      {!p.match && run.stepsAtStart && <span className="sx-docknotice" role="note">The file changed since this run started; marks are hidden.</span>}
      <button onClick={p.onChat}>Chat</button>
      <button ref={toggle} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => onOpen(!open)}>{open ? 'Hide the run' : 'Show the run'}</button>
    </div>
    {open && <div className="sx-dockbody" id={id} ref={body}>
      {run.open.map((row) => <QuestionCard key={(row.data as { id: string }).id} row={row} sess={sess} answer={(qid, answer) => {
        moveFocus.current = true;
        return act.answer(qid, answer).catch((e) => { moveFocus.current = false; throw e; });
      }} />)}
      {run.last && <p className="sx-latest" title={run.last.text}>{run.last.text}</p>}
      {!phase.ended && <form className="sx-steer" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) send('steer'); }}>
        <textarea ref={steer} aria-label="Steer the agent" rows={1} value={draft} disabled={!working} placeholder="Steer the agent (sent as a card)…"
          onChange={(e) => { setDraft(e.target.value); setError(undefined); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (draft.trim()) send('steer'); } }} />
        <button type="submit" disabled={!working || !draft.trim()}>Send</button>
        <button type="button" disabled={!working || !draft.trim()} title="Interrupt the agent and deliver this card now" onClick={() => send('now')}>Now</button>
        <button type="button" className="danger" disabled={!working} title="Stop the run" onClick={() => send('stop')}>Stop</button>
      </form>}
      {error && !phase.ended && <div className="bad" role="alert">{error}</div>}
      {run.cards.length > 0 && <ul className="sx-cards" aria-label="Cards sent">
        {run.cards.map((c, i) => <li key={i}><span className="sx-cardtext" title={c.text}>“{c.text}”</span> <span className="sx-cardstate">{CARD_STATE[c.state]}</span></li>)}
      </ul>}
      {phase.ended && <>
        {run.receipt && <dl className="sx-dockreceipt">{receiptFields(run.receipt).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
        <div className="btns">
          {phase.resumable && sess.status === 'idle' && run.runId && <button onClick={() => act.resume(run.runId!)}>Resume</button>}
          <button onClick={p.onDismiss}>Dismiss</button>
        </div>
      </>}
    </div>}
  </section>;
}
