// M2 task 21: the run view per track. The rows are the real events of the toy split run on the fake engine (recorded here, not typed).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { LogRow } from '@reins/server/store.js';
import { parseWorkflow } from '../../core/src/format/parse.js';
import { Run } from '../../core/src/run.js';
import { receipt } from '../../core/src/receipt.js';
import { register } from '../../core/src/nodes/index.js';
import type { ScriptedTurn } from '../../core/src/fake-engine.js';
import { m2harness } from '../../core/test/m2-harness.js';
import { split } from '../../core/test/fixtures/split.js';
import { stepStatus } from '../src/stepStatus.js';
import { runView, PHASE, meter } from '../src/runState.js';
import { receiptFields } from '../src/rows/receipt.js';

const disposers: Array<() => void> = [];
beforeAll(() => { disposers.push(register(split)); });
afterAll(() => { for (const d of disposers.splice(0).reverse()) d(); });

const reply = (text: string, cost: number): ScriptedTurn => ({ text: `${text}\nREINS: done`, cost, total: cost });
const BODY = '## phase pre\n> p\n\n## split\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a1\n\n## phase a2\n> a2\n\n## end\n\n## phase b\n> b1\n\n## phase b2\n> b2\n\n## end';

let events: Array<{ type: string; data: any; timestamp: number }> = [];
beforeAll(async () => {
  const h = m2harness('V');
  h.script('V-main-1', reply('p', 0.01), reply('m', 0.02));
  h.script('V-sub-a', reply('a1', 0.1), reply('a2', 0.2));
  h.script('V-sub-b', reply('b1', 0.3), reply('b2', 0.4));
  const parsed = parseWorkflow(`---\nreins: 1\nname: t\nbudget: { turns: 40, minutes: 60 }\nalways: []\n---\n\n${BODY}\n`);
  expect(parsed.diagnostics).toEqual([]);
  const run = new Run({ workflow: parsed.workflow!, engine: h.engine, openSubagent: h.openSubagent, now: h.now });
  for (let k = 0; k < 60 && run.status === 'running'; k++) await run.step();
  await run.close();
  events = run.getEvents().map((e) => ({ type: e.type, data: JSON.parse(JSON.stringify(e.data ?? {})), timestamp: e.timestamp }));
});

const rowsOf = (evs: typeof events): LogRow[] => evs.map((e, i) => ({ sessionId: 's', seq: i + 1, ts: e.timestamp, runId: 'r1', type: e.type, data: e.data }));
const view = (evs: typeof events, status = 'running') => runView({ rows: rowsOf(evs), status } as never);
/** The real events with the two tracks named (a real run names both "Split split-1"). */
const titled = (a: string, b: string) => events.map((e) => (e.type.startsWith('track_') && e.data.title !== undefined ? { ...e, data: { ...e.data, title: e.data.track === 'a' ? a : b } } : e));
const named = () => titled('Alpha', 'Beta');
const raw = (type: string, data: object, timestamp = 9_000_000) => ({ type, data, timestamp });
const row = (type: string, data: object, seq: number): LogRow => ({ sessionId: 's', seq, ts: seq, runId: 'r1', type, data });
// Positions in the real run (checked by the first test): see the dump in the report.
const FIRST_STARTED = 7, BOTH_STARTED = 8, A_ENDED = 26, B_ENDED = 28, SPLIT = 'split-1';

