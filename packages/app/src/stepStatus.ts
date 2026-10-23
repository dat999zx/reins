import type { LogRow } from '@reins/server/store.js';
import { showText } from '../../core/src/display.js';
import type { StatusRule, StatusState } from '../../core/src/nodes/fields.js';
import { holds, own, statusOf } from './viewEvents.js';

export type StepState = StatusState;
// One vocabulary for a step's state: the feed's knots, the block chips, the dock and the Text list all read it.
export const STATE_WORDS: Record<StepState | 'stopped' | 'paused', string> =
  { active: 'running', done: 'done', waiting: 'waiting for you', stuck: 'out of attempts', failed: 'failed', stopped: 'stopped', paused: 'left paused' };
/** `model` is the model the step's reply ran on, as the provider reported it (turn_ended.model), labelled when the run's own switch rows gave a label (a view's `status` rule with `label`). */
export interface StepInfo { state?: StepState; attempts?: number; refusals: number; cost: number; why?: string; model?: string }
export type StepMap = Record<string, StepInfo>;

/** A track's title as the dock and the receipt show it: at most 40 characters, hidden ones written out (the cut comes first, so an escape is never cut). */
export const trackTitle = (t: string): string => {
  const chars = Array.from(t);
  return showText(chars.slice(0, 40).join('') + (chars.length > 40 ? '…' : ''));
};

// One cursor per track ('' = the main line; a row names its track in `data.track`). v2: the run logged step_started, so steps start there and a turn only confirms its own step.
interface Cursor { track: string; step?: string; gate?: string; v2?: boolean }
// What the tracks share: who owns an active step (absent: the main line), the step that started each live group, and the model labels.
interface Shared { cursors: Map<string, Cursor>; own: Map<string, string>; groups: Map<string, { step?: string; live: number }>; labels: Record<string, string> }
type Data = Record<string, any>;
type Handler = (m: StepMap, cur: Cursor, data: Data, sh: Shared) => void;

const at = (m: StepMap, id: string): StepInfo => (m[id] ??= { refusals: 0, cost: 0 });
const mine = (sh: Shared, cur: Cursor, id: string) => (sh.own.get(id) ?? '') === cur.track;
// a step that started tracks stays active while any track of its group is live
const held = (sh: Shared, id: string) => [...sh.groups.values()].some((g) => g.step === id && g.live > 0);
const retag = (m: StepMap, from: StepState, to: StepState | undefined, skip: (id: string) => boolean = () => false) => {
  for (const [id, i] of Object.entries(m)) {
    if (i.state !== from || skip(id)) continue;
    if (to) i.state = to; else delete i.state;
  }
};
// The steps this track is done with: its own active ones, except one that still holds live tracks.
const finish = (m: StepMap, cur: Cursor, sh: Shared) => retag(m, 'active', 'done', (id) => !mine(sh, cur, id) || held(sh, id));

