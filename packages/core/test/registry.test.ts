import { describe, it, expect, afterEach } from 'vitest';
import {
  Registry, NODES, CONDS, CARDS, register, registerCondition, registerCard, opOf, validate, parseCond,
  checkMode, turnInstr, policyOf,
} from '../src/index.js';
import type { NodeType, CondType, CardType, Step, Workflow } from '../src/index.js';

declare module '../src/model.js' {
  interface NodeKinds { zk1: true; zk2: true; zk3: true; zfail: true }
  interface CondAtoms { zboom: { t: 'zboom' }; zmid: { t: 'zmid' } }
  interface CardKinds { zc1: true; zc2: true }
}

const ids = (r: Registry, kind = 'k') => r.entries(kind).map(([id]) => id);
// `run` is the default pack's block (M3): core registers none, the test setup loads the pack.
const runNode = NODES.get('run')!;

describe('Registry: order, ties, shadow, dispose', () => {
  it('lists by order, then by insertion; no order goes after every number', () => {
    const r = new Registry();
    r.register('k', 'late', 1);
    r.register('k', 'b', 1, { order: 20 });
    r.register('k', 'a', 1, { order: 10 });
    r.register('k', 'tie1', 1, { order: 15 });
    r.register('k', 'tie2', 1, { order: 15 });
    expect(ids(r)).toEqual(['a', 'tie1', 'tie2', 'b', 'late']);
  });

  it('a negative order sorts first, a bad order is refused and adds nothing', () => {
    const r = new Registry();
    r.register('k', 'x', 1, { order: 5 });
    r.register('k', 'neg', 1, { order: -1 });
    expect(ids(r)).toEqual(['neg', 'x']);
    for (const bad of [NaN, Infinity, '3' as unknown as number]) expect(() => r.register('k', 'bad', 1, { order: bad })).toThrow(/order/);
    expect(r.has('k', 'bad')).toBe(false);
  });

  it('a taken id throws unless it shadows', () => {
    const r = new Registry();
    r.register('k', 'a', 1);
    expect(() => r.register('k', 'a', 2)).toThrow(/k "a" is already registered/);
    expect(r.get('k', 'a')).toBe(1);
  });

  it('a shadow takes the place of what it covers, and disposing it brings the first back', () => {
    const r = new Registry();
    r.register('k', 'a', 'first', { order: 10 });
    r.register('k', 'z', 'z', { order: 30 });
    const d = r.register('k', 'a', 'copy', { shadow: true });
    expect(r.get('k', 'a')).toBe('copy');
    expect(ids(r)).toEqual(['a', 'z']);
    d();
    expect(r.get('k', 'a')).toBe('first');
    expect(r.entries('k')).toEqual([['a', 'first'], ['z', 'z']]);
  });

  it('a shadow with an order of its own moves; disposing it moves the first back', () => {
    const r = new Registry();
    r.register('k', 'a', 'first', { order: 10 });
    r.register('k', 'z', 'z', { order: 30 });
    const d = r.register('k', 'a', 'copy', { shadow: true, order: 40 });
    expect(ids(r)).toEqual(['z', 'a']);
    d();
    expect(ids(r)).toEqual(['a', 'z']);
  });

  it('dispose twice is a no-op, even with another shadow on top and after the id was registered again', () => {
    const r = new Registry();
    r.register('k', 'a', 'first');
    const d1 = r.register('k', 'a', 'one', { shadow: true });
    const d2 = r.register('k', 'a', 'two', { shadow: true });
    d1(); d1();
    expect(r.get('k', 'a')).toBe('two');
    d2();
    expect(r.get('k', 'a')).toBe('first');
    d2();
    expect(r.get('k', 'a')).toBe('first');
    const d3 = r.register('k', 'b', 'x');
    d3();
    r.register('k', 'b', 'y');
    d3();
    expect(r.get('k', 'b')).toBe('y');
  });

  it('disposing the shadow under another shadow leaves the top one in view', () => {
    const r = new Registry();
    r.register('k', 'a', 'first');
    const d1 = r.register('k', 'a', 'one', { shadow: true });
    r.register('k', 'a', 'two', { shadow: true });
    d1();
    expect(r.get('k', 'a')).toBe('two');
  });

  it('ids stay alphabetical, whatever the order', () => {
    const r = new Registry();
    r.register('k', 'b', 1, { order: 1 });
    r.register('k', 'a', 1, { order: 2 });
    expect(r.ids('k')).toEqual(['a', 'b']);
  });
});

