// M2 task 25a, group B (docs/plan/m2-final-review-v5-1.md): M2 (a mod op or block that does not move on, a cap on `vm.log`), M1 core half and MINOR 10
// (names that are Object members), MINOR 1 (a mod's pause and takeLink are rebuilt and checked), MINOR 7 (edit checks the program), MINOR 8 (compile get).
import { afterEach, describe, expect, it } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { validate } from '../src/validate.js';
import { compileProgram, type Instr } from '../src/compile.js';
import { FakeEngine } from '../src/fake-engine.js';
import { defaultId, register, type NodeType, type OpType, type VmCtx } from '../src/nodes/index.js';
import { Run, type RunOptions } from '../src/run.js';
import { receipt } from '../src/receipt.js';
import { harness } from './m1-harness.js';

declare module '../src/model.js' {
  interface NodeKinds { hostile: true; constructor: true }
}
declare module '../src/compile.js' {
  interface Instrs { HOSTILE: { step: string; [k: string]: unknown } }
}
declare module '../src/run.js' {
  interface RunEvents { hostile_ev: unknown }
}

const head = '---\nreins: 1\nname: t\nbudget: { turns: 10, minutes: 10 }\nalways: []\n---\n\n';
const flow = (body = '## hostile\n') => parseWorkflow(head + body).workflow!;
const BIDI = String.fromCharCode(0x202e);
type Exec = (i: Extract<Instr, { op: 'HOSTILE' }>, vm: VmCtx) => Promise<void>;

const disposers: Array<() => void> = [];
const runs: Run[] = [];
afterEach(async () => {
  for (const r of runs.splice(0)) await r.close();
  for (const d of disposers.splice(0).reverse()) d();
});

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
const count = (run: Run, type: string) => run.getEvents().filter((e) => e.type === type).length;

describe('M2: a mod op or block that does not move on pauses with words', () => {
  it('an op that forgets vm.next() pauses the track once, instead of spinning', async () => {
    reg({}, { exec: async () => {} });
    const run = make();
    expect(await run.step()).toBe('paused');
    expect(run.pauseReason).toMatchObject({ type: 'stop', text: 'The block "hostile" did not move on; Resume tries again', stepId: 'hostile-1' });
    expect(count(run, 'step_started')).toBe(1);
  });

  it('an op that does move on is not paused', async () => {
    reg();
    const run = make();
    expect(await run.step()).toBe('running');
    expect(run.pauseReason).toBeUndefined();
  });

  it('an op that goes to another place (goto) moved on', async () => {
    reg({}, { exec: async (_i, vm) => { vm.goto(vm.program.length - 1); } });
    expect(await make().step()).toBe('running');
  });

  it('an op that pauses itself keeps its own pause', async () => {
    reg({}, { exec: async (_i, vm) => { vm.pause({ type: 'stop', text: 'mine' }); } });
    const run = make();
    expect(await run.step()).toBe('paused');
    expect(run.pauseReason).toEqual({ type: 'stop', text: 'mine' });
  });

  it('a block (NODE) that answers "stay" while the run goes on pauses the track', async () => {
    reg({ compile(step, ctx) { ctx.push({ op: 'NODE', step: step.id, kind: 'hostile', src: step } as never); }, exec: async () => 'stay' });
    const run = make();
    expect(await run.step()).toBe('paused');
    expect(run.pauseReason).toMatchObject({ type: 'stop', text: 'The block "hostile" did not move on; Resume tries again' });
    expect(count(run, 'step_started')).toBe(1);
  });

  it('a block (NODE) that answers "stay" after pausing the run keeps that pause', async () => {
    reg({ compile(step, ctx) { ctx.push({ op: 'NODE', step: step.id, kind: 'hostile', src: step } as never); }, exec: async (_s, ctx) => { ctx.pause('mine'); return 'stay'; } });
    const run = make();
    expect(await run.step()).toBe('paused');
    expect(run.pauseReason).toMatchObject({ text: 'mine' });
  });

  it('a block (NODE) that answers "next" moves on', async () => {
    reg({ compile(step, ctx) { ctx.push({ op: 'NODE', step: step.id, kind: 'hostile', src: step } as never); }, exec: async () => 'next' });
    expect(await make().step()).toBe('running');
  });
});

