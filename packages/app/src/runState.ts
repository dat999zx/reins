import type { Receipt, Workflow } from '@reins/core';
import { flatSteps } from './canvas.js';
import type { LogRow } from '@reins/server/store.js';
import { openQuestions, type Sess } from './state.js';
import { runRows, stepStatus, type StepMap } from './stepStatus.js';

export type RunPhase = 'none' | 'busy' | 'running' | 'waiting' | 'done' | 'stopped' | 'paused' | 'failed';
export interface RunCard { text: string; kind: 'steer' | 'now'; state: 'queued' | 'delivered' | 'unsent' }
export interface Pos { n: number; m: number }
export interface RunView {
  runId?: string; workflow?: string; live: boolean; phase: RunPhase;
  stepsAtStart?: Array<{ id: string; kind: string; title?: string }>;
  steps: StepMap;
  current: string[];
  endedAt?: string;
  went: Array<{ from: string; to: string }>;
  open: LogRow[];
  cards: RunCard[];
  receipt?: Receipt; error?: string;
  turns: number; cost: number; startedAt?: number; endedTs?: number;
  last?: { seq: number; text: string };
  stepOf: Map<number, string>;
  thinking?: number;                 // tokens, while the newest engine row of the live run is a thinking row
}

type Data = Record<string, any>;
const data = (r: LogRow) => (r.data ?? {}) as Data;

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};
const tail = (v: RunView) => [
  `${v.turns} turn${v.turns === 1 ? '' : 's'}`,
  ...(v.startedAt !== undefined && v.endedTs !== undefined ? [clock(v.endedTs - v.startedAt)] : []),
  `$${v.cost.toFixed(4)}`,
];
export const thinkingWords = (tokens: number) => `thinking… ~${tokens.toLocaleString('en-US')} tokens`;
const where = (word: string, v: RunView) => (v.endedAt ? `${word} at \`${v.endedAt}\`` : word);

