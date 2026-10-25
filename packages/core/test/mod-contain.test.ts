// M2 Task 16c, core side: a node that carries the loader's `mod` mark is stored guarded, and its ops run fenced. Every case here is one hostile thing a mod
// could do; the node is registered with `register()` directly (the loader is the server's side, see toy-block-hostile.test.ts).
import { afterEach, describe, expect, it } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { printWorkflow } from '../src/format/print.js';
import { validate } from '../src/validate.js';
import { compileProgram, type Instr } from '../src/compile.js';
import { FakeEngine } from '../src/fake-engine.js';
import { NODES, opOf, register, type NodeType, type OpType, type VmCtx } from '../src/nodes/index.js';
import { Run, type RunOptions } from '../src/run.js';
import { receipt } from '../src/receipt.js';
import { printCond } from '../src/cond.js';

declare module '../src/model.js' {
  interface NodeKinds { hostile: true }
}
declare module '../src/compile.js' {
  interface Instrs { HOSTILE: { step: string; [k: string]: unknown } }
}
declare module '../src/run.js' {
  interface RunEvents { hostile_ev: unknown; other_ev: unknown }
}

const head = '---\nreins: 1\nname: t\nbudget: { turns: 10, minutes: 10 }\nalways: []\n---\n\n';
const flow = (body = '## hostile\n') => parseWorkflow(head + body).workflow!;
const errors = (body = '## hostile\n') => validate(flow(body)).filter((d) => d.severity === 'error').map((d) => d.message);
const BIDI = String.fromCharCode(0x202e); // a right-to-left override, written so no source line holds it
const tick = () => new Promise<void>((r) => setImmediate(r));
type Exec = (i: Extract<Instr, { op: 'HOSTILE' }>, vm: VmCtx) => Promise<void>;
const msg = (e: unknown) => String((e as Error).message);

/** `p` or a failure after `ms`: a hung run must end the test fast, and its timer must not outlive it. */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${what}: still pending after ${ms} ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

const disposers: Array<() => void> = [];
const runs: Run[] = [];
afterEach(async () => {
  for (const r of runs.splice(0)) await within(r.close(), 2000, 'close');
  for (const d of disposers.splice(0).reverse()) d();
});

/** Registers the hostile kind as a mod's node: `over` replaces node members, `op` the HOSTILE op's, `events` is its `provides.events`. */
function reg(over: Partial<NodeType> = {}, op: Partial<OpType<any>> & { exec?: Exec } = {}, events = ['hostile_ev']) {
  disposers.push(register({
    kind: 'hostile', attrs: [], mod: { id: 'hostile', events },
    compile(step, ctx) { ctx.push({ op: 'HOSTILE', step: step.id }); },
    ops: { HOSTILE: { exec: async (_i, vm) => { vm.next(); }, ...op } },
    ...over,
  }));
}
function make(body = '## hostile\n', opts: Partial<RunOptions> = {}) {
  const run = new Run({ workflow: flow(body), engine: new FakeEngine(), ...opts });
  runs.push(run);
  return run;
}
const finish = async (run: Run) => { for (let k = 0; k < 20 && run.status === 'running'; k++) await run.step(); return run; };
const programOf = (run: Run) => (run as unknown as { program: Instr[] }).program;

