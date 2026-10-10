// The Reins feed's grouping (pure, no React, no DOM): the run is a rein, its steps are knots on it, what the agent does in a step hangs under the knot.
import type { LogRow } from '@reins/server/store.js';
import { KINDS } from './canvasKinds.js';
import { drawable } from './rows/hidden.js';
import type { RunView } from './runState.js';
import { STATE_WORDS } from './stepStatus.js';

export type KnotState = 'running' | 'waiting' | 'done' | 'failed' | 'stuck' | 'stopped' | 'paused';
export interface Knot {
  key: string;                       // `${runId}:${n}` (n per run id, continues across a resume) or `turn:${seq}`
  type: 'step' | 'turn';
  runId?: string; step?: string; kind?: string; title: string; depth: number; pass: number; // pass 2 = "2nd time"
  state: KnotState; why?: string; asking: boolean; // asking: holds an open question: forced open
  running: boolean;                  // the knot of view.current.at(-1) in the newest live strand, while it runs: working bead, flow
  start: number; end?: number;       // row ts (display only; order is by seq)
  cost: number; tools: { count: number; one?: string };
  beads: LogRow[]; first: number;    // drawable rows; seq of the opening row
}
export type CardState = { state: 'queued' | 'mid-turn' | 'next-turn' | 'interrupt' | 'unsent'; landed?: string };
export type Piece =
  | { type: 'note'; row: LogRow }                       // a user message pinned to the rein
  | { type: 'bead'; row: LogRow }                       // a loose bead between knots
  | { type: 'turn'; knot: Knot }                        // a plain turn (no toggle)
  | { type: 'run'; runId: string; workflow: string; newest: boolean; state: KnotState | 'live';
      items: Array<{ knot: Knot } | { row: LogRow }>;   // knots and mid-strand beads (run_detached, notes) in seq order
      end: LogRow[] };                                  // the receipt
export interface Feed { pieces: Piece[]; now?: Knot; cards: Map<number, CardState> }

// ponytail: re-walks every row once per 16 ms batch (as mergeOutput does); make it incremental if a 5,000-row log is slow. A loop's passes are separate knots ("2nd time"); a `use` block's inner steps are knots named by their prefixed ids; rows are placed by the cursor (the strand's current knot).
type Data = Record<string, any>;
type Run = Extract<Piece, { type: 'run' }>;
type Ended = { state: 'done' | 'stopped' | 'paused' | 'failed'; why?: string; ts: number };
interface Strand { piece: Run; steps: Array<{ id: string; kind?: string; title?: string }>; v2: boolean; n: number; knots: Knot[]; cur?: Knot; ended?: Ended }
interface Walk {
  pieces: Piece[]; strands: Map<string, Strand>; plain?: Knot; plains: number; cards: Map<number, CardState>;
  queued: Array<{ seq: number; text: string; scope: string }>; // cards waiting for their delivery, first in first out; scope = run id or '' (plain)
  evidence: Map<Knot, { state: 'failed' | 'stuck'; why?: string }>;
}
// a structural handler returns true when the row is consumed (it is not a bead)
type Fold = (w: Walk, row: LogRow, x: Data, s?: Strand) => boolean;

const data = (r: LogRow) => (r.data ?? {}) as Data;
const ENDED: Record<Ended['state'], KnotState> = { done: 'done', stopped: 'stopped', paused: 'paused', failed: 'failed' };

export const KNOT: Record<KnotState, { words: string; open: boolean; mark: 'dot' | 'ring' | 'broken' | 'square' | 'hollow' }> = {
  running: { words: STATE_WORDS.active, open: true, mark: 'dot' },
  waiting: { words: STATE_WORDS.waiting, open: true, mark: 'ring' },
  done: { words: STATE_WORDS.done, open: false, mark: 'dot' },
  failed: { words: STATE_WORDS.failed, open: true, mark: 'broken' },
  stuck: { words: STATE_WORDS.stuck, open: true, mark: 'broken' },
  stopped: { words: STATE_WORDS.stopped, open: true, mark: 'square' },
  paused: { words: STATE_WORDS.paused, open: true, mark: 'hollow' },
};

/** A plain turn is never collapsed; a knot holding an open question is always open; else the user's choice, else its state's default. */
export const isOpen = (k: Knot, choice: boolean | undefined): boolean => k.type === 'turn' || k.asking || (choice ?? KNOT[k.state].open);