describe('NODES, CONDS and CARDS are ordered and shadowable', () => {
  const disposers: Array<() => void> = [];
  afterEach(() => { while (disposers.length) disposers.pop()!(); });

  const bare = (kind: string, extra: Partial<NodeType> = {}): NodeType => ({ kind, attrs: [], compile() {}, ...extra }) as NodeType;
  const noop = { async exec() {} };
  const keys = () => [...NODES.keys()];

  it('a kind registered with order 30 sits between say and gate (after run: the tie keeps insertion order)', () => {
    disposers.push(register(bare('zk1'), 30));
    expect(keys().slice(0, 5)).toEqual(['phase', 'say', 'run', 'zk1', 'gate']);
  });

  it('a kind with an order below run goes before it', () => {
    disposers.push(register(bare('zk1'), 25));
    expect(keys().slice(0, 5)).toEqual(['phase', 'say', 'zk1', 'run', 'gate']);
  });

  it('two kinds with the same order keep the order they came in', () => {
    disposers.push(register(bare('zk2'), 30), register(bare('zk1'), 30));
    expect(keys().slice(2, 6)).toEqual(['run', 'zk2', 'zk1', 'gate']);
  });

  it('a kind with no order goes after the last built-in, in the order it came', () => {
    disposers.push(register(bare('zk2')), register(bare('zk1')));
    expect(keys().slice(-3)).toEqual(['playbook', 'zk2', 'zk1']);
  });

  it('disposing puts the list back as it was', () => {
    const before = keys();
    const d = register(bare('zk1'), 30);
    d();
    expect(keys()).toEqual(before);
  });

  it('the validator names the kinds that can fail in registry order', () => {
    disposers.push(register(bare('zfail', { fails: true }), 30));
    const wf: Workflow = {
      version: 1, name: 'w', budget: { turns: 50, minutes: 50 }, always: [], autos: [], steps: [
        { id: 'a', kind: 'phase', title: 'a', attrs: {}, cards: [], links: [], prompt: 'a' },
        { id: 'b', kind: 'phase', title: 'b', attrs: {}, cards: [], links: [{ kind: 'on-fail', to: 'a', max: 1 }], prompt: 'b' },
      ],
    };
    const w = validate(wf).filter((d) => d.message.startsWith('on-fail only applies to'));
    expect(w.map((d) => d.message)).toEqual(['on-fail only applies to run, zfail, verify']);
  });

  it('a known kind throws unless it shadows; nothing is added', () => {
    expect(() => register(bare('say'))).toThrow(/kind "say" is already registered/);
    expect(NODES.get('say')).not.toBe(undefined);
  });

  it('a shadowing copy of an op-bearing kind registers, brings its op, and disposing brings the built-in back', () => {
    const before = keys();
    const original = opOf('RUN');
    expect(original).toBeDefined();
    const copy: NodeType = { ...runNode, ops: { RUN: { ...noop } } };
    const d = register(copy, undefined, { shadow: true });
    expect(NODES.get('run')).toBe(copy);
    expect(opOf('RUN')).toBe(copy.ops!.RUN);
    expect(keys()).toEqual(before);
    d();
    expect(NODES.get('run')).toBe(runNode);
    expect(opOf('RUN')).toBe(original);
    d();
    expect(NODES.get('run')).toBe(runNode);
    expect(keys()).toEqual(before);
  });

  it('the exemption is only for the ops of the kind it shadows', () => {
    disposers.push(register(bare('zk1', { ops: { ZHOP: noop } }), 30));
    expect(() => register({ ...runNode, ops: { RUN: noop, ZHOP: noop } }, undefined, { shadow: true })).toThrow(/op "ZHOP" is already brought by kind "zk1"/);
    expect(() => register({ ...runNode, ops: { RUN: noop, TURN: noop } }, undefined, { shadow: true })).toThrow(/op "TURN" is a core op/);
    expect(NODES.get('run')).toBe(runNode);
  });

  it('a copy of one kind cannot take the op of another kind', () => {
    expect(() => register({ ...runNode, ops: { ...runNode.ops, ...NODES.get('verify')!.ops } }, undefined, { shadow: true })).toThrow(/already brought by kind "verify"/);
  });

  it('without shadow, a copy of an op-bearing kind is refused', () => {
    expect(() => register({ ...runNode })).toThrow(/kind "run" is already registered/);
  });

  it('shadow for a kind nobody has registers it like any other', () => {
    disposers.push(register(bare('zk3'), 30, { shadow: true }));
    expect(NODES.has('zk3')).toBe(true);
  });

  it('a condition registered with an order sits where the number puts it; disposing removes it from the parser', () => {
    const mid: CondType<{ t: 'zmid' }> = {
      t: 'zmid', judge: 'deterministic', print: () => 'zmid ok',
      parse(s) { if (!s.src.startsWith('zmid ok', s.idx)) return null; s.idx += 'zmid ok'.length; return { t: 'zmid' }; },
    };
    const d = registerCondition(mid, 15);
    expect([...CONDS.keys()].slice(0, 3)).toEqual(['approve', 'zmid', 'tests']);
    expect(parseCond('zmid ok').cond).toEqual({ t: 'zmid' });
    d(); d();
    expect(CONDS.has('zmid')).toBe(false);
    expect(parseCond('zmid ok').diag).toBeDefined();
  });

  it('shadowing a condition and disposing it brings the built-in back', () => {
    const builtin = CONDS.get('tests')!;
    const copy: CondType = { ...builtin };
    const d = registerCondition(copy, undefined, { shadow: true });
    expect(CONDS.get('tests')).toBe(copy);
    expect([...CONDS.keys()].slice(0, 3)).toEqual(['approve', 'tests', 'cmd']);
    d();
    expect(CONDS.get('tests')).toBe(builtin);
    expect(() => registerCondition({ ...builtin })).toThrow(/condition "tests" is already registered/);
  });

  it('a card registers with an order, shadows, and disposes', () => {
    const c1: CardType = { kind: 'zc1' };
    const c2: CardType = { kind: 'zc2' };
    disposers.push(registerCard(c1, 15), registerCard(c2));
    expect([...CARDS.keys()]).toEqual(['guard', 'zc1', 'now', 'stop', 'zc2']);
    const builtin = CARDS.get('guard')!;
    const copy: CardType = { ...builtin };
    const d = registerCard(copy, undefined, { shadow: true });
    expect(CARDS.get('guard')).toBe(copy);
    d();
    expect(CARDS.get('guard')).toBe(builtin);
    expect(() => registerCard({ ...builtin })).toThrow(/card "guard" is already registered/);
  });

  it('checkMode, turnInstr and policyOf are exported for api.core', () => {
    for (const f of [checkMode, turnInstr, policyOf]) expect(typeof f).toBe('function');
    const step = { id: 's', kind: 'phase', attrs: {}, cards: [], links: [] } as unknown as Step;
    expect(turnInstr(step).op).toBe('TURN');
  });
});

