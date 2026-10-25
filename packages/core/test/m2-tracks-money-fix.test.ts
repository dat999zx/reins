// M2 task 10b, fix round (docs/plan/m2-codex-10b-review.md, findings 3 to 8): spend counters of tracks, the spend key, a restored key and spend,
// live command results in a compound condition, the raw cost sum, and an absurd money record.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { validate } from '../src/validate.js';
import { parseCond } from '../src/cond.js';
import { Run, trackSpendKey, type RunOptions, type RunSnapshot, type Track } from '../src/run.js';
import { register } from '../src/nodes/index.js';
import type { Workflow } from '../src/model.js';
import { m2harness } from './m2-harness.js';
import { split } from './fixtures/split.js';

const disposers: Array<() => void> = [];
beforeAll(() => { disposers.push(register(split)); });
afterAll(() => { for (const d of disposers.splice(0).reverse()) d(); });

const wf = (body: string): Workflow => {
  const r = parseWorkflow(`---\nreins: 1\nname: t\nbudget: { turns: 40, minutes: 60 }\nalways: []\n---\n\n${body}\n`);
  expect(r.diagnostics).toEqual([]);
  return r.workflow!;
};
type Harness = ReturnType<typeof m2harness>;
const mk = (h: Harness, body: string, opts: Partial<RunOptions> = {}) =>
  new Run({ workflow: wf(body), engine: h.engine, openSubagent: h.openSubagent, now: h.now, ...opts });
const subOf = (s: string, key: string) => `${s}-sub-${key}`;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const BODY = '## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## end';
const SLICE_TRACK = '## model claude-x\nusd: 1\n\n## split\nnext: a\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## phase a2\n> a2\n\n## end';

type Inner = {
  startTracks(parent: Track, group: string, list: Array<{ key: string; title: string; at: number }>): void;
  takeTracks(group: string): unknown;
  endTrack(t: Track): Promise<void>;
  countCost(r: { text: string; cost?: number }, sub: undefined, t: Track): unknown;
  usdRoom(t: Track): number | undefined;
  spentOn(t: Track, s: { step: string }): number;
  judgeCond(c: unknown, auto: boolean, t: Track): Promise<boolean>;
  usdSpent: Record<string, number>;
};
const inner = (run: Run) => run as unknown as Inner;
const start = (run: Run, parent: Track, group: string, key: string) => { inner(run).startTracks(parent, group, [{ key, title: key, at: 0 }]); return run.tracks.get(key)!; };

describe('finding 3: a starting track counts from what its starter spent, and an ended track leaves no counter', () => {
  it('a reused key starts at 0 when the starter spent 0, and the ended track\'s counter is gone', async () => {
    const run = mk(m2harness('R3'), BODY);
    run.main.openSlice = { step: 'm', usd: 1 };
    const a = start(run, run.main, 'g1', 'a');
    inner(run).countCost({ text: '', cost: 0.8 }, undefined, a);
    await inner(run).endTrack(a);
    inner(run).takeTracks('g1');
    expect(Object.keys(run.snapshot().usdSpent!)).toEqual([]);   // the run cost holds it; no counter piles up
    const again = start(run, run.main, 'g2', 'a');
    expect(inner(run).usdRoom(again)).toBeCloseTo(1, 9);
    await run.close();
  });

  it('a counter left under the key (a snapshot of the earlier build) is set back to what the starter spent, 0 included', async () => {
    const run = mk(m2harness('R3c'), BODY);
    run.main.openSlice = { step: 'm', usd: 1 };
    (run as unknown as Inner).usdSpent = { [trackSpendKey('a', 'm')]: 0.8 };
    const a = start(run, run.main, 'g1', 'a');
    expect(inner(run).usdRoom(a)).toBeCloseTo(1, 9);
    await run.close();
  });

  it('a track that opens its own slice leaves no counter of the inherited one behind', async () => {
    const run = mk(m2harness('R3b'), BODY);
    run.main.openSlice = { step: 'm', usd: 1 };
    const a = start(run, run.main, 'g1', 'a');
    inner(run).countCost({ text: '', cost: 0.2 }, undefined, a);
    // what a `model` step on the track does (execCtx.slice)
    (run as unknown as { execCtx(t: Track, s: string): { slice(id: string, usd?: number): void } }).execCtx(a, 'x').slice('own', 0.5);
    expect(Object.keys(run.snapshot().usdSpent!)).toEqual([]);
    await run.close();
  });
});

describe('finding 4: the spend key cannot collide', () => {
  it('(a, "b\\u0001c") and ("a\\u0001b", c) get different keys and do not share a counter', async () => {
    const run = mk(m2harness('R4'), BODY);
    run.main.openSlice = { step: 'b\u0001c', usd: 1 };
    const t1 = start(run, run.main, 'g1', 'a');
    run.main.openSlice = { step: 'c', usd: 1 };
    const t2 = start(run, run.main, 'g2', 'a\u0001b');
    expect(t1.spendKey).not.toBe(t2.spendKey);
    inner(run).countCost({ text: '', cost: 0.6 }, undefined, t1);
    inner(run).countCost({ text: '', cost: 0.6 }, undefined, t2);
    expect(inner(run).usdRoom(t1)).toBeCloseTo(0.4, 9);
    expect(inner(run).usdRoom(t2)).toBeCloseTo(0.4, 9);
    await run.close();
  });

  it('a step id that starts with the reserved character is refused by validate, so no plain id can equal a track key', () => {
    const w = wf(BODY);
    w.steps[0]!.id = '\u0001["a","b"]';
    expect(validate(w).filter((d) => d.severity === 'error').map((d) => d.message).join('\n')).toMatch(/reserved/);
  });
});

