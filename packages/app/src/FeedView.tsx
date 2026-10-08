import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject, type UIEvent } from 'react';
import { isOpen, KNOT, knotName, knotParts, type Feed as FeedData, type Knot, type Piece } from './feed.js';
import { renderRow, type Actions, type Ctx } from './rows.js';
import { PHASE, type RunView } from './runState.js';
import { isFresh, type Sess } from './state.js';

// ponytail: five cues only; ink-in, glow, clip-on, pop and tool icons were cut for v1 (review); history never animates (replay boundary and seq at mount). Open / closed choices live in Chat's memory; a collapsed knot renders no beads, so find-in-page does not see them.
// Tab stops: one per knot toggle and per "Blocks ↗", plus every open bead's summary and card control (a long open turn has many). "Blocks ↗" works only from the newest run; whether the open buffer still matches is known only on arrival in Blocks (Chat has no buffer).
type Run = Extract<Piece, { type: 'run' }>;
const EARLIER = 'An earlier run: only the newest run links to its blocks.';
const id = (key: string) => `sx-${key.replace(/[^\w-]/g, '_')}`;

type BeadCtx = Ctx & { animated: Set<number> };
function Bead({ row, ctx }: { row: Knot['beads'][number]; ctx: BeadCtx }) {
  const [fresh] = useState(() => isFresh(ctx.sess, row.seq, ctx.seenSeq) && !ctx.animated.has(row.seq));
  useEffect(() => { ctx.animated.add(row.seq); }, [row.seq, ctx.animated]);
  return <li className={`sx-bead${fresh ? ' sx-new' : ''}`} data-seq={row.seq}>{renderRow(row, ctx)}</li>;
}
export function Elapsed({ since }: { since: number }): ReactNode {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <span className="sx-elapsed" aria-hidden="true"> · {Math.max(0, Math.floor((now - since) / 1000))} s</span>;
}
function Beads({ rows, ctx, working = false }: { rows: Knot['beads']; ctx: BeadCtx; working?: boolean }) {
  const last = rows.at(-1);
  const text = last?.type === 'engine' && (last.data as { type: string }).type === 'text';
  return <>{rows.map((row) => <Bead row={row} ctx={ctx} key={row.seq} />)}
    {working && !text && <li className="sx-bead sx-working"><span className="sx-wave" aria-hidden="true">⌁</span> working…</li>}
  </>;
}

const KnotView = memo(function KnotView({ k, newest, open, ctx, note, onToggle, onBlock }: {
  k: Knot; newest: boolean; open: boolean; ctx: BeadCtx; note: string; onToggle(key: string, next: boolean): void; onBlock(runId: string, step: string): void;
}) {
  const track = useRef<HTMLOListElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  // A knot that collapses by itself (its state turned done) takes a focused bead with it: the focus goes to its toggle instead of the page.
  const was = useRef(open);
  const lost = useRef(false);
  if (was.current && !open) lost.current = !!track.current?.contains(document.activeElement);
  was.current = open;
  useLayoutEffect(() => { if (lost.current) { lost.current = false; toggle.current?.focus({ preventScroll: true }); } });

  const p = knotParts(k);
  const named = k.step !== undefined && k.step !== p.title ? k.step : undefined;
  const title = named === undefined ? p.title : `${p.title} (${named})`;
  return (
    <li className="sx-knot" data-knot={k.key} data-state={k.state} data-running={k.running || undefined} data-kind={k.kind} style={{ '--depth': k.depth } as CSSProperties}>
      <div className="sx-knotrow">
        <span className="sx-seg" aria-hidden="true" />
        <span className={`sx-dot sx-m-${KNOT[k.state].mark}`} aria-hidden="true" />
        <button ref={toggle} className="sx-kbtn" aria-label={knotName(k, !newest)} aria-expanded={open} aria-controls={open ? id(k.key) : undefined}
          aria-disabled={k.asking || undefined} title={k.asking ? 'Answer the question below first' : undefined}
          onClick={() => { if (!k.asking) onToggle(k.key, !open); }}>
          <span className="sx-ktitle">{p.title}</span><span className="sx-kstate">{p.state}</span><span className="sx-krest">{p.rest}</span>
          <span className="sx-chev" aria-hidden="true" />
        </button>
        <button className="sx-kblk" aria-label={`Show ${title} in Blocks${newest ? '' : ' (earlier run)'}`} aria-disabled={!newest || undefined} aria-describedby={newest ? undefined : note}
          title={newest ? undefined : EARLIER} onClick={() => { if (newest && k.runId !== undefined && k.step !== undefined) onBlock(k.runId, k.step); }}>
          Blocks<span aria-hidden="true"> ↗</span>
        </button>
      </div>
      {open && <ol className="sx-track" id={id(k.key)} ref={track}><Beads rows={k.beads} ctx={{ ...ctx, running: k.running }} working={k.running} /></ol>}
    </li>
  );
}, (a, b) => a.k.key === b.k.key && a.k.state === b.k.state && a.open === b.open && a.k.asking === b.k.asking
  && a.k.running === b.k.running && a.k.end === b.k.end && a.k.why === b.k.why && a.k.cost === b.k.cost
  && a.k.tools.count === b.k.tools.count && a.newest === b.newest && a.k.beads.length === b.k.beads.length
  && a.k.beads.every((r, i) => r === b.k.beads[i] && a.ctx.card?.get(r.seq)?.state === b.ctx.card?.get(r.seq)?.state && a.ctx.card?.get(r.seq)?.landed === b.ctx.card?.get(r.seq)?.landed)
  && a.ctx.sess.calls === b.ctx.sess.calls && a.ctx.sess.answers === b.ctx.sess.answers && a.ctx.sess.closed === b.ctx.sess.closed);

