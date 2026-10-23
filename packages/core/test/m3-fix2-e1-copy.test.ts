// M3 fix round 2, group E1, items N3 and N4. A Customize copy of a built-in block (`builtin`, no `pack`) runs exactly as the built-in does: its ops and NODE exec are not
// fenced and its pause is the pause it raised. Another mod's block (not a loader-made copy) stays fenced. A `builtin` op that never settles is cut after a grace, never waited for for ever.
// (The whole core project also runs once with every pack block marked as a copy: vitest project `core-copy`.)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { FakeEngine } from '../src/fake-engine.js';
import { register, type NodeType, type VmCtx } from '../src/nodes/index.js';
import { Run } from '../src/run.js';
import type { Instr } from '../src/compile.js';

declare module '../src/model.js' {
  interface NodeKinds { fc: true }
}
declare module '../src/compile.js' {
  interface Instrs { FC: { step: string } }
}

const wf = (body: string) => parseWorkflow(`---\nreins: 1\nname: t\nbudget: { turns: 9, minutes: 9 }\nalways: []\n---\n\n${body}\n`).workflow!;
const disposers: Array<() => void> = [];
const runs: Run[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const r of runs.splice(0)) await r.close();
  for (const d of disposers.splice(0).reverse()) d();
});

type Exec = (i: Extract<Instr, { op: 'FC' }>, vm: VmCtx) => Promise<void>;
type Flags = { pack?: true; builtin?: true };
function reg(flags: Flags, exec: Exec): void {
  disposers.push(register({
    kind: 'fc', attrs: [], mod: { id: 'fc', events: [], ...flags },
    compile(step, ctx) { ctx.push({ op: 'FC', step: step.id }); },
    ops: { FC: { exec } },
  } as NodeType));
}
const start = (steps = 5): { run: Run; stepping: Promise<void> } => {
  const run = new Run({ workflow: wf('## fc\n'), engine: new FakeEngine() });
  runs.push(run);
  return { run, stepping: (async () => { for (let k = 0; k < steps && run.status === 'running'; k++) await run.step(); })() };
};
const GRACE = 11 * 60_000;

describe('N3: a copy pauses as the built-in does', () => {
  const gate = { type: 'gate', stepId: 'fc', cond: { t: 'always' }, title: 'T', track: 'zz', text: 'x'.repeat(500) } as never;

  it('a copy and the pack keep what the pause says (the condition, the title, the long text)', async () => {
    for (const flags of [{ pack: true as const }, { builtin: true as const }]) {
      reg(flags, async (_i, vm) => { vm.pause(gate); });
      const { run, stepping } = start();
      await stepping;
      expect(run.status, JSON.stringify(flags)).toBe('paused');
      expect(run.pauseReason, JSON.stringify(flags)).toMatchObject({ type: 'gate', stepId: 'fc', cond: { t: 'always' }, title: 'T' });
      expect(run.pauseReason!.text!.length, JSON.stringify(flags)).toBe(500);
      disposers.pop()!();
    }
  });

  it('another mod keeps the rebuilt pause: no condition, no title, a cut text; a reason it may not use is refused', async () => {
    reg({}, async (_i, vm) => { vm.pause(gate); });
    const { run, stepping } = start();
    await stepping;
    expect(run.pauseReason).toMatchObject({ type: 'gate', stepId: 'fc' });
    expect(run.pauseReason!.cond).toBeUndefined();
    expect(run.pauseReason!.title).toBeUndefined();
    expect(run.pauseReason!.text!.length).toBeLessThan(500);
    disposers.pop()!();
    reg({}, async (_i, vm) => { vm.pause({ type: 'usd-budget-used' } as never); });
    const b = start();
    await b.stepping;
    expect(b.run.pauseReason?.text).toContain('may not use');
  });

  it('a copy that forgets vm.next() is not paused for it (the built-in is not); another mod is', async () => {
    reg({ builtin: true }, async () => {});
    const a = start();
    await Promise.race([a.stepping, new Promise((r) => setTimeout(r, 30))]);
    expect(a.run.pauseReason).toBeUndefined();
    disposers.pop()!();
    reg({}, async () => {});
    const b = start();
    await b.stepping;
    expect(b.run.pauseReason?.text).toContain('did not move on');
  });
});

describe('N4: a builtin op that never settles', () => {
  /** The op waits on a promise nobody settles until the test says so; the step of the run is `stepping`. */
  const hang = (flags: Flags) => {
    let release!: () => void;
    reg(flags, () => new Promise<void>((r) => { release = r; }));
    vi.useFakeTimers();
    const s = start(1);   // one step: after a close the loop would run the instruction again
    let over = false;
    void s.stepping.then(() => { over = true; });
    return { ...s, release: () => release(), over: () => over };
  };

  it('Stop: stop() itself ends at once; the run is left for the grace, then the step ends', async () => {
    const h = hang({ builtin: true });
    await vi.advanceTimersByTimeAsync(5);
    await h.run.stop();
    expect(h.run.status).toBe('stopped');
    await vi.advanceTimersByTimeAsync(GRACE - 1000);
    expect(h.over()).toBe(false);   // a command the built-in would still be running is left alone
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.over()).toBe(true);
  });

  it('close: waits the same grace, then the step ends and close() returns', async () => {
    const h = hang({ builtin: true });
    await vi.advanceTimersByTimeAsync(5);
    let closed = false;
    const closing = h.run.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(GRACE - 1000);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    await closing;
    expect(closed).toBe(true);
    expect(h.over()).toBe(true);
  });

  it('the pack\'s own op is left the same way (it is the same block)', async () => {
    const h = hang({ pack: true });
    await vi.advanceTimersByTimeAsync(5);
    await h.run.stop();
    await vi.advanceTimersByTimeAsync(GRACE - 1000);
    expect(h.over()).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.over()).toBe(true);
  });

  it('another mod\'s op is still cut by Stop at once', async () => {
    const h = hang({});
    await vi.advanceTimersByTimeAsync(5);
    await h.run.stop();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.over()).toBe(true);
  });

  it('an op that settles before the cut is not cut (the timer does not end a later instruction)', async () => {
    const h = hang({ builtin: true });
    await vi.advanceTimersByTimeAsync(5);
    await h.run.stop();
    h.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.over()).toBe(true);
    await vi.advanceTimersByTimeAsync(GRACE * 2);   // the timer fires on an end that nobody waits on: nothing happens
    expect(h.run.status).toBe('stopped');
  });
});