describe('a mod atom\'s diagnostic counts only when no other atom matches', () => {
  const disposers: Array<() => void> = [];
  afterEach(() => { while (disposers.length) disposers.pop()!(); });
  const boom: CondType<{ t: 'zboom' }> = {
    t: 'zboom', judge: 'deterministic', print: () => 'zboom',
    parse(s) { return s.error('boom says no', s.idx); },
  };

  it('an atom that diagnoses everything, even one tried first, does not break `tests pass`', () => {
    disposers.push(registerCondition(boom, 5));
    expect([...CONDS.keys()][0]).toBe('zboom');
    const r = parseCond('tests pass');
    expect(r.diag).toBeUndefined();
    expect(r.cond).toMatchObject({ t: 'tests' });
  });

  it('it also holds for a `cmd` and for `and`', () => {
    disposers.push(registerCondition(boom, 5));
    expect(parseCond('`npm test` passes and tests pass').diag).toBeUndefined();
  });

  it('when no atom matches, its diagnostic is the one reported', () => {
    disposers.push(registerCondition(boom, 5));
    expect(parseCond('nonsense').diag?.message).toBe('boom says no');
  });

  it('a built-in atom\'s diagnostic still stops parsing at once', () => {
    disposers.push(registerCondition(boom, 500));
    expect(parseCond('`npm test').diag?.message).toBe('Unterminated command');
  });

  it('with no mod atom, nothing changes: the usual words', () => {
    expect(parseCond('nonsense').diag?.message).toMatch(/^Unexpected condition token/);
  });

  it('a built-in atom\'s diagnostic wins over a later mod atom that would take the same text', () => {
    const greedy: CondType<{ t: 'zmid' }> = {
      t: 'zmid', judge: 'deterministic', print: () => 'zmid',
      parse(s) { if (s.src[s.idx] !== '`') return null; s.idx = s.len; return { t: 'zmid' }; },
    };
    disposers.push(registerCondition(greedy, 500));
    const r = parseCond('`npm test');
    expect(r.diag?.message).toBe('Unterminated command');
    expect(r.cond).toBeUndefined();
  });

  it('a mod atom that moves the cursor and then diagnoses leaves the text whole for the next atom', () => {
    const mover: CondType<{ t: 'zboom' }> = {
      t: 'zboom', judge: 'deterministic', print: () => 'zboom',
      parse(s) { s.idx += 3; return s.error('moved and failed', s.idx); },
    };
    // Right before `tests`: a null from any atom in between would put the cursor back by itself.
    disposers.push(registerCondition(mover, 15));
    expect([...CONDS.keys()].slice(0, 3)).toEqual(['approve', 'zboom', 'tests']);
    const r = parseCond('tests pass');
    expect(r.diag).toBeUndefined();
    expect(r.cond).toMatchObject({ t: 'tests' });
  });
});

