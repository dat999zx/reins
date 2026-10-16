import { describe, it, expect, afterEach } from 'vitest';
import { register, opOf, NODES, phaseNode, parseWorkflow, validate, compileProgram, receipt, Run } from '../src/index.js';
import type { NodeType } from '../src/index.js';
import { harness } from './m1-harness.js';

// Declaration merging in the test file: the same pattern one-file-types.test.ts uses for NodeKinds.
declare module '../src/model.js' {
  interface NodeKinds { hop: true; peek: true }
}
declare module '../src/compile.js' {
  interface Instrs { HOP: { step: string }; PEEK: { step: string } }
}
declare module '../src/run.js' {
  interface RunEvents { hopped: Record<string, never> }
}

// hop: jumps over the next instruction. peek: waits on a held promise, then reads the vm.
const seen: { length?: number; at?: number; atAfterNext?: number; running?: boolean } = {};
let started!: () => void;
let held: Promise<void> = Promise.resolve();

const hop: NodeType = {
  kind: 'hop',
  attrs: [],
  compile(step, ctx) { ctx.push({ op: 'HOP', step: step.id }); },
  ops: {
    HOP: {
      async exec(_i, vm) { vm.log('hopped', {}); vm.goto(vm.at + 2); },
      next: (_i, at) => [at + 2],
      commands: () => ['echo hop'],
    },
  },
};
const peek: NodeType = {
  kind: 'peek',
  attrs: [],
  compile(step, ctx) { ctx.push({ op: 'PEEK', step: step.id }); },
  ops: {
    PEEK: {
      async exec(_i, vm) {
        started();
        await held;
        seen.length = vm.program.length;
        seen.at = vm.at;
        seen.running = vm.running();
        vm.next();
        seen.atAfterNext = vm.at;
      },
    },
  },
};

const disposers: Array<() => void> = [];
afterEach(() => { for (const d of disposers.splice(0).reverse()) d(); });

const text = (body: string) => `---\nreins: 1\nname: toy\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n${body}\n`;
const wf = (body: string) => {
  const p = parseWorkflow(text(body));
  expect(p.diagnostics).toEqual([]);
  return p.workflow!;
};
const drive = async (run: Run) => { for (let k = 0; k < 20 && run.status === 'running'; k++) await run.step(); };

describe('a kind brings its own op', () => {
  it('validate follows its next(), the run executes it, and a toy event is logged', async () => {
    disposers.push(register(hop));
    const w = wf('## hop\n\n## phase skipped\n> skip me\n\n## phase target\n> hit');
    const warned = validate(w).filter((d) => d.severity === 'warning').map((d) => d.message);
    expect(warned).toContain('step `skipped` is never reached');
    expect(warned).not.toContain('step `target` is never reached');
    expect(compileProgram(w).map((i) => i.op)).toEqual(['HOP', 'TURN', 'TURN', 'END']);

    const h = harness('hop', [{ text: 'ok\nREINS: done' }]);
    const run = new Run({ workflow: w, engine: h.engine, now: h.now });
    await drive(run);
    expect(run.status).toBe('done');
    expect(run.getEvents().filter((e) => e.type === 'hopped').length).toBe(1);
    expect(h.engine.receivedTexts).toHaveLength(1);
    expect(h.engine.receivedTexts[0]).toContain('hit');
    expect(h.engine.receivedTexts[0]).not.toContain('skip me');
  });

  it('vm members are live, except at: an edit during an await is seen, and next() moves the live counter', async () => {
    disposers.push(register(peek));
    const h = harness('peek', [{ text: 'ok\nREINS: done' }]);
    const run = new Run({ workflow: wf('## peek\n\n## phase a\n> go'), engine: h.engine, now: h.now });
    const running = new Promise<void>((r) => (started = r));
    let release!: () => void;
    held = new Promise<void>((r) => (release = r));

    const stepping = run.step();
    await running;
    run.edit(wf('## phase new\n> first\n\n## peek\n\n## phase a\n> go'));
    release();
    await stepping;

    // New program: TURN new, PEEK, TURN a, END. The counter moved to 1 with the edit; next() made it 2.
    expect(seen).toEqual({ length: 4, at: 0, atAfterNext: 0, running: true });
    expect(run.snapshot().programCounter).toBe(2);
  });
});

describe('a kind counts its events into the receipt', () => {
  const counting: NodeType = { ...hop, count: { hopped: () => 'hops' }, print: { hopped: () => '· hopped' } };

  it('receipt(events).counts has the kind\'s count, and no counts key at all without one', async () => {
    disposers.push(register(counting));
    const h = harness('hop-count', [{ text: 'ok\nREINS: done' }]);
    const run = new Run({ workflow: wf('## hop\n\n## phase skipped\n> skip me\n\n## phase target\n> hit'), engine: h.engine, now: h.now });
    await drive(run);
    expect(run.status).toBe('done');
    expect(receipt(run.getEvents()).counts).toEqual({ hops: 1 });

    const plain = harness('plain-count', [{ text: 'ok\nREINS: done' }]);
    const other = new Run({ workflow: wf('## phase one\n> go'), engine: plain.engine, now: plain.now });
    await drive(other);
    expect('counts' in receipt(other.getEvents())).toBe(false);
  });
});

describe('register', () => {
  const bare = (kind: string, ops?: NodeType['ops']): NodeType => ({ kind, attrs: [], compile() {}, ...(ops ? { ops } : {}) });
  const noop = { async exec() {} };

  it('throws on a kind that is already known, and leaves the first one in place', () => {
    expect(() => register({ ...phaseNode })).toThrow(/kind "phase"/);
    expect(NODES.get('phase')).toBe(phaseNode);
  });

  it.each(['TURN', 'JUMP', 'END', 'NODE'])('throws on a kind bringing the core op %s, and adds nothing', (op) => {
    expect(() => register(bare('core-op', { [op]: noop }))).toThrow(`op "${op}"`);
    expect(NODES.has('core-op')).toBe(false);
  });

  it('throws on an op name two kinds bring, and adds nothing', () => {
    disposers.push(register(hop));
    expect(() => register(bare('hop2', { HOP: noop }))).toThrow(/op "HOP"/);
    expect(NODES.has('hop2')).toBe(false);
  });

  it('the disposer removes the kind and its ops, and the names are free again', () => {
    const dispose = register(hop);
    disposers.push(dispose);
    expect(NODES.get('hop')).toBe(hop);
    expect(opOf('HOP')).toBe(hop.ops!.HOP);
    dispose();
    expect(NODES.has('hop')).toBe(false);
    expect(opOf('HOP')).toBeUndefined();
    disposers.push(register(hop));
    expect(opOf('HOP')).toBe(hop.ops!.HOP);
  });

  it('an old disposer cannot remove a later registration, even of the same node', () => {
    const d1 = register(hop);
    d1();
    disposers.push(register(hop));
    d1();
    expect(NODES.get('hop')).toBe(hop);
    expect(opOf('HOP')).toBe(hop.ops!.HOP);
  });

  it('opOf is undefined for a core op, an unknown op and an inherited object key', () => {
    disposers.push(register(hop));
    expect(opOf('TURN')).toBeUndefined();
    expect(opOf('NOPE')).toBeUndefined();
    expect(opOf('toString')).toBeUndefined();
    expect(() => disposers.push(register(bare('own-toString', { toString: noop })))).not.toThrow();
  });
});