describe('the real split run', () => {
  it('has the order the other tests rely on', () => {
    expect(events.map((e) => `${e.type}${e.data.track ? `:${e.data.track}` : ''}`).slice(5, 30)).toEqual([
      'step_started', 'track_started:a', 'track_started:b', 'split_started', 'step_started:a', 'step_started:b', 'turn_started:a', 'turn_started:b',
      'engine_cost:a', 'turn_ended:a', 'engine_cost:b', 'turn_ended:b', 'step_started:a', 'step_started:b', 'turn_started:a', 'turn_started:b',
      'engine_cost:a', 'turn_ended:a', 'engine_cost:b', 'turn_ended:b', 'step_started:a', 'track_ended:a', 'step_started:b', 'track_ended:b', 'step_started']);
    expect(events[FIRST_STARTED - 1]!.type).toBe('track_started');
    expect(events[BOTH_STARTED - 1]!.type).toBe('track_started');
    expect(events[A_ENDED]!.type).toBe('track_ended');
    expect(events[B_ENDED]!.type).toBe('track_ended');
  });
});

describe('stepStatus keeps one cursor per track', () => {
  it('the step that started the tracks stays active from the first track_started to the LAST track_ended, whatever the tracks do', () => {
    for (let n = FIRST_STARTED; n <= B_ENDED; n++) {
      expect(stepStatus(rowsOf(events.slice(0, n)))[SPLIT]?.state, `after ${n} events (${events[n - 1]!.type})`).toBe('active');
    }
    expect(stepStatus(rowsOf(events))[SPLIT]?.state).toBe('done');
  });

  it('a track\'s steps end with the track: nothing is left active but the run\'s own', () => {
    const m = stepStatus(rowsOf(events.slice(0, B_ENDED + 1)));
    expect(Object.entries(m).filter(([, i]) => i.state === 'active').map(([id]) => id)).toEqual([SPLIT]);
    expect(m.a2?.state).toBe('done');
    expect(m['end-3']?.state).toBe('done');
  });

  it('interleaved: track a moving on does not close the step track b is running', () => {
    // b's first turn is open (event 12) while a finishes its turn and starts its second step (events 14, 17, 19, all real, in this order)
    const evs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 17, 19].map((i) => events[i]!);
    const m = stepStatus(rowsOf(evs));
    expect(m.b?.state).toBe('active');
    expect(m.a2?.state).toBe('active');
    expect(m.a?.state).toBe('done');
  });

  it('whatever the main line logs while a group is live does not close the step that started it; once the last track ended it can', () => {
    const live = named().slice(0, A_ENDED + 1);   // a ended, b still going
    const after = (type: string) => stepStatus(rowsOf([...live, raw(type, { step: 'zz' })]))[SPLIT]?.state;
    expect(after('step_started')).toBe('active');
    expect(after('turn_started')).toBe('active');
    expect(stepStatus(rowsOf([...named().slice(0, B_ENDED + 1), raw('step_started', { step: 'zz' })]))[SPLIT]?.state).toBe('done');
  });

  it('a track\'s own resume moves only its own stuck steps', () => {
    const m = stepStatus([
      row('step_started', { step: 'x', track: 'a' }, 1), row('loop_budget_exceeded', { step: 'x' }, 2),
      row('step_started', { step: 'y' }, 3), row('loop_budget_exceeded', { step: 'y' }, 4),
      row('run_resumed', { track: 'a' }, 5),
    ]);
    expect([m.x?.state, m.y?.state]).toEqual(['active', 'stuck']);
    expect(stepStatus([row('step_started', { step: 'x', track: 'a' }, 1), row('loop_budget_exceeded', { step: 'x' }, 2), row('run_resumed', {}, 3)]).x?.state).toBe('active');
  });
  it('each track has its own gate cursor: approving one track\'s gate leaves the other\'s waiting', () => {
    const m = stepStatus([row('gate_paused', { step: 'ga', track: 'a' }, 1), row('gate_paused', { step: 'gb', track: 'b' }, 2), row('gate_approved', { track: 'a' }, 3)]);
    expect(m.ga?.state).toBe('done');
    expect(m.gb?.state).toBe('waiting');
  });

  it('a verify result is the failure of its own track\'s step', () => {
    const m = stepStatus([row('step_started', { step: 'x' }, 1), row('step_started', { step: 'y', track: 't' }, 2), row('verify_result', { pass: false }, 3), row('verify_result', { pass: false, track: 't' }, 4)]);
    expect([m.x?.state, m.y?.state]).toEqual(['failed', 'failed']);
    expect(m.x?.why).toBe('verify');
  });

  it('no track tag is the main line, as before', () => {
    expect(stepStatus([row('step_started', { step: 'x' }, 1), row('step_started', { step: 'y' }, 2)]))
      .toEqual({ x: { refusals: 0, cost: 0, state: 'done' }, y: { refusals: 0, cost: 0, state: 'active' } });
  });
});