const handlers: Record<string, Handler> = {
  step_started: (m, cur, d, sh) => {
    if (typeof d.step !== 'string') return;
    cur.v2 = true;
    const parents: string[] = Array.isArray(d.parents) ? d.parents.filter((p: unknown) => typeof p === 'string') : [];
    retag(m, 'active', 'done', (id) => id === d.step || parents.includes(id) || !mine(sh, cur, id) || held(sh, id));
    for (const p of parents) if (at(m, p).state !== 'waiting') { at(m, p).state = 'active'; sh.own.set(p, cur.track); }
    const i = at(m, d.step);
    if (i.state !== 'waiting') { i.state = 'active'; delete i.why; sh.own.set(d.step, cur.track); }
    cur.step = d.step;
  },
  track_started: (_m, _cur, d, sh) => {
    if (typeof d.group !== 'string') return;
    const g = sh.groups.get(d.group) ?? { step: sh.cursors.get(typeof d.parent === 'string' ? d.parent : '')?.step, live: 0 };
    g.live++;
    sh.groups.set(d.group, g);
  },
  track_ended: (m, cur, d, sh) => {
    const g = typeof d.group === 'string' ? sh.groups.get(d.group) : undefined;
    if (g && --g.live <= 0) sh.groups.delete(d.group);
    finish(m, cur, sh);
  },
  subagent_started: (m, _cur, d, sh) => {
    if (typeof d.step !== 'string') return;
    const name = typeof d.label === 'string' ? d.label : typeof d.model === 'string' ? d.model : undefined;
    if (name) at(m, d.step).model = name;
    if (typeof d.label === 'string' && typeof d.model === 'string') sh.labels[d.model] = d.label;
  },
  command_result: (m, _cur, d) => {
    if (typeof d.step === 'string' && typeof d.exitCode === 'number' && d.exitCode !== 0) Object.assign(at(m, d.step), { state: 'failed', why: `exit ${d.exitCode}` });
  },
  turn_started: (m, cur, d, sh) => {
    if (typeof d.step !== 'string') return;
    if (cur.v2 && d.step === cur.step) { at(m, d.step).state = 'active'; return; }
    finish(m, cur, sh);
    at(m, d.step).state = 'active';
    sh.own.set(d.step, cur.track);
    cur.step = d.step;
  },
  turn_ended: (m, cur, d, sh) => {
    if (typeof d.step !== 'string') return;
    const i = at(m, d.step);
    if (typeof d.cost === 'number') i.cost += d.cost;
    if (typeof d.model === 'string') i.model = Object.hasOwn(sh.labels, d.model) ? sh.labels[d.model]! : d.model;
    i.state = d.step === cur.gate ? 'waiting' : 'done';
  },
  gate_approved: (m, cur) => {
    if (cur.gate && m[cur.gate]) m[cur.gate]!.state = 'done';
    delete cur.gate;
  },
  question: (m, cur, d) => {
    if ((d.kind === 'resume' || d.kind === 'switch') && cur.step) at(m, cur.step).state = 'waiting';
  },
  // a track's own resume moves only that track's steps; any gate still open on a track stays waiting
  run_resumed: (m, cur, _d, sh) => {
    const other = (id: string) => cur.track !== '' && !mine(sh, cur, id);
    retag(m, 'stuck', 'active', other);
    retag(m, 'waiting', 'active', (id) => other(id) || [...sh.cursors.values()].some((c) => c.gate === id));
  },
  engine: (m, cur, d) => {
    if (d.type === 'refusal' && cur.step) at(m, cur.step).refusals += 1;
  },
  run_finished: (m) => retag(m, 'active', 'done'),
  run_stopped: (m) => { retag(m, 'active', undefined); retag(m, 'waiting', undefined); },
  run_detached: (m) => retag(m, 'active', undefined),
};

// A kind's event, by its view's rule (`view.status`): plain data, so a block that is not built in marks the run the same way.
const applyRule = (m: StepMap, cur: Cursor, d: Data, sh: Shared, r: StatusRule) => {
  if (r.when && !holds(d, r.when)) return;
  let id: string;
  if (r.step === 'track') { if (!cur.step) return; id = cur.step; } else { if (typeof d.step !== 'string') return; id = d.step; }
  if (r.attempts !== undefined) {
    const a = own(d, r.attempts);
    if (typeof a === 'number') at(m, id).attempts = a;
  }
  if (r.state !== undefined) at(m, id).state = r.state;
  if (typeof r.why === 'string') at(m, id).why = r.why;
  else if (r.why) {
    const i = at(m, id);
    const how = own(d, r.why.key);
    const words = typeof how === 'string' && Object.hasOwn(r.why.words, how) ? r.why.words[how] : undefined;
    const add = r.why.add === undefined ? '' : own(d, r.why.add);
    if (words && (r.why.add === undefined || (typeof add === 'string' && add))) i.why = r.why.add === undefined ? words : `${words} ${add}`; else delete i.why;
  }
  if (r.label && (!r.label.when || holds(d, r.label.when))) {
    const name = own(d, r.label.name), model = own(d, r.label.model);
    if (typeof name === 'string' && name && typeof model === 'string') sh.labels[model] = name;
  }
  if (r.gate) cur.gate = id;
  if (r.cursor) cur.step = id;
};

/** Fold the rows of ONE run. */
export function stepStatus(rows: LogRow[]): StepMap {
  const m: StepMap = Object.create(null); // keyed by step id, which may be `__proto__`: no prototype to write through
  const sh: Shared = { cursors: new Map(), own: new Map(), groups: new Map(), labels: Object.create(null) };
  for (const r of rows) {
    const handler = Object.hasOwn(handlers, r.type) ? handlers[r.type] : undefined;
    const rule = handler ? undefined : statusOf(r.type);
    if (!handler && !rule) continue;
    const d = (r.data ?? {}) as Data;
    const track = typeof d.track === 'string' ? d.track : '';
    let cur = sh.cursors.get(track);
    if (!cur) sh.cursors.set(track, (cur = { track }));
    if (handler) handler(m, cur, d, sh); else applyRule(m, cur, d, sh, rule!);
  }
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
