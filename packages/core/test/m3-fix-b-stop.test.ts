// M3 fix round, group B, item 8: a Customize copy of a built-in block is "the same block, tweaked". Fix round 2 (E1, N3): it runs exactly as the built-in does (not fenced),
// and Stop waits for the command it has in flight. Any other mod's op (not a loader-made copy) is still fenced and raced with Stop.
import { afterEach, describe, expect, it } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { FakeEngine } from '../src/fake-engine.js';
import { register, type NodeType, type VmCtx } from '../src/nodes/index.js';
import { Run } from '../src/run.js';
import type { Instr } from '../src/compile.js';

declare module '../src/model.js' {
  interface NodeKinds { fb: true }
}
declare module '../src/compile.js' {
  interface Instrs { FB: { step: string } }
}
declare module '../src/run.js' {
  interface RunEvents { fb_ev: unknown }
}

const wf = (body: string) => parseWorkflow(`---\nreins: 1\nname: t\nbudget: { turns: 9, minutes: 9 }\nalways: []\n---\n\n${body}\n`).workflow!;
const disposers: Array<() => void> = [];
const runs: Run[] = [];
afterEach(async () => {
  for (const r of runs.splice(0)) await r.close();
  for (const d of disposers.splice(0).reverse()) d();
});

type Exec = (i: Extract<Instr, { op: 'FB' }>, vm: VmCtx) => Promise<void>;
type Flags = { pack?: true; builtin?: true };
function reg(flags: Flags, exec: Exec): void {
  const node: NodeType = {
    kind: 'fb', attrs: [], mod: { id: 'fb', events: [], ...flags },
    compile(step, ctx) { ctx.push({ op: 'FB', step: step.id }); },
    ops: { FB: { exec } },
  };
  disposers.push(register(node));
}
const start = (): { run: Run; stepping: Promise<void> } => {
  const run = new Run({ workflow: wf('## fb\n'), engine: new FakeEngine() });
  runs.push(run);
  return { run, stepping: (async () => { for (let k = 0; k < 5 && run.status === 'running'; k++) await run.step(); })() };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The op waits for `release`; Stop comes first; then the op goes on. Returns the counter at the end. */
async function stopped(flags: Flags): Promise<{ counter: number; status: string }> {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  reg(flags, async (_i, vm) => { await held; vm.next(); });
  const { run, stepping } = start();
  await wait(5);
  const stopping = run.stop();
  await wait(10);
  release();
  await Promise.race([Promise.all([stepping, stopping]), wait(500)]);
  return { counter: run.snapshot().programCounter, status: run.status };
}

/** A block that works through its `exec` hook (a NODE instruction), not through an op. */
function regNode(flags: Flags, exec: NonNullable<NodeType['exec']>): void {
  disposers.push(register({ kind: 'fb', attrs: [], mod: { id: 'fb', events: [], ...flags }, compile(step, ctx) { ctx.push({ op: 'NODE', step: step.id, kind: 'fb', src: step } as never); }, exec }));
}

describe('M3 fix B item 7: the pack\'s NODE blocks run as before (found by marking the pack in the core tests)', () => {
  it('a pack block that answers "stay" does not pause the track; another mod\'s block does', async () => {
    regNode({ pack: true }, async () => 'stay');
    const a = start();
    await wait(30);
    expect(a.run.status).toBe('running');
    expect(a.run.pauseReason).toBeUndefined();
    disposers.pop()!();
    regNode({}, async () => 'stay');
    const b = start();
    await b.stepping;
    expect(b.run.status).toBe('paused');
    expect(b.run.pauseReason?.text).toContain('did not move on');
  });

  it('a pack block\'s exec, and a copy\'s, is not fenced: it logs an event no provides.events lists; the same exec from another mod is refused', async () => {
    for (const flags of [{ pack: true as const }, { builtin: true as const }]) {
      regNode(flags, async (_s, ctx) => { ctx.log('fb_ev', {}); return 'next'; });
      const a = start();
      await a.stepping;
      expect(a.run.status, JSON.stringify(flags)).toBe('done');
      disposers.pop()!();
    }
    for (const flags of [{}]) {
      regNode(flags, async (_s, ctx) => { ctx.log('fb_ev', {}); return 'next'; });
      const b = start();
      await b.stepping;
      expect(b.run.status, JSON.stringify(flags)).toBe('paused');
      disposers.pop()!();
    }
  });

  /** The exec of a NODE block waits for `release`; Stop comes first. Did the step settle before the exec did? */
  async function nodeStopped(flags: Flags): Promise<{ early: boolean }> {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let released = false, early = false;
    regNode(flags, async () => { await held; return 'next'; });
    const { run, stepping } = start();
    stepping.then(() => { early = !released; });
    await wait(5);
    const stopping = run.stop();
    await wait(10);
    released = true;
    release();
    await Promise.race([Promise.all([stepping, stopping]), wait(500)]);
    return { early };
  }

  it('Stop waits for the exec of a pack block and of a copy of one; another mod\'s block is raced with Stop', async () => {
    expect(await nodeStopped({ pack: true })).toEqual({ early: false });
    disposers.pop()!();
    expect(await nodeStopped({ builtin: true })).toEqual({ early: false });
    disposers.pop()!();
    expect(await nodeStopped({})).toEqual({ early: true });
  });
});

describe('M3 fix B item 8: Stop and a Customize copy', () => {
  it('Stop waits for the command of a copy of a built-in block: the instruction finishes and the counter moves on', async () => {
    expect(await stopped({ builtin: true })).toEqual({ counter: 1, status: 'stopped' });
  });

  it('...as for the built-in itself (the pack)', async () => {
    expect(await stopped({ pack: true })).toEqual({ counter: 1, status: 'stopped' });
  });

  it('...and still wins the race against any other mod\'s op', async () => {
    expect(await stopped({})).toEqual({ counter: 0, status: 'stopped' });
  });

  it('a copy is not fenced, as the built-in is: it logs an event its provides.events does not list', async () => {
    reg({ builtin: true }, async (_i, vm) => { vm.log('fb_ev', {}); vm.next(); });
    const { run, stepping } = start();
    await stepping;
    expect(run.status).toBe('done');
  });

  it('a copy that never settles does not hold stop() itself; the run is cut after the grace (see m3-fix2-e1-copy)', async () => {
    let release!: () => void;
    reg({ builtin: true }, () => new Promise<void>((r) => { release = r; }));
    const { run } = start();
    await wait(5);
    await Promise.race([run.stop(), wait(500).then(() => { throw new Error('stop() hung'); })]);
    expect(run.status).toBe('stopped');
    release();   // the op ends here so the run can close; the cut itself is m3-fix2-e1-copy
  });
});