// ponytail: the newest run only; a history picker would pass a run id. Cards are matched by text, first in first out; `cards_unsent` by position (it has no run id).
export const PHASE: Record<RunPhase, { words: (v: RunView, pos?: Pos) => string; ended: boolean; resumable: boolean }> = {
  none: { words: () => '', ended: false, resumable: false },
  busy: { words: () => 'The agent is working (not a workflow run).', ended: false, resumable: false },
  running: {
    words: (v, pos) => `${v.current.length ? `Running \`${v.current.at(-1)}\`` : 'Running'}${pos ? ` · step ${pos.n} of ${pos.m}` : ''}${v.thinking !== undefined ? ` · ${thinkingWords(v.thinking)}` : ''}`,
    ended: false, resumable: false,
  },
  waiting: {
    words: (v) => {
      const kinds = v.open.map((r) => data(r).kind).filter((k): k is string => typeof k === 'string');
      return `Waiting for you${kinds.length ? ` · ${kinds.join(', ')} question` : ''}`;
    },
    ended: false, resumable: false,
  },
  done: { words: (v) => ['Done', ...tail(v)].join(' · '), ended: true, resumable: false },
  stopped: { words: (v) => [where('Stopped', v), ...tail(v)].join(' · '), ended: true, resumable: false },
  paused: { words: (v) => `${where('Left paused', v)}. Resume continues it.`, ended: true, resumable: true },
  failed: { words: (v) => `${where('Failed', v)}: ${v.error ?? 'the run failed'}`, ended: true, resumable: true },
};

interface Acc { v2: boolean; inTurn: boolean; started: string[] }
type Fold = (r: LogRow, x: Data, v: RunView, a: Acc) => void;

const begin = (v: RunView, path: string[]) => { v.current = path; delete v.endedAt; };
const setStep: Fold = (_r, x, v, a) => {
  if (typeof x.step === 'string' && !(a.v2 && v.current.at(-1) === x.step)) begin(v, [x.step]);
};
const ends: Fold = (_r, _x, v) => { v.endedAt = v.current.at(-1); v.current = []; delete v.error; }; // an old error goes with the next end; run_detached sets its own after
const delivered = (text: unknown, v: RunView) => {
  const c = v.cards.find((k) => k.state === 'queued' && k.text === text);
  if (c) c.state = 'delivered';
};
const ENGINE: Record<string, Fold> = {
  text: (r, x, v) => { v.last = { seq: r.seq, text: String(x.text ?? '') }; },
  card_delivered: (_r, x, v) => delivered(x.card, v),
};

const FOLD: Record<string, Fold> = {
  run_started: (r, x, v) => {
    v.startedAt ??= r.ts;
    if (Array.isArray(x.steps)) {
      v.stepsAtStart = x.steps.filter((s: Data) => typeof s?.id === 'string' && typeof s.kind === 'string')
        .map((s: Data) => ({ id: s.id, kind: s.kind, ...(typeof s.title === 'string' ? { title: s.title } : {}) }));
    }
  },
  step_started: (_r, x, v, a) => {
    if (typeof x.step !== 'string') return;
    a.v2 = true;
    const parents: string[] = Array.isArray(x.parents) ? x.parents.filter((p: unknown) => typeof p === 'string') : [];
    begin(v, [...parents, x.step]);
    a.started.push(x.step);
  },
  turn_started: (r, x, v, a) => { setStep(r, x, v, a); a.inTurn = true; },
  gate_paused: setStep,
  say: (r, x, v) => { v.last = { seq: r.seq, text: String(x.text ?? '') }; },
  turn_failed: (r, x, v) => { v.last = { seq: r.seq, text: String(x.error ?? '') }; },
  turn_ended: (_r, x, v) => { v.turns += 1; if (typeof x.cost === 'number') v.cost += x.cost; },
  card_queued: (_r, x, v) => {
    if ((x.kind === 'steer' || x.kind === 'now') && x.source !== 'auto') v.cards.push({ text: String(x.card ?? ''), kind: x.kind, state: 'queued' });
  },
  card_delivered: (_r, x, v) => delivered(x.card, v),
  engine: (r, x, v, a) => ENGINE[x.type as string]?.(r, x, v, a),
  receipt: (r, _x, v) => { v.receipt = r.data as Receipt; },
  run_finished: ends,
  run_stopped: ends,
  run_detached: (r, x, v, a) => {
    ends(r, x, v, a);
    if (typeof x.error === 'string') v.error = x.error;
  },
};
const END = new Set(['run_finished', 'run_stopped', 'run_detached']);

const thinkingRow = (r: LogRow) => r.type === 'engine' && data(r).type === 'thinking';

/** Seqs of the last thinking row of each burst: the thinking rows of one run with no other engine row between them. The parser emits several per burst; only the head draws. */
export function thinkingHeads(rows: LogRow[]): Set<number> {
  const heads = new Set<number>();
  let prev: LogRow | undefined;
  for (const r of rows) {
    if (r.type !== 'engine') continue;
    if (prev && thinkingRow(prev) && thinkingRow(r) && prev.runId === r.runId) heads.delete(prev.seq);
    if (thinkingRow(r)) heads.add(r.seq);
    prev = r;
  }
  return heads;
}

/** The newest engine row, when it is a thinking row: the agent is thinking right now (if the session is busy). */
export function thinkingNow(rows: LogRow[]): { seq: number; tokens: number } | undefined {
  const r = rows.filter((x) => x.type === 'engine').at(-1);
  return r && thinkingRow(r) && typeof data(r).tokens === 'number' ? { seq: r.seq, tokens: data(r).tokens } : undefined;
}

export function runView(s: Sess): RunView {
  const { rows, workflow, live } = runRows(s.rows);
  const v: RunView = {
    live, phase: 'none', steps: stepStatus(rows), current: [], went: [], open: openQuestions(s),
    cards: [], turns: 0, cost: 0, stepOf: new Map(),
    ...(workflow !== undefined ? { workflow } : {}), ...(rows.length ? { runId: rows[0]!.runId! } : {}),
  };
  const a: Acc = { v2: false, inTurn: false, started: [] };
  let finish: LogRow | undefined;
  let closeAt = -1;
  for (const r of rows) {
    FOLD[r.type]?.(r, data(r), v, a);
    const at = v.current.at(-1);
    if (at && (a.v2 || a.inTurn)) v.stepOf.set(r.seq, at);
    if (r.type === 'turn_ended' || r.type === 'turn_failed') a.inTurn = false;
    if (END.has(r.type)) { finish = r; v.endedTs = r.ts; }
    if (r.type === 'receipt' || r.type === 'run_detached') closeAt = r.seq;
  }
  v.went = a.started.flatMap((to, i) => (i > 0 && a.started[i - 1] !== to ? [{ from: a.started[i - 1]!, to }] : []));
  if (live) {
    delete v.endedTs;
    delete v.error; // resumed: the failure it left is history
    const t = thinkingNow(rows);
    if (t) v.thinking = t.tokens;
  }

  if (closeAt >= 0) {
    for (const r of s.rows) {
      if (r.seq <= closeAt || r.type !== 'cards_unsent' || r.runId !== undefined || !Array.isArray(data(r).cards)) continue;
      for (const text of data(r).cards as string[]) {
        const c = v.cards.find((k) => k.state === 'queued' && k.text === text);
        if (c) c.state = 'unsent'; else v.cards.push({ text, kind: 'steer', state: 'unsent' });
      }
    }
  }

  const working = s.status === 'running' || s.status === 'waiting';
  const lastSeq = rows.at(-1)?.seq ?? 0;
  const next = s.rows.some((r) => r.seq > lastSeq && (r.type === 'message' || r.type === 'question'));
  if (!rows.length) v.phase = working ? 'busy' : 'none';
  else if (live) v.phase = s.status === 'waiting' ? 'waiting' : 'running';
  else if (working && next) v.phase = 'busy';
  else v.phase = finish?.type === 'run_stopped' ? 'stopped' : finish?.type === 'run_detached' ? (v.error !== undefined ? 'failed' : 'paused') : 'done';
  return v;
}

export function sameSteps(a: Array<{ id: string; kind: string }>, b: Array<{ id: string; kind: string }>): boolean {
  return a.length === b.length && a.every((s, i) => s.id === b[i]!.id && s.kind === b[i]!.kind);
}

export function firstRowOf(v: RunView, rows: LogRow[], step: string): number | undefined {
  const have = new Set(rows.map((r) => r.seq));
  for (const [seq, id] of v.stepOf) if (id === step && have.has(seq)) return seq;
  return undefined;
}

export function stepPos(w: Workflow, current: string[]): Pos | undefined {
  const i = w.steps.findIndex((s) => flatSteps([s]).some((k) => current.includes(k.id)));
  return i < 0 ? undefined : { n: i + 1, m: w.steps.length };
}

export type MeterItem = { key: 'turns' | 'minutes' | 'usd'; text: string; level: 'ok' | 'near' | 'over'; enforced: boolean };
export function meter(v: RunView, budget: Workflow['budget'], now: number): MeterItem[] {
  const ms = Math.max(0, (v.endedTs ?? now) - (v.startedAt ?? now));
  const seconds = Math.floor(ms / 1000);
  const values: Array<{ key: MeterItem['key']; used: number; limit: number; text: string }> = [
    { key: 'turns', used: v.turns, limit: budget.turns, text: `${v.turns} / ${budget.turns} turns` },
    { key: 'minutes', used: ms / 60_000, limit: budget.minutes, text: `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s / ${budget.minutes}m` },
    ...(budget.usd === undefined ? [] : [{ key: 'usd' as const, used: v.cost, limit: budget.usd, text: `$${v.cost.toFixed(2)} / $${budget.usd.toFixed(2)}` }]),
  ];
  return values.map(({ key, used, limit, text }) => {
    const level = used >= limit ? 'over' : used >= limit * 0.8 ? 'near' : 'ok';
    const enforced = key === 'turns';
    return { key, text: text + (level === 'over' ? enforced ? ' · turn budget used: the run stops' : ' · over (not enforced)' : level === 'near' ? ' · near' : ''), level, enforced };
  });
}

export function didNotStart(rows: LogRow[], afterSeq: number): string | undefined {
  const after = rows.filter((r) => r.seq > afterSeq);
  if (after.some((r) => r.type === 'run_started')) return undefined;
  const busy = after.findIndex((r) => r.type === 'status' && ['running', 'waiting'].includes(data(r).status));
  if (busy < 0 || !after.slice(busy + 1).some((r) => r.type === 'status' && data(r).status === 'idle')) return undefined;
  const note = after.filter((r) => r.type === 'note' && typeof data(r).text === 'string').at(-1);
  return note ? String(data(note).text) : 'The run did not start.';
}