export function ordinal(n: number): string {
  const t = n % 100;
  return `${n}${t >= 11 && t <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 1) return '<1 s';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};

/** The visible words of a knot in three runs, so the component can colour the state: title, ` · state …`, ` · cost · tools · pass`. */
export function knotParts(k: Knot): { title: string; state: string; rest: string } {
  const words = KNOT[k.state].words + (k.why ? ` (${k.why})` : '');
  if (k.type === 'turn') return { title: k.title, state: ` · ${words}`, rest: k.cost > 0 ? ` · $${k.cost.toFixed(4)}` : '' };
  const dur = k.end !== undefined ? duration(k.end - k.start) : undefined;
  const worked = k.cost > 0 || k.tools.count > 0;
  const state = !dur ? words : k.state === 'done' && worked ? `${words} in ${dur}` : `${words} · ${dur}`;
  const rest = [
    ...(k.cost > 0 ? [`$${k.cost.toFixed(4)}`] : []),
    ...(k.tools.count === 1 ? [`used ${k.tools.one}`] : k.tools.count > 1 ? [`used ${k.tools.count} tools`] : []),
    ...(k.pass > 1 ? [`${ordinal(k.pass)} time`] : []),
  ];
  return { title: k.title, state: ` · ${state}`, rest: rest.map((r) => ` · ${r}`).join('') };
}
export const knotLine = (k: Knot): string => { const p = knotParts(k); return p.title + p.state + p.rest; };
/** The toggle's accessible name: it contains the visible text, and adds the id (when the title differs) and the run's age. */
export function knotName(k: Knot, older: boolean): string {
  if (k.type === 'turn') return knotLine(k);
  const p = knotParts(k);
  return `Step ${p.title}${k.step !== undefined && k.step !== p.title ? ` (${k.step})` : ''}${p.state}${p.rest}${older ? ' (earlier run)' : ''}`;
}

const blank = (key: string, type: Knot['type'], title: string, row: LogRow): Knot => ({
  key, type, title, depth: 0, pass: 1, state: 'running', asking: false, running: false, start: row.ts, cost: 0, tools: { count: 0 }, beads: [], first: row.seq,
});

function strandOf(w: Walk, row: LogRow): Strand {
  let s = w.strands.get(row.runId!);
  if (!s) {
    const piece: Run = { type: 'run', runId: row.runId!, workflow: '', newest: false, state: 'live', items: [], end: [] };
    s = { piece, steps: [], v2: false, n: 0, knots: [] };
    w.strands.set(row.runId!, s);
    w.pieces.push(piece);
  }
  return s;
}

function openKnot(s: Strand, row: LogRow, step: string, parents: string[], kind?: string): Knot {
  const decl = s.steps.find((d) => d.id === step);
  const k = kind ?? decl?.kind;
  const label = k !== undefined ? (KINDS as Record<string, { card?: { label: string } }>)[k]?.card?.label : undefined;
  const knot: Knot = {
    ...blank(`${row.runId}:${++s.n}`, 'step', decl?.title ?? label ?? step, row),
    runId: row.runId!, step, depth: Math.min(parents.length, 3), pass: s.knots.filter((x) => x.step === step).length + 1,
    ...(k !== undefined ? { kind: k } : {}),
  };
  s.knots.push(knot);
  s.piece.items.push({ knot });
  s.cur = knot;
  return knot;
}
const latest = (s: Strand, step: unknown) => s.knots.filter((k) => k.step === step).at(-1);

function openPlain(w: Walk, row: LogRow): Knot {
  const k = blank(`turn:${row.seq}`, 'turn', `Turn ${++w.plains}`, row);
  w.plain = k;
  w.pieces.push({ type: 'turn', knot: k });
  return k;
}
function closePlain(w: Walk, ts: number, state: KnotState, why?: string) {
  const k = w.plain;
  if (!k) return;
  Object.assign(k, { state, end: ts }, why !== undefined ? { why } : {});
  w.plain = undefined;
}

// A card waits for its delivery, first in first out by text, inside its own run (or the plain thread).
function deliver(w: Walk, scope: string, text: unknown, state: CardState['state'], landed?: string): boolean {
  const i = w.queued.findIndex((c) => c.scope === scope && c.text === text);
  if (i < 0) return false;
  w.cards.set(w.queued[i]!.seq, { state, ...(landed !== undefined ? { landed } : {}) });
  w.queued.splice(i, 1);
  return true;
}
const delivery: Fold = (w, _row, x, s) => deliver(w, s?.piece.runId ?? '', x.card, x.channel === 'next-turn' || x.channel === 'interrupt' ? x.channel : 'mid-turn', s?.cur?.step);

const endOf = (state: Ended['state']): Fold => (_w, row, x, s) => {
  if (s) { s.ended = { state, ts: row.ts, ...(typeof x.error === 'string' ? { why: x.error } : {}) }; s.cur = undefined; }
  return true;
};

// Structural rows, keyed by type or `engine:<sub-type>`. They run BEFORE the drawable filter: a hidden command_result still fails its knot.
export const ROLE: Record<string, Fold> = {
  message: (w, row, x) => {
    closePlain(w, row.ts, 'stopped'); // a message is only logged when nothing is in flight: an open turn never ended
    if (x.fromCards === true) for (const c of [...w.queued]) if (c.scope === '' && typeof x.text === 'string' && x.text.includes(c.text)) deliver(w, '', c.text, 'next-turn');
    w.pieces.push({ type: 'note', row });
    return true;
  },
  status: (w, row, x) => { if (x.status === 'idle' || x.status === 'closed') closePlain(w, row.ts, 'stopped'); return false; },
  run_started: (_w, _row, x, s) => {
    if (s) {
      if (typeof x.workflow === 'string') s.piece.workflow = x.workflow;
      if (Array.isArray(x.steps)) s.steps = x.steps.filter((d: Data) => typeof d?.id === 'string').map((d: Data) => ({ id: d.id, kind: d.kind, title: d.title }));
    }
    return true;
  },
  step_started: (_w, row, x, s) => {
    if (s && typeof x.step === 'string') {
      s.v2 = true;
      openKnot(s, row, x.step, Array.isArray(x.parents) ? x.parents : [], typeof x.kind === 'string' ? x.kind : undefined);
    }
    return true;
  },
  // older logs have no step_started: the first turn or gate of a step opens its knot
  turn_started: (_w, row, x, s) => { if (s && !s.v2 && typeof x.step === 'string' && s.cur?.step !== x.step) openKnot(s, row, x.step, []); return true; },
  gate_paused: (_w, row, x, s) => { if (s && !s.v2 && typeof x.step === 'string' && s.cur?.step !== x.step) openKnot(s, row, x.step, []); return true; },
  turn_ended: (w, row, x, s) => {
    if (s) { const k = latest(s, x.step) ?? s.cur; if (k && typeof x.cost === 'number') k.cost += x.cost; return true; }
    const k = w.plain ?? openPlain(w, row);
    if (typeof x.cost === 'number') k.cost += x.cost;
    closePlain(w, row.ts, 'done');
    return true;
  },
  turn_failed: (w, row, x, s) => {
    if (s) return true;
    w.plain ??= openPlain(w, row);
    closePlain(w, row.ts, 'failed', String(x.error ?? '').slice(0, 160));
    return true;
  },
  gate_approved: () => true,
  run_resumed: () => true,
  loop_iteration: () => true,
  link_budget_exceeded: () => true,
  verify_result: (w, _row, x, s) => { if (s?.cur && x.pass === false) w.evidence.set(s.cur, { state: 'failed', why: 'verify' }); return true; },
  command_result: (w, _row, x, s) => {
    const k = s && latest(s, x.step);
    if (k && typeof x.exitCode === 'number') { if (x.exitCode !== 0) w.evidence.set(k, { state: 'failed', why: `exit ${x.exitCode}` }); else w.evidence.delete(k); }
    return true;
  },
  loop_budget_exceeded: (w, _row, x, s) => { const k = s && latest(s, x.step); if (k) w.evidence.set(k, { state: 'stuck' }); return true; },
  run_finished: endOf('done'),
  run_stopped: endOf('stopped'),
  // a detach stays a bead in the middle of the strand (Resume lives on it)
  run_detached: (w, row, x, s) => { endOf(typeof x.error === 'string' ? 'failed' : 'paused')(w, row, x, s); return false; },
  receipt: (_w, row, _x, s) => { s?.piece.end.push(row); return !!s; },
  card_queued: (w, row, x, s) => {
    if ((x.kind === 'steer' || x.kind === 'now') && x.source !== 'auto') {
      w.queued.push({ seq: row.seq, text: String(x.card ?? ''), scope: s?.piece.runId ?? '' });
      w.cards.set(row.seq, { state: 'queued' });
    }
    return false;
  },
  card_delivered: delivery,
  'engine:card_delivered': delivery,
  cards_unsent: (w, _row, x) => {
    if (Array.isArray(x.cards)) {
      for (const text of x.cards) {
        const i = w.queued.findIndex((c) => c.scope === '' && c.text === text);
        const j = i >= 0 ? i : w.queued.map((c) => c.text).lastIndexOf(text);
        if (j >= 0) { w.cards.set(w.queued[j]!.seq, { state: 'unsent' }); w.queued.splice(j, 1); }
      }
    }
    return false;
  },
};
// rows that open a plain turn when none is open (a question or a note never does)
const OPENS = new Set(['engine', 'say']);

function place(w: Walk, row: LogRow, s?: Strand) {
  if (s) {
    if (!s.cur) { s.piece.items.push({ row }); return; }
    s.cur.beads.push(row);
    const e = data(row);
    if (row.type === 'engine' && e.type === 'tool_call') {
      s.cur.tools.count += 1;
      if (s.cur.tools.count === 1) s.cur.tools.one = String(e.tool ?? 'a tool'); else delete s.cur.tools.one;
    }
    return;
  }
  const k = w.plain ?? (OPENS.has(row.type) ? openPlain(w, row) : undefined);
  if (!k) { w.pieces.push({ type: 'bead', row }); return; }
  k.beads.push(row);
  const e = data(row);
  if (row.type === 'engine' && e.type === 'tool_call') {
    k.tools.count += 1;
    if (k.tools.count === 1) k.tools.one = String(e.tool ?? 'a tool'); else delete k.tools.one;
  }
}

/** One walk in seq order (never by ts) over the merged rows. */
export function feed(rows: LogRow[], view: RunView, openQuestions: ReadonlySet<string>): Feed {
  const w: Walk = { pieces: [], strands: new Map(), plains: 0, cards: new Map(), queued: [], evidence: new Map() };
  for (const row of rows) {
    const x = data(row);
    const key = row.type === 'engine' ? `engine:${x.type}` : row.type;
    const s = row.runId !== undefined ? strandOf(w, row) : undefined;
    const role: Fold | undefined = ROLE[key];
    // a later row of the same run id (a resume's note, the next step) clears the strand's end; the receipt hangs after it
    if (s?.ended && row.type !== 'receipt' && (role !== undefined || drawable(row))) s.ended = undefined;
    if (role?.(w, row, x, s)) continue;
    if (!drawable(row)) continue;
    place(w, row, s);
  }

  let now: Knot | undefined;
  for (const s of w.strands.values()) {
    const live = s.piece.runId === view.runId && view.live;
    const current = live ? view.current.at(-1) : undefined;
    const last = new Map(s.knots.map((k) => [k.step, k]));
    s.knots.forEach((k, i) => {
      const next = s.knots[i + 1];
      const viewed = live && last.get(k.step) === k ? view.steps[k.step!] : undefined;
      const ev = w.evidence.get(k);
      k.asking = k.beads.some((r) => r.type === 'question' && openQuestions.has(String(data(r).id)));
      if (next) k.end = next.start; else if (s.ended) k.end = s.ended.ts;
      if (viewed?.state) {
        k.state = viewed.state === 'active' ? 'running' : viewed.state;
        if (viewed.why) k.why = viewed.why;
      } else if (ev) { k.state = ev.state; if (ev.why) k.why = ev.why; }
      else if (!next && s.ended) { k.state = ENDED[s.ended.state]; if (s.ended.why) k.why = s.ended.why; }
      else k.state = next ? 'done' : live ? 'running' : 'stopped';
      if (current !== undefined && last.get(current) === k) { now = k; k.running = k.state === 'running'; }
    });
    s.piece.newest = s.piece.runId === view.runId;
    s.piece.state = live ? 'live' : s.ended ? ENDED[s.ended.state] : 'stopped';
  }
  const open = w.plain;
  if (open) {
    open.asking = open.beads.some((r) => r.type === 'question' && openQuestions.has(String(data(r).id)));
    open.running = true;
    now ??= open;
  }
  return { pieces: w.pieces, ...(now ? { now } : {}), cards: w.cards };
}
