// M3 Task 2: the run's marks and the feed read a kind's events from its served view (`status`, `hidden`), not from names in the app. A block mod loaded
// through the real loader (a temp home) brings both; hostile values are refused by the shared check and, if one got served anyway, do nothing in the page.
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogRow } from '@reins/server/store.js';
import { viewShapeProblem } from '../../core/src/viewShape.js';
import { loadMods } from '../../server/src/mods/loader.js';
import { servedKinds } from '../../server/src/mods/kinds-view.js';
import { served as appServed } from './app-pack.js';
import type { Mods } from '../../server/src/mods/types.js';
import { tempHome } from '../../server/test/mods-harness.js';
import { setConds, standInCond } from '../src/condKinds.js';
import { served as packServed } from './app-pack.js';
import { KINDS, setKinds } from '../src/canvasKinds.js';
import { feed } from '../src/feed.js';
import { drawable, hidden } from '../src/rows/hidden.js';
import { runView } from '../src/runState.js';
import { initial, mergeOutput, reduceAll } from '../src/state.js';
import { stepStatus } from '../src/stepStatus.js';
import { statusOf, viewHidden } from '../src/viewEvents.js';

let seq = 0;
const row = (type: string, data?: unknown, runId = 'r1'): LogRow => ({ sessionId: 's1', seq: ++seq, ts: 1000 * seq, type, data, ...(runId ? { runId } : {}) });

const CODE = `export default function activate(api) { api.registerBlock({ kind: 'flag', attrs: ['n'], compile(step, ctx) { ctx.push({ op: 'FLAG', step: step.id }); }, ops: { FLAG: { async exec(i, vm) { vm.next(); } } } }); }`;
const manifest = (view: Record<string, unknown> = {}) => ({
  reins: 1, id: 'toy-flag', kind: 'block', version: '1.0.0', label: 'Toy flag', main: 'index.js', order: 150,
  provides: { kinds: ['flag'], ops: ['FLAG'], attrs: ['n'], events: ['flagged', 'flag_done', 'flag_set'] },
  view: {
    kind: 'flag', order: 150, colour: 'soft',
    fields: [{ key: 'n', label: 'N', input: 'number', check: 'count' }],
    line: ['flag', { field: 'n' }],
    card: { label: 'flag', section: 'Flow' },
    fresh: { attrs: { n: '1' } },
    status: {
      flagged: { state: 'waiting', attempts: 'n', gate: true, cursor: true },
      flag_done: { when: { key: 'ok', is: [false] }, step: 'track', state: 'failed', why: 'flag' },
      flag_set: { state: 'done', why: { key: 'how', words: { fast: 'quickly', slow: 'slowly' }, add: 'label' }, label: { model: 'model', name: 'label', when: { key: 'how', is: ['fast'] } } },
    },
    hidden: ['flag_set'],
    ...view,
  },
});

let h: ReturnType<typeof tempHome>;
const loaded: Mods[] = [];
beforeEach(() => { h = tempHome(); });
afterEach(() => {
  for (const m of loaded.splice(0).reverse()) m.dispose();
  h.cleanup();
  setKinds(packServed().kinds);
});
const withMod = async (view?: Record<string, unknown>) => {
  h.writeMod('toy-flag', manifest(view), { 'index.js': CODE });
  const m = await loadMods({ bundledDir: path.join(h.home, 'no-bundled'), userDir: h.modsDir, home: h.home, disabled: new Set(), trusted: () => true, env: {} });
  loaded.push(m);
  const served = servedKinds(m);
  setKinds(served.kinds);
  return { m, served };
};
const feedOf = (rows: LogRow[]) => {
  const s = reduceAll(initial(), rows, 0).sessions.s1!;
  return feed(mergeOutput(s.rows), runView(s), new Set(s.open));
};