describe('a key put in a registry by hand', () => {
  const disposers: Array<() => void> = [];
  afterEach(() => { while (disposers.length) disposers.pop()!(); NODES.delete('zstray'); CONDS.delete('zstray'); CARDS.delete('zstray'); });
  const node = { kind: 'zstray', attrs: [], compile() {} } as NodeType;
  const cond = { t: 'zstray', judge: 'deterministic', print: () => 'zstray', parse: () => null } as unknown as CondType;
  const card: CardType = { kind: 'zstray' };
  const early = { kind: 'zk1', attrs: [], compile() {} } as NodeType;

  it('sits after the registered ones, stays through other registrations, and goes only with delete', () => {
    NODES.set('zstray', node);
    expect([...NODES.keys()].at(-1)).toBe('zstray');
    const d = register(early, 5);
    expect([...NODES.keys()][0]).toBe('zk1');
    expect([...NODES.keys()].at(-1)).toBe('zstray');
    d();
    expect([...NODES.keys()].at(-1)).toBe('zstray');
    expect(NODES.get('zstray')).toBe(node);
    register(early, 5)();
    NODES.delete('zstray');
    disposers.push(register(early, 5));
    expect(NODES.has('zstray')).toBe(false);
  });

  it('holds for conditions and cards too', () => {
    CONDS.set('zstray', cond);
    CARDS.set('zstray', card);
    disposers.push(registerCondition({ ...CONDS.get('tests')!, t: 'zmid' } as CondType, 5), registerCard({ kind: 'zc1' }, 5));
    expect([...CONDS.keys()][0]).toBe('zmid');
    expect([...CONDS.keys()].at(-1)).toBe('zstray');
    expect([...CARDS.keys()][0]).toBe('zc1');
    expect([...CARDS.keys()].at(-1)).toBe('zstray');
  });
});