describe('finding 5: a restored spend key and spend are checked', () => {
  const held = async () => {
    const h = m2harness('R5');
    const hold = h.hold(subOf('R5', 'a'));
    const run = mk(h, SLICE_TRACK);
    const driven = (async () => { for (let k = 0; k < 20 && run.status === 'running'; k++) await run.step(); })();
    await hold.started;
    const snap = clone(run.snapshot());
    hold.release();
    await driven;
    await run.close();
    return { h, snap };
  };
  const restore = (h: Harness, snap: RunSnapshot) => Run.restore(snap, { engine: h.engine, openSubagent: h.openSubagent, now: h.now });

  it('refuses a spend key that is not the one derived from the track and its slice', async () => {
    const { h, snap } = await held();
    expect(snap.tracks![0]!.spendKey).toBeDefined();
    for (const bad of ['unused', '__proto__', 'model-1']) {
      const s = clone(snap);
      s.tracks![0]!.spendKey = bad;
      expect(() => restore(h, s), bad).toThrow(/saved run is inconsistent: /);
    }
    const back = restore(h, clone(snap));   // the real one is accepted
    await back.close();
  });

  it('refuses a spend key on a track with no open slice', async () => {
    const { h, snap } = await held();
    const s = clone(snap);
    delete s.tracks![0]!.openSlice;
    expect(() => restore(h, s)).toThrow(/saved run is inconsistent: /);
  });

  it('refuses a usdSpent that is not a map of finite amounts, 0 or more', async () => {
    const { h, snap } = await held();
    for (const bad of [{ x: -1 }, { x: 'a' }, { x: null }, 5, []]) {
      const s = clone(snap);
      s.usdSpent = bad as never;
      expect(() => restore(h, s), JSON.stringify(bad)).toThrow(/saved run is inconsistent: /);
    }
  });

  it('reads a counter only if it is the dictionary\'s own', async () => {
    const run = mk(m2harness('R5b'), BODY);
    (run as unknown as Inner).usdSpent = Object.create({ m: 5 }) as Record<string, number>;
    expect(inner(run).spentOn(run.main, { step: 'm' })).toBe(0);
    await run.close();
  });
});

describe('finding 6: a compound condition sees the command results it records itself', () => {
  const COND = 'not tests pass and same error twice';
  const mkRun = () => mk(m2harness('R6'), BODY, { commandRunner: async () => ({ exitCode: 1, stdout: '', stderr: 'bad' }) });
  const cond = () => parseCond(COND).cond!;

  it('on the main line', async () => {
    const run = mkRun();
    run.recordCommandResult('npm test', 1, 'bad');
    expect(await inner(run).judgeCond(cond(), false, run.main)).toBe(true);
    await run.close();
  });

  it('on a track', async () => {
    const run = mkRun();
    const a = start(run, run.main, 'g', 'a');
    run.recordCommandResult('npm test', 1, 'bad', a);
    expect(await inner(run).judgeCond(cond(), false, a)).toBe(true);
    await run.close();
  });
});

describe('finding 7: a track\'s cost is the raw sum, rounded only where it is shown', () => {
  it('ten turns of 0.0000004 are 0.000004 in the record and the row', async () => {
    const run = mk(m2harness('R7'), BODY);
    const a = start(run, run.main, 'g', 'a');
    for (let k = 0; k < 10; k++) inner(run).countCost({ text: '', cost: 0.0000004 }, undefined, a);
    expect(a.money!.cost).toBeCloseTo(0.000004, 12);
    await inner(run).endTrack(a);
    const row = run.getEvents().find((e) => e.type === 'track_ended')!;
    expect(row.data.cost).toBe(0.000004);
    await run.close();
  });
});

describe('finding 8: an absurd money record is refused and a figure is never non-finite', () => {
  const held = async () => {
    const h = m2harness('R8');
    const hold = h.hold(subOf('R8', 'a'));
    const run = mk(h, SLICE_TRACK);
    const driven = (async () => { for (let k = 0; k < 20 && run.status === 'running'; k++) await run.step(); })();
    await hold.started;
    const snap = clone(run.snapshot());
    hold.release();
    await driven;
    await run.close();
    return { h, snap };
  };

  it('refuses a cost, total or model total above 1e12', async () => {
    const { h, snap } = await held();
    for (const bad of [{ cost: 1e308 }, { cost: 1, total: 1e13 }, { cost: 1, totals: { m: 1e13 } }]) {
      const s = clone(snap);
      s.tracks![0]!.money = bad;
      expect(() => Run.restore(s, { engine: h.engine, openSubagent: h.openSubagent, now: h.now }), JSON.stringify(bad)).toThrow(/saved run is inconsistent: /);
    }
  });

  it('a record near the top still reports a finite cost', async () => {
    const run = mk(m2harness('R8b'), BODY);
    const a = start(run, run.main, 'g', 'a');
    a.money = { cost: 1e308 };
    inner(run).countCost({ text: '', cost: 0 }, undefined, a);
    await inner(run).endTrack(a);
    const row = run.getEvents().find((e) => e.type === 'track_ended')!;
    expect(Number.isFinite(row.data.cost)).toBe(true);
    await run.close();
  });
});