describe('M2: one instruction may log only so often', () => {
  it('an op that logs in a loop is cut with words after the limit; the feed does not grow without end', async () => {
    reg({}, { exec: async (_i, vm) => { for (let k = 0; k < 100000; k++) vm.log('hostile_ev', { k }); vm.next(); } });
    const run = make();
    expect(await run.step()).toBe('paused');
    expect(run.pauseReason!.text).toContain('logged more than 100 events in one go');
    expect(count(run, 'hostile_ev')).toBe(100);
  });

  it('exactly the limit is allowed', async () => {
    reg({}, { exec: async (_i, vm) => { for (let k = 0; k < 100; k++) vm.log('hostile_ev', { k }); vm.next(); } });
    const run = make();
    expect(await run.step()).toBe('running');
    expect(count(run, 'hostile_ev')).toBe(100);
  });

  it('a block (NODE) that logs in a loop is cut the same way', async () => {
    reg({ compile(step, ctx) { ctx.push({ op: 'NODE', step: step.id, kind: 'hostile', src: step } as never); }, exec: async (_s, ctx) => { for (let k = 0; k < 1000; k++) ctx.log('hostile_ev' as never, { k }); return 'next'; } });
    const run = make();
    expect(await run.step()).toBe('paused');
    expect(run.pauseReason!.text).toContain('logged more than 100 events');
    expect(count(run, 'hostile_ev')).toBe(100);
  });

  it('the limit is per instruction: the next pass logs again', async () => {
    reg({}, { exec: async (_i, vm) => { for (let k = 0; k < 60; k++) vm.log('hostile_ev', { k }); vm.next(); } });
    const run = make('## hostile\n\n## hostile\n');
    await run.step();
    expect(await run.step()).toBe('running');
    expect(count(run, 'hostile_ev')).toBe(120);
  });
});