describe('a hook that throws never breaks parsing, printing, validating or compiling', () => {
  const heading = (print: () => { text: string; condInHeading: boolean }, parse: () => boolean = () => false): NodeType['heading'] => ({ parse, print });

  it('heading.print throwing: saving still works, the heading is the kind', () => {
    reg({ heading: heading(() => { throw new Error('boom'); }) });
    const w = flow();
    expect(printWorkflow(w)).toBe(`${head}## hostile\n`);
  });

  it('heading.print: a line break and a long text come out as one capped line, nothing else starts a heading', () => {
    reg({ heading: heading(() => ({ text: `a\n## phase evil\n> x${'y'.repeat(5000)}`, condInHeading: false })) });
    const out = printWorkflow(flow());
    const lines = out.split('\n');
    expect(lines.filter((l) => l.startsWith('## '))).toHaveLength(1);
    expect(lines.find((l) => l.startsWith('## '))).toContain('a\\n## phase evil'); // the break is shown as \n: one line stays one line
    expect(lines.find((l) => l.startsWith('## '))!.length).toBeLessThan(220);
  });

  it('heading.print throwing a hostile error (a message getter that throws) is still caught', () => {
    reg({ heading: heading(() => { throw { get message() { throw new Error('inner'); } }; }) });
    expect(printWorkflow(flow())).toContain('## hostile');
  });

  it('heading.parse throwing: an error diagnostic, no exception out of parseWorkflow', () => {
    reg({ heading: heading(() => ({ text: 'hostile', condInHeading: false }), () => { throw new Error('boom'); }) });
    const r = parseWorkflow(`${head}## hostile arg\n`);
    expect(r.diagnostics.map((d) => d.severity)).toEqual(['error']);
    expect(r.diagnostics[0]!.message).toContain('boom');
    expect(r.diagnostics[0]!.message).toContain('block hostile');
  });

  for (const hook of ['early', 'late', 'links'] as const) {
    it(`validate.${hook} throwing: an error diagnostic, no exception out of validate`, () => {
      reg({ validate: { [hook]: () => { throw new Error('boom'); } } });
      const e = errors();
      expect(e).toHaveLength(1);
      expect(e[0]).toContain(`its ${hook} check`);
      expect(e[0]).toContain('boom');
    });
  }

  it('validate.program throwing: an error diagnostic', () => {
    reg({ validate: { program: () => { throw new Error('boom'); } } });
    expect(errors().join(' ')).toContain('its program check');
  });

  it('compile throwing: compileProgram does not throw, validate says why, a Run does not start', () => {
    reg({ compile() { throw new Error('boom'); } });
    const w = flow();
    expect(() => compileProgram(w)).not.toThrow();
    expect(errors().join(' ')).toContain('could not be compiled: boom');
    expect(() => new Run({ workflow: w, engine: new FakeEngine() })).toThrow('could not be compiled: boom');
  });

  it('defaultId and defaultPrompt throwing: the default id and no prompt', () => {
    reg({ defaultId() { throw new Error('boom'); }, defaultPrompt() { throw new Error('boom'); } });
    expect(flow().steps[0]!.id).toBe('hostile-1');
  });

  it('a count or print record that is not an object is dropped, not thrown', () => {
    reg({ count: 5 as never, print: 'x' as never });
    expect(NODES.get('hostile')!.count).toBeUndefined();
    expect(NODES.get('hostile')!.print).toBeUndefined();
  });

  it('ops.commands throwing: a `!` line that names the block and the op, never an exception', () => {
    reg({}, { commands: () => { throw new Error('boom'); } });
    const out = opOf('HOSTILE')!.commands!({ op: 'HOSTILE', step: 'h' } as Instr);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^! block hostile, the commands of HOSTILE: boom$/);
  });

  it('ops.commands returning something else than a list of strings: only the strings', () => {
    reg({}, { commands: () => ['ls', 5, null, { x: 1 }, 'pwd'] as never });
    expect(opOf('HOSTILE')!.commands!({ op: 'HOSTILE', step: 'h' } as Instr)).toEqual(['ls', 'pwd']);
  });

  it('ops.starts and ops.next throwing name a place that is no place, so the program check refuses the workflow', () => {
    reg({}, { starts: () => { throw new Error('boom'); } });
    expect(errors().join(' ')).toContain('which is not a place in the program');
    disposers.pop()!();
    reg({}, { next: () => { throw new Error('boom'); } });
    expect(errors().join(' ')).toContain('which is not a place in the program');
  });

  it('ops.allowMore: a throw or a value that is not an index gives undefined', () => {
    reg({}, { allowMore: () => { throw new Error('boom'); } });
    expect(opOf('HOSTILE')!.allowMore!({ op: 'HOSTILE', step: 'h' } as Instr)).toBeUndefined();
    disposers.pop()!();
    reg({}, { allowMore: () => -3 });
    expect(opOf('HOSTILE')!.allowMore!({ op: 'HOSTILE', step: 'h' } as Instr)).toBeUndefined();
  });
});

