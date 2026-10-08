import type { LogRow } from '@reins/server/store.js';

export type StepState = 'active' | 'done' | 'waiting' | 'stuck' | 'failed';
// One vocabulary for a step's state: the feed's knots, the block chips, the dock and the Text list all read it.
export const STATE_WORDS: Record<StepState | 'stopped' | 'paused', string> =
  { active: 'running', done: 'done', waiting: 'waiting for you', stuck: 'out of attempts', failed: 'failed', stopped: 'stopped', paused: 'left paused' };
export interface StepInfo { state?: StepState; attempts?: number; refusals: number; cost: number; why?: string }
export type StepMap = Record<string, StepInfo>;

// v2: the run logged step_started, so steps start there and a turn only confirms its own step.
interface Cursor { step?: string; gate?: string; v2?: boolean }
type Data = Record<string, any>;
type Handler = (m: StepMap, cur: Cursor, data: Data) => void;

const at = (m: StepMap, id: string): StepInfo => (m[id] ??= { refusals: 0, cost: 0 });
const retag = (m: StepMap, from: StepState, to: StepState | undefined, keep?: string) => {
  for (const [id, i] of Object.entries(m)) {
    if (i.state !== from || id === keep) continue;
    if (to) i.state = to; else delete i.state;
  }
};

const handlers: Record<string, Handler> = {
  step_started: (m, cur, d) => {
    if (typeof d.step !== 'string') return;
    cur.v2 = true;
    const parents: string[] = Array.isArray(d.parents) ? d.parents.filter((p: unknown) => typeof p === 'string') : [];
    for (const [id, i] of Object.entries(m)) if (i.state === 'active' && id !== d.step && !parents.includes(id)) i.state = 'done';
    for (const p of parents) if (at(m, p).state !== 'waiting') at(m, p).state = 'active';
    const i = at(m, d.step);
    if (i.state !== 'waiting') { i.state = 'active'; delete i.why; }
    cur.step = d.step;
  },
  command_result: (m, _cur, d) => {
    if (typeof d.step === 'string' && typeof d.exitCode === 'number' && d.exitCode !== 0) Object.assign(at(m, d.step), { state: 'failed', why: `exit ${d.exitCode}` });
  },
  verify_result: (m, cur, d) => {
    if (d.pass === false && cur.step) Object.assign(at(m, cur.step), { state: 'failed', why: 'verify' });
  },
  turn_started: (m, cur, d) => {
    if (typeof d.step !== 'string') return;
    if (cur.v2 && d.step === cur.step) { at(m, d.step).state = 'active'; return; }
    retag(m, 'active', 'done');
    at(m, d.step).state = 'active';
    cur.step = d.step;
  },
  turn_ended: (m, cur, d) => {
    if (typeof d.step !== 'string') return;
    const i = at(m, d.step);
    if (typeof d.cost === 'number') i.cost += d.cost;
    i.state = d.step === cur.gate ? 'waiting' : 'done';
  },
  gate_paused: (m, cur, d) => {
    if (typeof d.step !== 'string') return;
    cur.gate = d.step;
    cur.step = d.step;
    at(m, d.step).state = 'waiting';
  },
  gate_approved: (m, cur) => {
    if (cur.gate && m[cur.gate]) m[cur.gate]!.state = 'done';
    delete cur.gate;
  },
  question: (m, cur, d) => {
    if (d.kind === 'resume' && cur.step) at(m, cur.step).state = 'waiting';
  },
  loop_iteration: (m, _cur, d) => {
    if (typeof d.step === 'string' && typeof d.attempts === 'number') at(m, d.step).attempts = d.attempts;
  },
  loop_budget_exceeded: (m, _cur, d) => {
    if (typeof d.step === 'string') at(m, d.step).state = 'stuck';
  },
  run_resumed: (m, cur) => {
    retag(m, 'stuck', 'active');
    retag(m, 'waiting', 'active', cur.gate);
  },
  engine: (m, cur, d) => {
    if (d.type === 'refusal' && cur.step) at(m, cur.step).refusals += 1;
  },
  run_finished: (m) => retag(m, 'active', 'done'),
  run_stopped: (m) => { retag(m, 'active', undefined); retag(m, 'waiting', undefined); },
  run_detached: (m) => retag(m, 'active', undefined),
};

/** Fold the rows of ONE run. */
export function stepStatus(rows: LogRow[]): StepMap {
  const m: StepMap = {};
  const cur: Cursor = {};
  for (const r of rows) if (Object.hasOwn(handlers, r.type)) handlers[r.type]!(m, cur, (r.data ?? {}) as Data);
  return m;
}

/** The rows of the newest run (by runId of the last row that has one), its workflow name, and whether it is still going. */
export function runRows(rows: LogRow[]): { rows: LogRow[]; workflow?: string; live: boolean } {
  let rid: string | undefined;
  for (let i = rows.length - 1; i >= 0 && !rid; i--) rid = rows[i]!.runId;
  if (!rid) return { rows: [], live: false };
  const mine = rows.filter((r) => r.runId === rid);
  const name = ((mine.find((r) => r.type === 'run_started')?.data ?? {}) as Data).workflow;
  const live = !mine.some((r) => r.type === 'run_finished' || r.type === 'run_stopped') && mine.at(-1)!.type !== 'run_detached';
  return { rows: mine, ...(typeof name === 'string' ? { workflow: name } : {}), live };
}