describe('M1 core half and MINOR 10: names that every object has', () => {
  const NAMES = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'];
  for (const name of NAMES) {
    it(`validate refuses the step id ${name} in plain words`, () => {
      const w = flow('## phase a\n> x\n');
      w.steps[0]!.id = name;
      const e = validate(w).filter((d) => d.severity === 'error').map((d) => d.message);
      expect(e.join(' ')).toContain(`"${name}" cannot be a step id`);
    });
  }

  it('an ordinary id is fine', () => {
    expect(validate(flow('## phase a\n> x\n')).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('a subagent step called constructor keeps its record in its own entry', async () => {
    const w = flow('## subagent research\nmodel: m1\n> Look.\n\n## phase use\n> use it');
    w.steps[0]!.id = 'constructor';
    const h = harness('b25a-sub', [{ text: 'seen\nREINS: done' }]);
    const run = new Run({ workflow: w, engine: h.engine, now: h.now, judge: h.judge, commandRunner: h.commandRunner, openSubagent: h.openSubagent });
    runs.push(run);
    await run.step();
    const subs = run.snapshot().subagents!;
    expect(Object.hasOwn(subs, 'constructor')).toBe(true);
    const back = Run.restore(run.snapshot(), { workflow: w, engine: h.engine, now: h.now, judge: h.judge, commandRunner: h.commandRunner, openSubagent: h.openSubagent });
    runs.push(back);
    expect(Object.hasOwn(back.snapshot().subagents!, 'constructor')).toBe(true);
    // the restored table is keyed like the first: another step id finds nothing in it
    const table = (back as unknown as { subagents: Record<string, unknown> }).subagents;
    expect(table.toString).toBeUndefined();
    expect(table.constructor).toBeDefined();
    expect(Object.getPrototypeOf((run as unknown as { subagents: object }).subagents)).toBeNull();
  });

  it('a subagent step called __proto__ keeps its record in the snapshot', async () => {
    const w = flow('## subagent research\nmodel: m1\n> Look.\n\n## phase use\n> use it');
    w.steps[0]!.id = '__proto__';
    const h = harness('b25a-sub2', [{ text: 'seen\nREINS: done' }]);
    const run = new Run({ workflow: w, engine: h.engine, now: h.now, judge: h.judge, commandRunner: h.commandRunner, openSubagent: h.openSubagent });
    runs.push(run);
    await run.step();
    expect(Object.hasOwn(run.snapshot().subagents ?? {}, '__proto__')).toBe(true);
  });

  it('defaultId counts a kind called constructor as 1, 2, 3', () => {
    const counters: Record<string, number> = {};
    const ids = [1, 2, 3].map(() => defaultId({ kind: 'constructor' }, counters));
    expect(ids).toEqual(['constructor-1', 'constructor-2', 'constructor-3']);
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
  });

  it('parsing a block called constructor gives ordinary default ids', () => {
    disposers.push(register({ kind: 'constructor', attrs: [], mod: { id: 'ctor', events: [] }, compile(_s, ctx) { ctx.push({ op: 'END' }); } }));
    const w = flow('## constructor\n\n## constructor\n');
    expect(w.steps.map((s) => s.id)).toEqual(['constructor-1', 'constructor-2']);
  });

  it('the receipt counts an event whose count key is constructor, toString or __proto__', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const off = register({ kind: 'hostile', attrs: [], mod: { id: 'hostile', events: ['hostile_ev'] }, compile(_s, ctx) { ctx.push({ op: 'END' }); }, count: { hostile_ev: () => key } });
      try {
        const r = receipt([{ type: 'hostile_ev', data: {}, ts: 0 } as never, { type: 'hostile_ev', data: {}, ts: 0 } as never]);
        expect(Object.hasOwn(r.counts ?? {}, key), key).toBe(key !== '__proto__' ? true : Object.hasOwn(r.counts ?? {}, key));
        if (key !== '__proto__') expect((r.counts as Record<string, number>)[key]).toBe(2);
      } finally {
        off();
      }
    }
  });
});

describe('MINOR 1: a pause from a mod op is rebuilt', () => {
  const pauseWith = async (p: unknown) => {
    reg({}, { exec: async (_i, vm) => { vm.pause(p as never); } });
    const run = make();
    await run.step();
    disposers.pop()!();
    return run;
  };

  it('track, title and a function it holds are not kept; the snapshot still clones', async () => {
    const run = await pauseWith({ type: 'stop', text: 'x', track: 'other', title: 'Other', cond: { t: 'done' }, f: () => 1, nested: { a: 1 } });
    expect(run.pauseReason).toEqual({ type: 'stop', text: 'x' });
    expect(() => structuredClone(run.snapshot())).not.toThrow();
    expect(run.pauses()).toEqual([{ type: 'stop', text: 'x' }]);
  });

  it('a type the mod may not use is refused with words', async () => {
    for (const type of ['usd-budget-used', 'step-deleted', 'run-turn-budget-used', 'nope', 5, undefined]) {
      const run = await pauseWith({ type });
      expect(run.status, String(type)).toBe('paused');
      expect(run.pauseReason!.text, String(type)).toContain('paused the run with a reason it may not use');
      expect(run.pauseReason!.type).toBe('stop');
    }
  });

  it('a pause that is not an object is refused too', async () => {
    for (const p of [null, 'stop', 7]) expect((await pauseWith(p)).pauseReason!.text).toContain('may not use');
  });

  it('texts are tamed and capped', async () => {
    const run = await pauseWith({ type: 'stop', text: `a${BIDI}b${'x'.repeat(5000)}`, reason: 'r\nline' });
    expect(run.pauseReason!.text!.length).toBeLessThan(260);
    expect(run.pauseReason!.text).toContain('<U+202E>');
    expect(run.pauseReason!.text!.endsWith('...')).toBe(true);
    expect(run.pauseReason!.reason).not.toMatch(/[\r\n]/);   // one visible line
  });

  it('numbers must be finite; a text that is not a string is dropped', async () => {
    const run = await pauseWith({ type: 'budget-used', stepId: 'hostile-1', limit: NaN, spent: Infinity, to: 'x', text: 5, linkKey: {} });
    expect(run.pauseReason).toEqual({ type: 'budget-used', stepId: 'hostile-1' });
    const ok = await pauseWith({ type: 'budget-used', stepId: 'hostile-1', limit: 3, spent: 1.5 });
    expect(ok.pauseReason).toEqual({ type: 'budget-used', stepId: 'hostile-1', limit: 3, spent: 1.5 });
  });

  it('a link-budget pause keeps `to` only when it is a place in the program', async () => {
    const good = await pauseWith({ type: 'link-budget-used', linkKey: 'a->b', to: 1, limit: 1 });
    expect(good.pauseReason).toEqual({ type: 'link-budget-used', linkKey: 'a->b', to: 1, limit: 1 });
    for (const to of [NaN, 99, -1, 0.5]) {
      const run = await pauseWith({ type: 'link-budget-used', linkKey: 'a->b', to, limit: 1 });
      expect(run.pauseReason, String(to)).toEqual({ type: 'link-budget-used', linkKey: 'a->b', limit: 1 });
    }
  });

  it('a pause on a track does not answer another track and has no key of its own to set', async () => {
    const run = await pauseWith({ type: 'stop', text: 'x', track: undefined, title: 'T' });
    expect(Object.keys(run.pauseReason!).sort()).toEqual(['text', 'type']);
  });
});

describe('MINOR 1: takeLink from a mod op checks its target', () => {
  const link = async (to: unknown) => {
    reg({}, { exec: async (_i, vm) => { vm.takeLink('k', to as number, 1); vm.next(); } });
    const run = make();
    await run.step();
    disposers.pop()!();
    return run;
  };

  it('NaN, Infinity, a negative, a fraction, a string and a place past the end are refused with words', async () => {
    for (const to of [NaN, Infinity, -1, 0.5, '1', 99, undefined]) {
      const run = await link(to);
      expect(run.status, String(to)).toBe('paused');
      expect(run.pauseReason!.text, String(to)).toContain('which is not a place in the program');
    }
  });

  it('a place in the program passes', async () => {
    const run = await link(1);
    expect(run.status).toBe('running');
  });

  it('a link that used its budget pauses with a place that Allow can go to', async () => {
    reg({}, { exec: async (_i, vm) => { if (!vm.takeLink('k', 1, 0)) return; vm.next(); } });
    const run = make();
    await run.step();
    expect(run.pauseReason).toMatchObject({ type: 'link-budget-used', to: 1 });
  });
});

describe('MINOR 7: edit() checks the program it installs', () => {
  it('a block that now names a place that is no place: the old program stays and the run pauses', async () => {
    let bad = false;
    reg({}, { next: () => [bad ? 999 : undefined] });
    const run = make('## hostile\n\n## phase a\n> a\n');
    const before = (run as unknown as { program: Instr[] }).program;
    bad = true;
    run.edit(flow('## hostile\n\n## phase a\n> a changed\n'));
    expect(run.status).toBe('paused');
    expect(run.pauseReason).toEqual({ type: 'step-deleted' });
    expect((run as unknown as { program: Instr[] }).program).toBe(before);
    expect(run.snapshot().workflow.steps[1]!.prompt).toBe('a');
  });

  it('a good edit is installed as before', () => {
    reg();
    const run = make('## hostile\n\n## phase a\n> a\n');
    run.edit(flow('## hostile\n\n## phase a\n> a changed\n'));
    expect(run.status).toBe('running');
    expect(run.snapshot().workflow.steps[1]!.prompt).toBe('a changed');
  });
});

describe('MINOR 8: a mod compile hook reads earlier instructions as frozen copies', () => {
  it('it cannot rewrite what core compiled', () => {
    let seen: Instr | undefined;
    reg({
      compile(step, ctx) {
        seen = ctx.get(0);
        try { (seen as { policy: unknown }).policy = null; } catch { /* a frozen copy refuses */ }
        try { (ctx.get(0) as { step: string }).step = 'zzz'; } catch { /* the same */ }
        ctx.push({ op: 'HOSTILE', step: step.id });
      },
    });
    const body = '## phase a\n> a\n\n## hostile\n';
    const plain = compileProgram(flow('## phase a\n> a\n'));
    const p = compileProgram(flow(body));
    expect(p[0]).toEqual(plain[0]);
    expect(Object.isFrozen(seen)).toBe(true);
    expect((seen as { op: string }).op).toBe('TURN');
  });

  it('get of a place that is not there answers nothing', () => {
    let got: unknown = 'unset';
    reg({ compile(step, ctx) { got = ctx.get(50); ctx.push({ op: 'HOSTILE', step: step.id }); } });
    compileProgram(flow());
    expect(got).toBeUndefined();
  });
});