describe('what a mod counts and prints is one visible, capped line', () => {
  it('a control character is shown, a long line is cut, a throw is nothing, and the event data is a copy', () => {
    reg({
      count: { hostile_ev: (d: { n: number }) => { d.n = 99; return 'hits'; }, other_ev: () => { throw new Error('boom'); } },
      print: { hostile_ev: (d: { text: string }) => d.text, other_ev: () => { throw new Error('boom'); } },
    });
    const n = NODES.get('hostile')!;
    const data = { n: 1, text: '\u001b[31mred' + BIDI + '\n' + 'z'.repeat(2000) };
    const line = n.print!.hostile_ev!(data)!;
    expect(line).toContain('<U+001B>');
    expect(line).toContain('<U+202E>');
    expect(line).toContain('<U+202E>\\nzzz');
    expect(line).not.toMatch(new RegExp('[\\u001b' + BIDI + '\\n]'));
    expect(line.length).toBeLessThanOrEqual(303);
    expect(n.print!.other_ev!({})).toBeUndefined();
    expect(n.count!.other_ev!({})).toBeUndefined();
    expect(n.count!.hostile_ev!(data)).toBe('hits');
    expect(data.n).toBe(1); // the hook worked on a copy
  });

  it('a count key is capped and cannot be __proto__', () => {
    reg({ count: { hostile_ev: (d: { k: string }) => d.k, other_ev: () => '__proto__' } });
    const n = NODES.get('hostile')!;
    expect(n.count!.hostile_ev!({ k: 'k'.repeat(500) })!.length).toBeLessThanOrEqual(43);
    expect(n.count!.other_ev!({})).toBeUndefined();
  });

  it('the receipt counts through the guarded hook and a hook that changes its data changes no event', () => {
    reg({ count: { hostile_ev: (d: { n: number }) => { d.n = 99; return 'hits'; } } });
    const ev = { id: 'ev-1', timestamp: 1, type: 'hostile_ev' as const, data: { n: 1 } };
    const r = receipt([ev]);
    expect(r.counts).toEqual({ hits: 1 });
    expect(ev.data.n).toBe(1);
  });
});

describe('the node is copied once and stored guarded', () => {
  it('a getter that answers differently the second time has no effect on what runs', async () => {
    let reads = 0;
    const node: NodeType = {
      kind: 'hostile', attrs: [], mod: { id: 'hostile', events: [] },
      compile(step, ctx) { ctx.push({ op: 'HOSTILE', step: step.id }); },
      get ops(): Record<string, OpType<any>> {
        return reads++ === 0
          ? { HOSTILE: { exec: async (_i: unknown, vm: VmCtx) => { vm.next(); } } }
          : { EVIL: { exec: async () => { throw new Error('evil ran'); } } };
      },
    };
    disposers.push(register(node));
    expect(Object.keys(NODES.get('hostile')!.ops!)).toEqual(['HOSTILE']);
    expect(opOf('EVIL')).toBeUndefined();
    expect((await finish(make())).status).toBe('done');
    expect(Object.keys(NODES.get('hostile')!.ops!)).toEqual(['HOSTILE']);
  });

  it('an op whose exec is a getter is read once', async () => {
    let reads = 0;
    const op = { get exec() { return reads++ === 0 ? async (_i: unknown, vm: VmCtx) => { vm.next(); } : async () => { throw new Error('second read'); }; } };
    disposers.push(register({ kind: 'hostile', attrs: [], mod: { id: 'hostile', events: [] }, compile(s, c) { c.push({ op: 'HOSTILE', step: s.id }); }, ops: { HOSTILE: op as never } }));
    expect((await finish(make())).status).toBe('done');
    expect((await finish(make())).status).toBe('done');
  });

  it('the stored node and its ops are frozen', () => {
    reg();
    expect(Object.isFrozen(NODES.get('hostile'))).toBe(true);
    expect(Object.isFrozen(NODES.get('hostile')!.ops)).toBe(true);
    expect(Object.isFrozen(opOf('HOSTILE'))).toBe(true);
  });

  it('a mark that is not an id and a list of events is refused, and nothing is added', () => {
    const before = [...NODES.keys()];
    expect(() => { disposers.push(register({ kind: 'hostile', attrs: [], mod: { id: 1 as never, events: [] }, compile() {} })); }).toThrow('mod mark');
    expect(() => { disposers.push(register({ kind: 'hostile', attrs: [], mod: { id: 'x', events: [5 as never] }, compile() {} })); }).toThrow('mod mark');
    expect([...NODES.keys()]).toEqual(before);
  });

  it('a mod naming a core op is still refused', () => {
    const before = [...NODES.keys()];
    for (const name of ['TURN', 'JUMP', 'END', 'NODE']) {
      expect(() => { disposers.push(register({ kind: 'hostile', attrs: [], mod: { id: 'x', events: [] }, compile() {}, ops: { [name]: { exec: async () => {} } } })); }, name).toThrow('is a core op');
    }
    expect([...NODES.keys()]).toEqual(before);
  });

  it('a node WITHOUT the mark is stored as it is, and its ops run unfenced (core kinds are unchanged)', async () => {
    const node: NodeType = {
      kind: 'hostile', attrs: [], compile(step, ctx) { ctx.push({ op: 'HOSTILE', step: step.id }); },
      ops: { HOSTILE: { exec: async (_i, vm) => { vm.log('other_ev', { free: true }); vm.next(); } } },
    };
    disposers.push(register(node));
    expect(NODES.get('hostile')).toBe(node);
    const run = await finish(make());
    expect(run.status).toBe('done');
    expect(run.getEvents().some((e) => e.type === 'other_ev')).toBe(true);
  });
});