describe('runState and the dock', () => {
  it('two tracks live: "Running 2 at once: Alpha, Beta"', () => {
    const v = view(named().slice(0, BOTH_STARTED + 5));
    expect(v.phase).toBe('running');
    expect(PHASE.running.words(v)).toBe('Running 2 at once: Alpha, Beta');
  });

  it('one track alone prints as before', () => {
    const v = view(named().slice(0, A_ENDED + 1));
    expect(PHASE.running.words(v)).toBe(`Running \`${SPLIT}\``);
    expect(PHASE.running.words(view(events.slice(0, 5)))).toBe('Running `pre`');
  });

  it('after the last track ended the line is the run\'s own again', () => {
    expect(PHASE.running.words(view(named().slice(0, B_ENDED + 2)))).toBe(`Running \`${SPLIT}\``);
  });

  it('a paused track shows as paused while the other runs; resumed, it does not', () => {
    const evs = [...named().slice(0, BOTH_STARTED + 5), raw('run_paused', { reason: 'stop', text: 'Beta failed: boom; Resume tries again', stepId: 'b', track: 'b' })];
    const v = view(evs);
    expect(v.tracks?.map((t) => [t.key, t.paused])).toEqual([['a', false], ['b', true]]);
    expect(PHASE.running.words(v)).toBe('Running 2 at once: Alpha, Beta (paused)');
    expect(PHASE.running.words(view([...evs, raw('run_resumed', { track: 'b' })]))).toBe('Running 2 at once: Alpha, Beta');
  });

  it('a track that ended is not counted', () => {
    expect(view(named().slice(0, A_ENDED + 1)).tracks?.filter((t) => !t.ended).map((t) => t.key)).toEqual(['b']);
  });

  it('at most 3 titles, then "and N more"', () => {
    const evs = [...named().slice(0, BOTH_STARTED), ...['c', 'd', 'e'].map((k) => raw('track_started', { track: k, parent: '', group: 'g2', title: `T${k}` }))];
    expect(PHASE.running.words(view(evs))).toBe('Running 5 at once: Alpha, Beta, Tc and 2 more');
    expect(PHASE.running.words(view(evs.slice(0, -1)))).toBe('Running 4 at once: Alpha, Beta, Tc and 1 more');
    expect(PHASE.running.words(view(evs.slice(0, -2)))).toBe('Running 3 at once: Alpha, Beta, Tc');
  });

  it('a hostile title is shown with hidden characters written out, and capped', () => {
    const evs = titled(`x‮\u0007${'y'.repeat(500)}`, 'Beta').slice(0, BOTH_STARTED);
    const words = PHASE.running.words(view(evs));
    expect(words).toMatch(/^Running 2 at once: x<U\+202E><U\+0007>y+…, Beta$/);
    expect(['\u202e', '\u0007'].some((c) => words.includes(c))).toBe(false);
    expect(words.length).toBeLessThan(120);
  });

  it('went pairs within one track', () => {
    expect(view(events).went.map((w) => `${w.from}>${w.to}`)).toEqual(['pre>split-1', 'split-1>main', 'main>end-1', 'a>a2', 'a2>end-2', 'b>b2', 'b2>end-3']);
  });

  it('the slice meter follows the main line: a track\'s turn neither opens, replaces nor closes it', () => {
    const slice = { step: 'pre', spent: 0.5, usd: 1 };
    const set = (e: (typeof events)[number], i: number) => (i === 4 ? { ...e, data: { ...e.data, slice } } : e);
    const base = events.slice(0, B_ENDED + 1).map(set);
    expect(view(base).slice).toEqual(slice);   // tracks' own turn_ended rows (none carry a slice) did not delete it
    const tagged = base.map((e, i) => (i === 14 ? { ...e, data: { ...e.data, slice: { step: 'zz', spent: 1, usd: 2 } } } : e));
    expect(view(tagged).slice).toEqual(slice);
    expect(meter(view(tagged), { turns: 40, minutes: 60 }, 0).filter((m) => m.key === 'block').map((m) => m.text)).toEqual(['pre: $0.50 / $1.00']);
  });

  it('a track\'s subagent neither replaces nor clears the main line\'s; a track\'s model step does not close the main slice', () => {
    const slice = { step: 'mm', spent: 0.5, usd: 1 };
    const rows = [
      row('run_started', { steps: [{ id: 'mm', kind: 'model' }] }, 1), row('subagent_started', { step: 's', title: 'Look', label: 'L' }, 2),
      row('turn_ended', { step: 's', cost: 0.1, slice }, 3),
      row('subagent_started', { step: 't', title: 'Other', track: 'a' }, 4), row('subagent_result', { step: 't', track: 'a' }, 5),
      row('step_started', { step: 'mm', track: 'a' }, 6),
    ];
    const v = runView({ rows, status: 'running' } as never);
    expect(v.sub).toEqual({ step: 's', title: 'Look', label: 'L' });
    expect(v.slice).toEqual(slice);
    rows.push(row('step_started', { step: 'mm' }, 7));   // the main line's own model step does close it
    expect(runView({ rows, status: 'running' } as never).slice).toBeUndefined();
  });
  it('turns and cost still count every track\'s replies', () => {
    const v = view(events);
    expect(v.turns).toBe(6);
    expect(v.cost).toBeCloseTo(1.03, 6);
  });

  it('rows of a track map to its own step (stepOf), the main line\'s to its own', () => {
    const v = view(events);
    expect(v.stepOf.get(14 + 1)).toBe('a');    // turn_ended a a
    expect(v.stepOf.get(16 + 1)).toBe('b');
    expect(v.stepOf.get(32 + 1)).toBe('main');
  });
});