function Strand({ s, run, ctx, open, onToggle, onBlock }: {
  s: Run; run: RunView; ctx: BeadCtx; open: Record<string, boolean>; onToggle(key: string, next: boolean): void; onBlock(runId: string, step: string): void;
}) {
  const words = s.state === 'live' ? PHASE[run.phase].words(run) : s.newest && PHASE[run.phase].ended ? PHASE[run.phase].words(run) : KNOT[s.state].words;
  const note = `sx-note-${s.runId}`;
  return (
    <li className="sx-strand" data-run={s.runId} data-state={s.state}>
      <div className="sx-head">
        <span className="sx-hmark" aria-hidden="true" />
        <b>Workflow {s.workflow}</b><span className="sx-hwords"> · {words.replace(/`/g, '')}</span>
        {!s.newest && <span className="sx-hnote" id={note}>{EARLIER}</span>}
      </div>
      <ol className="sx-knots">
        {s.items.map((it) => 'knot' in it
          ? <KnotView key={it.knot.key} k={it.knot} newest={s.newest} open={isOpen(it.knot, open[it.knot.key])} ctx={ctx} note={note} onToggle={onToggle} onBlock={onBlock} />
          : <Bead row={it.row} ctx={ctx} key={it.row.seq} />)}
        {s.end.map((row) => <Bead row={row} ctx={ctx} key={row.seq} />)}
      </ol>
    </li>
  );
}

interface PieceProps { ctx: BeadCtx; run: RunView; open: Record<string, boolean>; onToggle(key: string, next: boolean): void; onBlock(runId: string, step: string): void }
// One renderer per piece type (feed.ts): a table, not a chain.
const PIECES: { [T in Piece['type']]: (p: Extract<Piece, { type: T }>, c: PieceProps) => ReactNode } = {
  note: (p, c) => <li className="sx-note" key={p.row.seq}>{renderRow(p.row, c.ctx)}</li>,
  bead: (p, c) => <Bead row={p.row} ctx={c.ctx} key={p.row.seq} />,
  turn: ({ knot: k }, c) => {
    const t = knotParts(k);
    return (
      <li className="sx-turn" key={k.key} data-knot={k.key} data-state={k.state}>
        <h3 className="sx-khead" tabIndex={-1}><span className="sx-ktitle">{t.title}</span><span className="sx-kstate">{t.state}</span><span className="sx-krest">{t.rest}</span></h3>
        <ol className="sx-track"><Beads rows={k.beads} ctx={{ ...c.ctx, running: k.running }} working={k.running} /></ol>
      </li>
    );
  },
  run: (p, c) => <Strand key={p.runId} s={p} run={c.run} ctx={c.ctx} open={c.open} onToggle={c.onToggle} onBlock={c.onBlock} />,
};

/** The Chat log as a rein: notes, plain turns and workflow strands of knots, beads under each knot. Thin: the grouping is feed.ts. */
export function Feed({ f, sess, run, act, open, onToggle, onBlock, logRef, onScroll }: {
  f: FeedData; sess: Sess; run: RunView; act: Actions; open: Record<string, boolean>; onToggle(key: string, next: boolean): void;
  onBlock(runId: string, step: string): void;
  logRef: RefObject<HTMLDivElement | null>; onScroll(e: UIEvent<HTMLDivElement>): void;
}) {
  const seenSeq = useRef(sess.lastSeq);
  const animated = useRef(new Set<number>());
  const handlers = useRef({ act, onToggle, onBlock });
  handlers.current = { act, onToggle, onBlock };
  const stable = useMemo(() => ({
    onToggle: (key: string, next: boolean) => handlers.current.onToggle(key, next),
    onBlock: (runId: string, step: string) => handlers.current.onBlock(runId, step),
    act: { answer: (qid: string, answer: string) => handlers.current.act.answer(qid, answer), resume: (rid: string) => handlers.current.act.resume(rid) },
  }), []);
  const c: PieceProps = { ctx: { sess, act: stable.act, card: f.cards, seenSeq: seenSeq.current, animated: animated.current }, run, open, onToggle: stable.onToggle, onBlock: stable.onBlock };
  const now = f.now ? `Now: ${f.now.title} · ${KNOT[f.now.state].words}` : '';
  const jump = () => {
    const target = f.now && logRef.current?.querySelector<HTMLElement>(`[data-knot="${CSS.escape(f.now.key)}"] :is(.sx-kbtn, .sx-khead)`);
    if (target) { target.scrollIntoView({ block: 'start' }); target.focus({ preventScroll: true }); }
  };
  return (
    <div className="log sx-feed" ref={logRef} onScroll={onScroll} role="region" aria-label="Run log" tabIndex={0}>
      <div className="sx-nowbar"><span role="status">{now}</span>{f.now && <button onClick={jump}>{now}<Elapsed since={f.now.start} /></button>}</div>
      {f.pieces.length === 0 && <p className="hint sx-hint">Say something to start.</p>}
      <ol className="sx-rein">
        {f.pieces.map((p) => (PIECES[p.type] as (p: Piece, c: PieceProps) => ReactNode)(p, c))}
      </ol>
    </div>
  );
}