describe('the program check', () => {
  const jump = (target: unknown) => reg({ compile(step, ctx) { ctx.push({ op: 'JUMP', target: target as number, step: step.id }); } });

  for (const [label, target] of [['NaN', NaN], ['-1', -1], ['1.5', 1.5], ['past the end', 3], ['Infinity', Infinity], ['a string', '1'], ['undefined', undefined]] as const) {
    it(`a JUMP to ${label} fails the check: validate says so and the run does not start`, () => {
      jump(target);
      expect(errors().join(' ')).toContain('which is not a place in the program');
      expect(() => new Run({ workflow: flow(), engine: new FakeEngine() })).toThrow('which is not a place in the program');
    });
  }

  it('a JUMP to 0, to a later place and to the length (the end) passes', async () => {
    // program: [JUMP target, END]; the length is 2
    jump(2);
    expect(errors()).toEqual([]);
    expect((await finish(make())).status).toBe('done');
  });

  it('a start or next that is not an index fails the check', () => {
    reg({}, { starts: () => [99] });
    expect(errors().join(' ')).toContain('leads to 99');
    disposers.pop()!();
    reg({}, { next: () => [1.5] });
    expect(errors().join(' ')).toContain('leads to 1.5');
  });

  it('an instruction no loaded kind owns is an error for validate (a Run still starts and pauses on it)', () => {
    reg({ compile(step, ctx) { ctx.push({ op: 'GHOST', step: step.id } as never); } });
    expect(errors().join(' ')).toContain('needs a block that is not loaded (GHOST)');
    expect(() => new Run({ workflow: flow(), engine: new FakeEngine() })).not.toThrow();
  });

  it('what a mod compiles is a frozen copy: a handle the mod kept changes nothing', () => {
    let kept: { target: number } | undefined;
    reg({ compile(step, ctx) { kept = ctx.push({ op: 'JUMP', target: 1, step: step.id }); } });
    const p = compileProgram(flow());
    expect(Object.isFrozen(p[0])).toBe(true);
    kept!.target = NaN;
    expect((p[0] as { target: number }).target).toBe(1);
  });

  it('an instruction holding something that is not plain data is a failed compile, not a crash', () => {
    reg({ compile(step, ctx) { ctx.push({ op: 'HOSTILE', step: step.id, f: () => 1 }); } });
    expect(errors().join(' ')).toContain('holds more than plain data');
  });
});