describe('M3 Task 2: a mod kind marks the run and the feed from its view', () => {
  it('stepStatus follows the served rules: state, attempts, gate, cursor, track step, words with a label', async () => {
    const { served } = await withMod();
    expect(served.problems).toEqual([]);
    expect(statusOf('flagged')).toMatchObject({ state: 'waiting' });
    const m = stepStatus([
      row('step_started', { step: 'a' }), row('flagged', { step: 'f', n: 3 }),
      row('flag_done', { ok: false }),                 // 'track': the step the track is on, which `flagged` just made f
      row('flag_set', { step: 's', how: 'fast', label: 'Quick', model: 'm1' }),
      row('flag_set', { step: 't', how: 'slow', label: 'Slow', model: 'm2' }),
      row('flag_set', { step: 'u', how: 'constructor', label: 'X', model: 'm3' }),
      row('turn_ended', { step: 's', model: 'm1' }),
      row('turn_ended', { step: 't', model: 'm2' }),
    ]);
    expect(m.f).toMatchObject({ state: 'failed', why: 'flag', attempts: 3 });
    expect(m.s).toMatchObject({ state: 'done', why: 'quickly Quick', model: 'Quick' });   // the label rule ran for `fast` only
    expect(m.t).toMatchObject({ state: 'done', why: 'slowly Slow', model: 'm2' });
    expect(m.u).toMatchObject({ state: 'done' });
    expect(m.u!.why).toBeUndefined();   // `constructor` is not one of the words
  });

  it('a hidden event draws nothing and is not structure; one with a rule only is structure (not a bead)', async () => {
    await withMod();
    expect(hidden.has('flag_set')).toBe(true);
    expect(drawable(row('flag_set'))).toBe(false);
    expect(viewHidden().has('flag_set')).toBe(true);
    expect([...hidden]).toContain('flag_set');
    const f = feedOf([
      row('run_started', { workflow: 'w', steps: [{ id: 'f', kind: 'flag' }] }), row('step_started', { step: 'f', parents: [] }),
      row('flagged', { step: 'f', n: 1 }), row('flag_set', { step: 'f', how: 'fast', label: 'Q', model: 'm' }), row('flag_done', { step: 'f', ok: false }), row('flag_note', { step: 'f' }),
    ]);
    const run = f.pieces.find((p) => p.type === 'run')!;
    const knot = (run as { items: Array<{ knot?: { beads: LogRow[]; state: string; why?: string } }> }).items.find((i) => i.knot)!.knot!;
    // `flagged` and `flag_done` have a rule and are not hidden: structure. `flag_set` is hidden. `flag_note` has neither: a bead.
    expect(knot.beads.map((b) => b.type)).toEqual(['flag_note']);
  });

  it('a hidden event is no structure: after the run ended it does not bring the run back to life', async () => {
    await withMod();
    const f = feedOf([
      row('run_started', { workflow: 'w', steps: [{ id: 'f', kind: 'flag' }] }), row('step_started', { step: 'f', parents: [] }),
      row('run_finished'), row('flag_set', { step: 'f', how: 'fast', label: 'Q', model: 'm' }),
    ]);
    expect((f.pieces.find((p) => p.type === 'run') as { state: string }).state).toBe('done');
  });

  it('a rule with `cursor` moves the track\'s current step like a turn does (the built-in gate)', () => {
    const m = stepStatus([
      row('turn_started', { step: 'a' }), row('turn_ended', { step: 'a' }), row('gate_paused', { step: 'g' }), row('gate_approved'), row('question', { kind: 'resume' }),
    ]);
    expect(m.g!.state).toBe('waiting');   // the question names the current step, which the gate made g
    expect(m.a!.state).toBe('done');
  });

  it('a rule that ends in failed marks the knot in the feed (the current knot with step "track")', async () => {
    await withMod();
    const f = feedOf([
      row('run_started', { workflow: 'w', steps: [{ id: 'f', kind: 'flag' }] }), row('step_started', { step: 'f', parents: [] }),
      row('flag_done', { ok: false }),
    ]);
    const run = f.pieces.find((p) => p.type === 'run')! as { items: Array<{ knot?: { state: string; why?: string } }> };
    // the view of the live run is not set here: the knot of a finished walk takes the evidence
    expect(run.items.find((i) => i.knot)!.knot).toMatchObject({ state: 'failed', why: 'flag' });
  });

  it('disposing the mod takes its rules and its hidden event away', async () => {
    const { m } = await withMod();
    expect(hidden.has('flag_set')).toBe(true);
    m.dispose();
    setKinds(packServed().kinds);
    expect(hidden.has('flag_set')).toBe(false);
    expect(statusOf('flagged')).toBeUndefined();
    expect(stepStatus([row('flagged', { step: 'f' })])).toEqual({});
  });
});

