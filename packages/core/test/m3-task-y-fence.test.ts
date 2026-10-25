// M3 group Y: how the run treats the ops of a block of the default pack and the ops of any other mod. The pack's own ops run exactly as core's did (nothing fenced,
// nothing raced with Stop: a command in flight is waited for). Another mod's ops are fenced: they log only what `provides.events` lists, plus one thing, the `command_result`
// of their own step when their op says it `ranCommand` (a Customize copy of the `run` block needs it), and Stop wins the race.
import { afterEach, describe, expect, it } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { FakeEngine } from '../src/fake-engine.js';
import { register, type NodeType, type VmCtx } from '../src/nodes/index.js';
import { Run } from '../src/run.js';
import type { Instr } from '../src/compile.js';

declare module '../src/model.js' {
  interface NodeKinds { fz: true }
}
declare module '../src/compile.js' {
  interface Instrs { FZ: { step: string } }
}
declare module '../src/run.js' {
  interface RunEvents { fz_ev: unknown }
}

const wf = (body: string) => parseWorkflow(`---\nreins: 1\nname: t\nbudget: { turns: 9, minutes: 9 }\nalways: []\n---\n\n${body}\n`).workflow!;
const disposers: Array<() => void> = [];
const runs: Run[] = [];
afterEach(async () => {
  for (const r of runs.splice(0)) await r.close();
  for (const d of disposers.splice(0).reverse()) d();
});

type Exec = (i: Extract<Instr, { op: 'FZ' }>, vm: VmCtx) => Promise<void>;
function reg(o: { ran?: boolean; pack?: boolean; events?: string[]; exec: Exec }): void {
  const node: NodeType = {
    kind: 'fz', attrs: [], mod: { id: 'fz', events: o.events ?? [], ...(o.pack ? { pack: true as const } : {}) },
    compile(step, ctx) { ctx.push({ op: 'FZ', step: step.id }); },
    ops: { FZ: { exec: o.exec, ...(o.ran ? { ranCommand: true as const } : {}) } },
  };
  disposers.push(register(node));
}
async function go(body = '## fz\n'): Promise<Run> {
  const run = new Run({ workflow: wf(body), engine: new FakeEngine() });
  runs.push(run);
  for (let k = 0; k < 10 && run.status === 'running'; k++) await run.step();
  return run;
}
const types = (r: Run) => r.getEvents().map((e) => e.type);
const result = (step: string): Exec => async (_i, vm) => { vm.log('command_result', { step, exitCode: 0 }); vm.next(); };

describe('M3 group Y: the command_result an op may record', () => {
  it('a fenced op that runs a command records the result of its own step', async () => {
    reg({ ran: true, exec: result('fz-1') });
    const run = await go();
    expect(run.status).toBe('done');
    expect(run.getEvents().filter((e) => e.type === 'command_result').map((e) => e.data)).toEqual([{ step: 'fz-1', exitCode: 0 }]);
  });

  it('...not the result of another step (a step cannot mark another step failed)', async () => {
    reg({ ran: true, exec: result('somebody-else') });
    const run = await go();
    expect(run.status).toBe('paused');
    expect(run.pauseReason?.text).toContain('may not log "command_result"');
    expect(types(run)).not.toContain('command_result');
  });

  it('...and an op that does not say it runs a command records nothing of the kind', async () => {
    reg({ ran: false, exec: result('fz-1') });
    const run = await go();
    expect(run.status).toBe('paused');
    expect(run.pauseReason?.text).toContain('may not log "command_result"');
  });

  it('...and no other core event, even with ranCommand', async () => {
    reg({ ran: true, exec: async (_i, vm) => { vm.log('run_finished', {}); vm.next(); } });
    const run = await go();
    expect(run.status).toBe('paused');
    expect(run.pauseReason?.text).toContain('may not log "run_finished"');
  });
});

describe('M3 group Y: a block of the default pack runs as core\'s ops did', () => {
  it('its op is not fenced: it logs without a provides.events entry', async () => {
    reg({ pack: true, exec: async (_i, vm) => { vm.log('fz_ev', { a: 1 }); vm.next(); } });
    const run = await go();
    expect(run.status).toBe('done');
    expect(types(run)).toContain('fz_ev');
  });

  it('the same op from any other mod is refused', async () => {
    reg({ exec: async (_i, vm) => { vm.log('fz_ev', { a: 1 }); vm.next(); } });
    const run = await go();
    expect(run.status).toBe('paused');
    expect(run.pauseReason?.text).toContain('may not log "fz_ev"');
  });

  /** The op waits for `release`; Stop comes first; then the op goes on. Returns the counter at the end. */
  async function stopped(pack: boolean): Promise<{ counter: number; status: string }> {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    reg({ pack, exec: async (_i, vm) => { await held; vm.next(); } });
    const run = new Run({ workflow: wf('## fz\n'), engine: new FakeEngine() });
    runs.push(run);
    const stepping = (async () => { for (let k = 0; k < 5 && run.status === 'running'; k++) await run.step(); })();
    await new Promise((r) => setTimeout(r, 5));
    const stopping = run.stop();
    await new Promise((r) => setTimeout(r, 10));   // Stop has had its say before the instruction goes on
    release();
    await Promise.race([Promise.all([stepping, stopping]), new Promise((r) => setTimeout(r, 500))]);
    return { counter: run.snapshot().programCounter, status: run.status };
  }

  it('Stop does not cut it off: the instruction finishes and the counter moves on', async () => {
    expect(await stopped(true)).toEqual({ counter: 1, status: 'stopped' });
  });

  it('Stop wins the race against any other mod\'s op: the counter stays', async () => {
    expect(await stopped(false)).toEqual({ counter: 0, status: 'stopped' });
  });
});