describe('an op that never settles', () => {
  const never: Exec = async () => { await new Promise<void>(() => {}); };

  it('does not hold Stop: step() returns at once and the run is stopped', async () => {
    let started!: () => void;
    const up = new Promise<void>((r) => { started = r; });
    reg({}, { exec: async (i, vm) => { started(); await never(i, vm); } });
    const run = make();
    const stepping = run.step();
    await up;
    await within(run.stop(), 2000, 'stop');
    expect(await within(stepping, 2000, 'step')).toBe('stopped');
    expect(run.status).toBe('stopped');
  });

  it('does not hold close() either', async () => {
    let started!: () => void;
    const up = new Promise<void>((r) => { started = r; });
    reg({}, { exec: async (i, vm) => { started(); await never(i, vm); } });
    const run = make();
    const stepping = run.step();
    await up;
    await within(run.close(), 2000, 'close');
    await within(stepping, 2000, 'step');
  });

  it('a NODE exec of a mod kind that never settles does not hold Stop', async () => {
    let started!: () => void;
    const up = new Promise<void>((r) => { started = r; });
    reg({
      compile(step, ctx) { ctx.push({ op: 'NODE', step: step.id, kind: 'hostile', src: step }); },
      exec: async () => { started(); await new Promise<void>(() => {}); return 'next'; },
    }, undefined, []);
    const run = make();
    const stepping = run.step();
    await up;
    await run.stop();
    expect(await within(stepping, 2000, 'step')).toBe('stopped');
  });

  it('the late write of an exec that settles after Stop is dropped', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const up = new Promise<void>((r) => { started = r; });
    const late: string[] = [];
    const ran: string[] = [];
    reg({}, {
      commands: () => ['echo hi'],
      exec: async (_i, vm) => {
        started();
        await gate;
        const tryIt = async (name: string, f: () => unknown) => { try { await f(); late.push(`${name}: written`); } catch (e) { late.push(`${name}: ${msg(e)}`); } };
        await tryIt('log', () => vm.log('hostile_ev', { late: true }));
        await tryIt('next', () => vm.next());
        await tryIt('goto', () => vm.goto(0));
        await tryIt('command', () => vm.command('echo hi'));
        await tryIt('pause', () => vm.pause({ type: 'stop', text: 'late' }));
        await tryIt('handBack', () => vm.handBack('late'));
      },
    });
    const run = make('## hostile\n', { commandRunner: async (c) => { ran.push(c); return { exitCode: 0, stdout: '', stderr: '' }; } });
    const stepping = run.step();
    await up;
    await run.stop();
    await within(stepping, 2000, 'step');
    const before = JSON.stringify(run.getEvents().map((e) => e.type));
    release();
    await tick(); await tick();
    expect(late).toHaveLength(6);
    for (const l of late) expect(l, l).toContain('this instruction is over');
    expect(ran).toEqual([]);
    expect(JSON.stringify(run.getEvents().map((e) => e.type))).toBe(before);
    expect(run.status).toBe('stopped');
    expect(run.snapshot().programCounter).toBe(0);
  });

  it('a vm kept after the instruction ended refuses every call', async () => {
    let kept!: VmCtx;
    reg({}, { exec: async (_i, vm) => { kept = vm; vm.next(); } });
    const run = await finish(make());
    expect(run.status).toBe('done');
    expect(() => kept.next()).toThrow('this instruction is over');
    expect(() => kept.log('hostile_ev', {})).toThrow('this instruction is over');
    expect(() => kept.goto(0)).toThrow('this instruction is over');
    expect(run.snapshot().programCounter).toBe(1);
  });
});

