import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject, type UIEvent } from 'react';
import { isOpen, KNOT, knotName, knotParts, type Feed as FeedData, type Knot, type Piece } from './feed.js';
import { renderRow, type Actions, type Ctx } from './rows.js';
import { PHASE, type RunView } from './runState.js';
import type { Sess } from './state.js';

// ponytail: history never animates (Batch 4 keys motion by seq at mount); open / closed choices live in Chat's memory; a collapsed knot renders no beads, so find-in-page does not see them.
// Tab stops: one per knot toggle and per "Blocks ↗", plus every open bead's summary and card control (a long open turn has many). "Blocks ↗" works only from the newest run; whether the open buffer still matches is known only on arrival in Blocks (Chat has no buffer).
type Run = Extract<Piece, { type: 'run' }>;
const EARLIER = 'An earlier run: only the newest run links to its blocks.';
const id = (key: string) => `sx-${key.replace(/[^\w-]/g, '_')}`;

function Beads({ rows, ctx }: { rows: Knot['beads']; ctx: Ctx }) {
  return <>{rows.map((r) => {
    const el = renderRow(r, ctx);
    return el === null ? null : <li className="sx-bead" key={r.seq} data-seq={r.seq}>{el}</li>;
  })}</>;
}

function KnotView({ k, newest, open, ctx, note, onToggle, onBlock }: {
  k: Knot; newest: boolean; open: boolean; ctx: Ctx; note: string; onToggle(key: string, next: boolean): void; onBlock(runId: string, step: string): void;
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
    <li className="sx-knot" data-knot={k.key} data-state={k.state} data-kind={k.kind} style={{ '--depth': k.depth } as CSSProperties}>
      <span className="sx-seg" aria-hidden="true" />
      <span className={`sx-dot sx-m-${KNOT[k.state].mark}`} aria-hidden="true" />
      <div className="sx-knotrow">
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
      {open && <ol className="sx-track" id={id(k.key)} ref={track}><Beads rows={k.beads} ctx={ctx} /></ol>}
    </li>
  );
}

function Strand({ s, run, ctx, open, onToggle, onBlock }: {
  s: Run; run: RunView; ctx: Ctx; open: Record<string, boolean>; onToggle(key: string, next: boolean): void; onBlock(runId: string, step: string): void;
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
          : <li className="sx-bead" key={it.row.seq}>{renderRow(it.row, ctx)}</li>)}
        {s.end.map((r) => <li className="sx-bead" key={r.seq}>{renderRow(r, ctx)}</li>)}
      </ol>
    </li>
  );
}

interface PieceProps { ctx: Ctx; run: RunView; open: Record<string, boolean>; onToggle(key: string, next: boolean): void; onBlock(runId: string, step: string): void }
// One renderer per piece type (feed.ts): a table, not a chain.
const PIECES: { [T in Piece['type']]: (p: Extract<Piece, { type: T }>, c: PieceProps) => ReactNode } = {
  note: (p, c) => <li className="sx-note" key={p.row.seq}>{renderRow(p.row, c.ctx)}</li>,
  bead: (p, c) => <li className="sx-bead sx-loose-bead" key={p.row.seq}>{renderRow(p.row, c.ctx)}</li>,
  turn: ({ knot: k }, c) => {
    const t = knotParts(k);
    return (
      <li className="sx-turn" key={k.key} data-state={k.state}>
        <h3 className="sx-khead"><span className="sx-ktitle">{t.title}</span><span className="sx-kstate">{t.state}</span><span className="sx-krest">{t.rest}</span></h3>
        <ol className="sx-track"><Beads rows={k.beads} ctx={c.ctx} /></ol>
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
  const c: PieceProps = { ctx: { sess, act, card: f.cards }, run, open, onToggle, onBlock };
  return (
    <div className="log sx-feed" ref={logRef} onScroll={onScroll} role="region" aria-label="Run log" tabIndex={0}>
      {f.pieces.length === 0 && <p className="hint sx-hint">Say something to start.</p>}
      <ol className="sx-rein">
        {f.pieces.map((p) => (PIECES[p.type] as (p: Piece, c: PieceProps) => ReactNode)(p, c))}
      </ol>
    </div>
  );
}