describe('a run with no tracks is as before', () => {
  const plain = () => events.filter((e) => !e.data.track && !['track_started', 'track_ended', 'split_started', 'split_done'].includes(e.type));
  it('the running line and the receipt fields are exactly what they were', () => {
    expect(PHASE.running.words(view(plain().slice(0, 6)))).toBe(`Running \`${SPLIT}\``);
    const r = receipt(plain() as never);
    expect('tracks' in r).toBe(false);
    expect(receiptFields(r)).toEqual([['status', 'done'], ['turns', '2'], ['time', '36s'], ['cost', '$0.0300']]);
    expect(view(plain().slice(0, 6)).tracks).toBeUndefined();
  });
});

describe('the receipt row for tracks', () => {
  it('reads one entry per track; a hidden character in a title is written out and the title capped', () => {
    const f = Object.fromEntries(receiptFields(receipt(titled('Alpha', `B‮${'z'.repeat(500)}`) as never)));
    expect(f.tracks).toMatch(/^Alpha \$0\.3000 \(2 turns\) · B<U\+202E>z+… \$0\.7000 \(2 turns\)$/);
    expect(f.tracks!.length).toBeLessThan(120);
    expect(f.cost).toBe('$1.0300');
  });

  it('says which track has not ended', () => {
    const f = Object.fromEntries(receiptFields(receipt(named().slice(0, B_ENDED) as never)));
    expect(f.tracks).toBe('Alpha $0.3000 (2 turns) · Beta $0.7000 (2 turns, not ended)');
  });
});