describe('what a mod op may do with the vm', () => {
  it('goto to a place that is not one pauses the track with words and moves nothing', async () => {
    for (const bad of [99, NaN, -1, 1.5, 'x']) {
      const outcome: string[] = [];
      reg({}, { exec: async (_i, vm) => { try { vm.goto(bad as number); } catch (e) { outcome.push(msg(e)); } vm.next(); } });
      const run = make();
      expect(await run.step(), String(bad)).toBe('paused');
      expect(run.pauseReason!.type).toBe('stop');
      expect(run.pauseReason!.text, String(bad)).toContain('not a place in the program');
      expect(run.snapshot().programCounter, String(bad)).toBe(0); // the later next() was refused too
      expect(outcome).toHaveLength(1);
      await run.close();
      disposers.pop()!();
    }
  });

  it('goto to a real place moves the run', async () => {
    reg({}, { exec: async (_i, vm) => { vm.goto(1); } });
    const run = make();
    await run.step();
    expect(run.snapshot().programCounter).toBe(1);
  });

  it('a track started at a place that is not one pauses the track', async () => {
    reg({}, { exec: async (_i, vm) => { vm.tracks.start('g', [{ key: 'k', at: 99, title: 'T' }]); } });
    const run = make();
    expect(await run.step()).toBe('paused');
    expect(run.pauseReason!.text).toContain('not a place in the program');
    expect(run.tracks.size).toBe(0);
  });

  it('a throw of its own pauses the track in words; the message is one capped visible line', async () => {
    reg({}, { exec: async () => { throw new Error(`bad\u001b[31m ${'x'.repeat(2000)}`); } });
    const run = make();
    expect(await run.step()).toBe('paused');
    const text = run.pauseReason!.text!;
    expect(text).toContain('The block "hostile" failed in its instruction HOSTILE');
    expect(text).toContain('<U+001B>');
    expect(text).toContain('Resume tries again');
    expect(text.length).toBeLessThan(400);
  });

  it('a throw that is not an object, a sync throw and a hostile error are all the mod\'s own', async () => {
    for (const thrown of ['a string', 42, null, undefined, { get message() { throw new Error('inner'); } }]) {
      reg({}, { exec: (() => { throw thrown; }) as never });
      const run = make();
      expect(await run.step(), String(thrown)).toBe('paused');
      await run.close();
      disposers.pop()!();
    }
  });

  it('a rejection from a vm member keeps today\'s path: it comes out of step(), as it does for a core op', async () => {
    reg({}, { commands: () => ['npm test'], exec: async (_i, vm) => { await vm.command('npm test'); vm.next(); } });
    const down = async () => { throw new Error('runner down'); };
    await expect(make('## hostile\n', { commandRunner: down }).step()).rejects.toThrow('runner down');
    disposers.pop()!();
    // the same failure in a core kind's op (no mark): the same path
    disposers.push(register({ kind: 'hostile', attrs: [], compile(s, c) { c.push({ op: 'HOSTILE', step: s.id }); }, ops: { HOSTILE: { exec: async (_i: unknown, vm: VmCtx) => { await vm.command('npm test'); vm.next(); } } } }));
    await expect(make('## hostile\n', { commandRunner: down }).step()).rejects.toThrow('runner down');
  });

  it('a throw (not a rejection) from a vm member keeps today\'s path too', async () => {
    reg({}, { exec: async (_i, vm) => { vm.tracks.start('g', [{ key: '', at: 0, title: 'T' }]); } });
    await expect(make().step()).rejects.toThrow('track "" is live');
  });

  it('a mod that catches the vm error and throws its own is paused, not propagated', async () => {
    reg({}, { commands: () => ['npm test'], exec: async (_i, vm) => { try { await vm.command('npm test'); } catch { throw new Error('mine'); } } });
    const run = make('## hostile\n', { commandRunner: async () => { throw new Error('runner down'); } });
    expect(await run.step()).toBe('paused');
    expect(run.pauseReason!.text).toContain('mine');
  });

  it('a core kind\'s op that throws is not caught: it comes out of step() (unchanged)', async () => {
    disposers.push(register({ kind: 'hostile', attrs: [], compile(s, c) { c.push({ op: 'HOSTILE', step: s.id }); }, ops: { HOSTILE: { exec: async () => { throw new Error('core boom'); } } } }));
    await expect(make().step()).rejects.toThrow('core boom');
  });

  it('vm.command: a command the op does not list is refused and never runs; a listed one runs and is recorded', async () => {
    const ran: string[] = [];
    const out: string[] = [];
    reg({}, {
      commands: () => ['echo hi'],
      exec: async (_i, vm) => {
        for (const c of ['rm x', 'echo hi ', 5 as never, 'echo hi']) { try { await vm.command(c); out.push(`ran ${String(c)}`); } catch (e) { out.push(msg(e)); } }
        vm.next();
      },
    });
    const run = make('## hostile\n', { commandRunner: async (c) => { ran.push(c); return { exitCode: 0, stdout: 'ok', stderr: '' }; } });
    await finish(run);
    expect(ran).toEqual(['echo hi']);
    expect(out[0]).toContain('may not run "rm x"');
    expect(out[1]).toContain('may not run "echo hi "');
    expect(out[2]).toContain('may not run "5"');
    expect(out[3]).toBe('ran echo hi');
    expect(run.status).toBe('done');
  });

  it('vm.command refuses everything when commands() throws (the list is the fault line)', async () => {
    const ran: string[] = [];
    reg({}, { commands: () => { throw new Error('boom'); }, exec: async (_i, vm) => { await vm.command('echo hi'); } });
    const run = make('## hostile\n', { commandRunner: async (c) => { ran.push(c); return { exitCode: 0, stdout: '', stderr: '' }; } });
    expect(await run.step()).toBe('paused');
    expect(ran).toEqual([]);
  });

  it('vm.judge of a command atom the op does not list is refused too (a judge is a way to run a command)', async () => {
    const ran: string[] = [];
    const out: string[] = [];
    const cond = { t: 'cmd', cmd: 'rm x' } as never;
    reg({}, {
      commands: () => [printCond({ t: 'cmd', cmd: 'ls' } as never)],
      exec: async (_i, vm) => {
        try { await vm.judge(cond); out.push('judged'); } catch (e) { out.push(msg(e)); }
        try { await vm.judge({ t: 'cmd', cmd: 'ls' } as never); out.push('judged ls'); } catch (e) { out.push(msg(e)); }
        vm.next();
      },
    });
    const run = make('## hostile\n', { commandRunner: async (c) => { ran.push(c); return { exitCode: 0, stdout: '', stderr: '' }; } });
    await finish(run);
    expect(out[0]).toContain('may not run');
    expect(out[1]).toBe('judged ls');
    expect(ran).toEqual(['ls']);
  });

  it('vm.log: an event the mod did not declare is refused; a declared one is logged with a copy of its data', async () => {
    const out: string[] = [];
    reg({}, {
      exec: async (_i, vm) => {
        for (const ev of ['other_ev', 'run_finished', 'hostile_ev'] as const) { try { vm.log(ev, { n: 1 }); out.push(`logged ${ev}`); } catch (e) { out.push(msg(e)); } }
        const data = { n: 1 };
        vm.log('hostile_ev', data);
        data.n = 2;
        vm.next();
      },
    });
    const run = await finish(make());
    expect(out[0]).toContain('may not log "other_ev"');
    expect(out[1]).toContain('may not log "run_finished"');
    expect(out[2]).toBe('logged hostile_ev');
    const logged = run.getEvents().filter((e) => e.type === 'hostile_ev').map((e) => e.data);
    expect(logged).toEqual([{ n: 1 }, { n: 1 }]);
    expect(run.getEvents().some((e) => e.type === 'other_ev')).toBe(false);
    expect(run.getEvents().filter((e) => e.type === 'run_finished')).toHaveLength(1); // the run's own, once
  });

  it('vm.log with data that cannot be copied is refused', async () => {
    const out: string[] = [];
    reg({}, { exec: async (_i, vm) => { try { vm.log('hostile_ev', { f: () => 1 }); } catch (e) { out.push(msg(e)); } vm.next(); } });
    await finish(make());
    expect(out).toHaveLength(1);
  });

  it('an op works on copies: the instruction, vm.program and vm.outputs are not the run\'s own', async () => {
    reg({}, {
      exec: async (i, vm) => {
        (i as { step: string }).step = 'changed';
        (vm.program[0] as { op: string }).op = 'CHANGED';
        (vm.program as Instr[]).push({ op: 'END' });
        (vm.outputs as Map<string, string>).set('x', 'y');
        vm.next();
      },
    });
    const run = await finish(make());
    expect(run.status).toBe('done');
    expect(programOf(run)[0]!.op).toBe('HOSTILE');
    expect((programOf(run)[0] as { step: string }).step).toBe('hostile-1');
    expect(programOf(run)).toHaveLength(2);
    expect(run.snapshot().turnOutputs).toEqual({});
  });

  it('the vm cannot be written to', async () => {
    const out: string[] = [];
    reg({}, {
      exec: async (_i, vm) => {
        for (const f of [() => { (vm as { next: unknown }).next = () => {}; }, () => { delete (vm as { goto?: unknown }).goto; }, () => { (vm.tracks as { start: unknown }).start = 1; }, () => Object.defineProperty(vm, 'x', { value: 1 })]) {
          try { f(); out.push('written'); } catch (e) { out.push(msg(e)); }
        }
        vm.next();
      },
    });
    await finish(make());
    expect(out.every((m) => m !== 'written')).toBe(true);
    expect(out).toHaveLength(4);
  });

  it('a NODE exec of a mod kind: an event it did not declare is refused, a declared one is logged', async () => {
    const out: string[] = [];
    reg({
      compile(step, ctx) { ctx.push({ op: 'NODE', step: step.id, kind: 'hostile', src: step }); },
      exec: async (_step, ctx) => {
        try { ctx.log('other_ev', {}); out.push('logged'); } catch (e) { out.push(msg(e)); }
        ctx.log('hostile_ev', { ok: 1 });
        return 'next';
      },
    }, undefined);
    const run = await finish(make());
    expect(run.status).toBe('done');
    expect(out[0]).toContain('may not log "other_ev"');
    expect(run.getEvents().filter((e) => e.type === 'hostile_ev')).toHaveLength(1);
    expect(run.getEvents().some((e) => e.type === 'other_ev')).toBe(false);
  });

  it('a NODE exec that throws pauses the track', async () => {
    reg({
      compile(step, ctx) { ctx.push({ op: 'NODE', step: step.id, kind: 'hostile', src: step }); },
      exec: async () => { throw new Error('node boom'); },
    });
    const run = make();
    expect(await run.step()).toBe('paused');
    expect(run.pauseReason!.text).toContain('node boom');
  });
});