describe('M3 Task 2: hostile view values', () => {
  const base = () => ({ ...manifest().view });
  const bad: Array<[string, unknown]> = [
    ['a status key __proto__', JSON.parse('{"__proto__":{"state":"done"}}')],
    ['a status key with a hidden character', { ['fl' + String.fromCharCode(0x202e) + 'ag']: { state: 'done' } }],
    ['a status key that is 40+ characters', { ['x'.repeat(41)]: { state: 'done' } }],
    ['too many rules', Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`ev${i}`, { state: 'done' }]))],
    ['a state of the wrong type', { flagged: { state: 3 } }],
    ['a state with a hidden character', { flagged: { state: 'do' + String.fromCharCode(0x200b) + 'ne' } }],
    ['a why of the wrong type', { flagged: { why: 5 } }],
    ['a why of 200+ characters', { flagged: { why: 'y'.repeat(201) } }],
    ['a why object with extra keys', { flagged: { why: { key: 'a', words: { b: 'c' }, evil: 1 } } }],
    ['a words value of 41 characters', { flagged: { why: { key: 'a', words: { b: 'c'.repeat(41) } } } }],
    ['an `is` list of 9', { flagged: { when: { key: 'a', is: Array.from({ length: 9 }, (_, i) => i) } } }],
    ['an `is` value of NaN-like text length 41', { flagged: { when: { key: 'a', is: ['z'.repeat(41)] } } }],
    ['a label with a missing name', { flagged: { label: { model: 'm' } } }],
    ['a rule that is null', { flagged: null }],
  ];
  it.each(bad)('the shared check refuses %s, and the app leaves the whole view out', (_n, status) => {
    const v = { ...base(), status } as Record<string, unknown>;
    expect(viewShapeProblem(v, { served: true }), 'served').toEqual(expect.any(String));
    setKinds([v]);
    expect(Object.keys(KINDS)).toEqual([]);
    expect(statusOf('flagged')).toBeUndefined();
  });
  it.each([
    ['a hidden that is a string', 'flag_done'],
    ['a hidden holding a number', [3]],
    ['a hidden holding __proto__', ['__proto__']],
    ['a hidden holding constructor', ['constructor']],
    ['a hidden of 51 entries', Array.from({ length: 51 }, (_, i) => `e${i}`)],
    ['a hidden entry with a newline', ['a\nb']],
    ['a hidden twice', ['abc', 'abc']],
  ])('the shared check refuses %s', (_n, hid) => {
    expect(viewShapeProblem({ ...base(), hidden: hid }, { served: true })).toEqual(expect.any(String));
  });

  it('the good view passes the same check, with and without a mod scope', () => {
    expect(viewShapeProblem(base(), { served: true })).toBeUndefined();
    expect(viewShapeProblem(base(), { mod: { attrs: ['n'], events: ['flagged', 'flag_done', 'flag_set'] } })).toBeUndefined();
  });

  it('hostile row types and data do nothing and throw nothing', async () => {
    await withMod();
    const rows = [
      row('__proto__', { step: 'a' }), row('constructor', { step: 'a' }), row('toString'), row('hasOwnProperty', { step: 'a' }),
      row('flagged', null), row('flagged', 'text'), row('flagged', []), row('flagged', { step: 7 }),
      row('flag_done', { ok: false }),                               // no current step yet
      row('flag_set', { step: 'a', how: '__proto__', label: 'L', model: '__proto__' }),
      row('flag_set', { step: 'b', how: 'fast', label: { x: 1 }, model: 'm' }),
      row('flag_set', { step: 'c', how: 'fast', label: 'L', model: '__proto__' }),
    ];
    const m = stepStatus(rows);
    expect(Object.keys(m).sort()).toEqual(['a', 'b', 'c']);
    expect(m.a!.why).toBeUndefined();
    expect(m.b!.why).toBeUndefined();
    expect(({} as Record<string, unknown>).L).toBeUndefined();
    expect(Object.getPrototypeOf(m)).toBeNull();
    expect(() => feedOf(rows.map((r) => ({ ...r, runId: 'r1' })))).not.toThrow();
  });

  it('the stand-in condition is the first one served, whatever it is (no condition is named in the app)', () => {
    setConds([{ t: 'zed', label: 'Z', fresh: { t: 'zed' } }, { t: 'approve', label: 'A', fresh: { t: 'approve' } }]);
    expect(standInCond()).toEqual({ t: 'zed' });
    expect(standInCond()).not.toBe(standInCond());   // a new copy each time
    setConds(appServed().conds);
    expect(standInCond()).toEqual({ t: 'approve' });
  });

  it('before the first reply nothing throws and there is no stand-in condition', () => {
    setKinds([]);
    setConds([]);
    expect(Object.keys(KINDS)).toEqual([]);
    expect(standInCond()).toBeUndefined();
    expect(hidden.has('model_switched')).toBe(false);
    expect(hidden.has('status')).toBe(true);   // the app's own list stays
    expect(stepStatus([row('gate_paused', { step: 'g' })])).toEqual({});
    expect(() => feedOf([row('run_started', { workflow: 'w', steps: [] }), row('gate_paused', { step: 'g' }), row('loop_iteration', { step: 'g' })])).not.toThrow();
  });
});