describe('a hook works on a copy of the step, and an op keeps only a true ranCommand', () => {
  const hurt = (step: { id: string; attrs: Record<string, string>; cards: unknown[] }) => { step.attrs.x = 'evil'; step.id = 'zz'; step.cards.push({ kind: 'guard', text: 'evil' }); };
  const body = '## hostile\nmode: read-only\n';

  it('a heading.print that changes its step changes nothing: the workflow is the same after printWorkflow, and the heading is fine', () => {
    reg({ heading: { parse: () => false, print: (step) => { hurt(step as never); return { text: 'hostile', condInHeading: false }; } } });
    const w = flow(body);
    const before = JSON.stringify(w);
    expect(printWorkflow(w)).toContain('## hostile\n');
    expect(JSON.stringify(w)).toBe(before);
  });

  for (const hook of ['early', 'late', 'links', 'program'] as const) {
    it(`a validate.${hook} that changes its step changes nothing: the workflow is byte-identical after validate`, () => {
      let ran = 0;
      reg({ validate: { [hook]: (step: never) => { ran++; hurt(step); } } });
      const w = flow(body);
      const before = JSON.stringify(w);
      validate(w);
      expect(ran, 'the hook ran').toBeGreaterThan(0);
      expect(JSON.stringify(w)).toBe(before);
    });
  }

  const atRun = (flag: unknown) => {
    reg({}, { ranCommand: flag as never });
    const run = make() as unknown as { evalCtx(t: unknown): { atRun: boolean }; main: unknown };
    return { stored: opOf('HOSTILE')!.ranCommand, atRun: run.evalCtx(run.main).atRun };
  };

  it('a mod op declared ranCommand: true stays marked, and core then judges its conditions as right after a command (atRun)', () => {
    expect(atRun(true)).toEqual({ stored: true, atRun: true });
  });

  it('a mod op without ranCommand, or with a value that is not true, is not marked', () => {
    expect(atRun(undefined)).toEqual({ stored: undefined, atRun: false });
    disposers.pop()!();
    for (const flag of ['yes', 1, {}, false]) {
      expect(atRun(flag), String(flag)).toEqual({ stored: undefined, atRun: false });
      disposers.pop()!();
    }
  });
});
