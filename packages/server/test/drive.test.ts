// drive.ts: the answer parser, the pause loop, the two ask helpers, and runOptions (plan 15d 3b.2).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { FakeEngine, Run, parseWorkflow, register, validate, type Cond, type ScriptedTurn, type Step, type Workflow } from '@reins/core';
import { askJudge, askTool, driveRun, parseAnswer, runOptions, type DriveIo, type Question } from '../src/drive.js';
import { m2harness } from '../../core/test/m2-harness.js';
import { split } from '../../core/test/fixtures/split.js';
import { usePack } from './pack-helper.js';

// runCommand still runs for real; the spy only records the options drive.ts passes it.
const runCommandSpy = vi.hoisted(() => vi.fn());
vi.mock('../src/commands.js', async (orig) => {
  const actual = await orig<typeof import('../src/commands.js')>();
  runCommandSpy.mockImplementation(actual.runCommand);
  return { ...actual, runCommand: runCommandSpy };
});

usePack(); // M3 Task 3: the built-in kinds are the default pack's mods; this file loads the pack once

const step = (id: string, kind: Step['kind'], over: Partial<Step> = {}): Step => ({ id, kind, attrs: {}, cards: [], links: [], ...over });
const phase = (id: string) => step(id, 'phase', { title: id, prompt: 'do it' });
const wf = (steps: Step[]): Workflow => ({ version: 1, name: 't', budget: { turns: 20, minutes: 20 }, always: [], steps, autos: [] });

function testIo(answer: (q: Question) => Promise<string | null> | string | null = () => null) {
  const lines: string[] = [];
  const chunks: string[] = [];
  const questions: Question[] = [];
  const io: DriveIo = {
    ask: async (q) => { questions.push(q); return answer(q); },
    say: (l) => lines.push(l),
    write: (c) => chunks.push(c),
  };
  return { io, lines, chunks, questions };
}

const gateRun = () => new Run({ workflow: wf([step('g', 'gate', { cond: { t: 'approve' } }), phase('a')]), engine: new FakeEngine() });

describe('parseAnswer (one grammar, the terminal words)', () => {
  it('gate: approve words, changes with a note, stop, else a hint', () => {
    for (const a of ['approve', 'a', 'y', 'yes', 'YES']) expect(parseAnswer('gate', a)).toEqual({ t: 'approve' });
    expect(parseAnswer('gate', 'changes fix the tests')).toEqual({ t: 'changes', note: 'fix the tests' });
    expect(parseAnswer('gate', 'changes')).toEqual({ t: 'invalid', hint: 'Type approve, changes <note>, or stop.' });
    expect(parseAnswer('gate', 'stop')).toEqual({ t: 'stop' });
    expect(parseAnswer('gate', 'blah')).toEqual({ t: 'invalid', hint: 'Type approve, changes <note>, or stop.' });
  });
  it('budget: allow <n>, stop; resume: resume [note], stop', () => {
    expect(parseAnswer('budget', 'allow 3 more')).toEqual({ t: 'allow', n: 3 });
    expect(parseAnswer('budget', 'stop')).toEqual({ t: 'stop' });
    expect(parseAnswer('budget', 'x')).toEqual({ t: 'invalid', hint: 'Type allow <n> more, or stop.' });
    expect(parseAnswer('resume', 'resume')).toEqual({ t: 'resume', note: '' });
    expect(parseAnswer('resume', 'resume carry on')).toEqual({ t: 'resume', note: 'carry on' });
    expect(parseAnswer('resume', 'stop')).toEqual({ t: 'stop' });
    expect(parseAnswer('resume', 'x')).toEqual({ t: 'invalid', hint: 'Type resume [note], or stop.' });
  });
});

describe('parseAnswer usd (Task 2, milestone C)', () => {
  const hint = { t: 'invalid', hint: 'Type allow $<amount> more, like allow $0.50, or stop.' };
  it('allow $<amount> [more], stop; anything else is the hint', () => {
    expect(parseAnswer('usd', 'allow $0.50')).toEqual({ t: 'allowUsd', usd: 0.5 });
    expect(parseAnswer('usd', 'allow 0.5 more')).toEqual({ t: 'allowUsd', usd: 0.5 });
    expect(parseAnswer('usd', 'ALLOW $2')).toEqual({ t: 'allowUsd', usd: 2 });
    for (const a of ['allow $0', 'allow $1.234', 'allow', 'x']) expect(parseAnswer('usd', a), a).toEqual(hint);
    expect(parseAnswer('usd', 'stop')).toEqual({ t: 'stop' });
  });
});

describe('driveRun on a USD pause (Task 2, milestone C)', () => {
  const blockRun = (usd: number | undefined = 1.3) => new Run({
    workflow: { ...wf([step('model-1', 'model', { attrs: { model: 'm', usd: '0.10' } }), phase('a'), phase('b'), phase('c')]), budget: { turns: 20, minutes: 20, ...(usd === undefined ? {} : { usd }) } },
    engine: new FakeEngine([{ text: 'REINS: done', cost: 0.06 }, { text: 'REINS: done', cost: 0.06 }, { text: 'REINS: done', cost: 0.06 }]),
    switchModel: async (m) => ({ to: 'switched', label: m }),
  });

  it('asks the usd question with its prompt and detail; allow resumes and the run finishes', async () => {
    const run = blockRun();
    const t = testIo(() => 'allow $0.05');
    const r = await driveRun(run, t.io, () => {});
    expect(r).toEqual({ result: 'finished' });
    expect(run.status).toBe('done');
    expect(t.lines).toContain('⏸ block model-1 used its $0.10 budget ($0.12 spent)');
    expect(t.questions).toEqual([{
      id: expect.stringMatching(/^[0-9a-f]+$/), kind: 'usd', prompt: 'allow $<amount> more / stop',
      detail: 'Block `model-1` has used $0.12 of its $0.10. The playbook\'s USD budget has $1.18 left.',
    }]);
    // 0.12 spent + 0.05 allowed = 0.17; c costs 0.06 more and is the last step
    expect(run.snapshot().runCost).toBeCloseTo(0.18, 9);
  });

  it('the card and the say line print measured dollars cleanly: float sums and long tails are rounded to 4 decimals', async () => {
    // 0.1 + 0.2 is 0.30000000000000004 in floating point; the card must say $0.30, not that
    const run = new Run({
      workflow: { ...wf([step('model-1', 'model', { attrs: { model: 'm', usd: '0.30' } }), phase('a'), phase('b'), phase('c')]), budget: { turns: 20, minutes: 20, usd: 1.3 } },
      engine: new FakeEngine([{ text: 'REINS: done', cost: 0.1 }, { text: 'REINS: done', cost: 0.2 }, { text: 'REINS: done', cost: 0.05 }]),
      switchModel: async (m) => ({ to: 'switched', label: m }),
    });
    const t = testIo(() => 'stop');
    await driveRun(run, t.io, () => {});
    expect(t.lines).toContain('⏸ block model-1 used its $0.30 budget ($0.30 spent)');
    expect(t.questions[0]).toMatchObject({ detail: "Block `model-1` has used $0.30 of its $0.30. The playbook's USD budget has $1.00 left." });
  });

  it('a long measured tail keeps 4 decimals (0.06409 reads $0.0641), so a small overage is not hidden', async () => {
    const run = new Run({
      workflow: { ...wf([step('model-1', 'model', { attrs: { model: 'm', usd: '0.01' } }), phase('a'), phase('b')]), budget: { turns: 20, minutes: 20, usd: 4 } },
      engine: new FakeEngine([{ text: 'REINS: done', cost: 0.06409 }, { text: 'REINS: done', cost: 0.01 }]),
      switchModel: async (m) => ({ to: 'switched', label: m }),
    });
    const t = testIo(() => 'stop');
    await driveRun(run, t.io, () => {});
    expect(t.questions[0]).toMatchObject({ detail: "Block `model-1` has used $0.0641 of its $0.01. The playbook's USD budget has $3.9359 left." });
  });

  it('an allow past the workflow says the refusal and asks again', async () => {
    const run = blockRun(0.2);
    const answers = ['allow $5', 'stop'];
    const t = testIo(() => answers.shift() ?? null);
    await driveRun(run, t.io, () => {});
    expect(t.lines).toContain("Allow at most $0.08: the playbook's USD budget has that much left.");
    expect(t.questions.map((q) => q.kind)).toEqual(['usd', 'usd']);
    expect(run.status).toBe('stopped');
  });

  it('a null answer to the usd question detaches; the run stays paused on it', async () => {
    const run = blockRun();
    const t = testIo(() => null);
    const r = await driveRun(run, t.io, () => {});
    expect(r).toEqual({ result: 'detached' });
    expect(run.status).toBe('paused');
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', stepId: 'model-1' });
    expect(t.questions).toHaveLength(1);
  });

  it("the workflow's own budget says its own words", async () => {
    const run = new Run({ workflow: { ...wf([phase('a'), phase('b'), phase('c')]), budget: { turns: 20, minutes: 20, usd: 0.1 } }, engine: new FakeEngine([{ text: 'REINS: done', cost: 0.06 }, { text: 'REINS: done', cost: 0.06 }]) });
    const t = testIo(() => 'stop');
    await driveRun(run, t.io, () => {});
    expect(t.lines).toContain('⏸ the run used its $0.10 USD budget ($0.12 spent)');
    expect(t.questions[0]).toMatchObject({ kind: 'usd', detail: 'The run has used $0.12 of its $0.10 USD budget.' });
  });

  it('a stop pause with a step id says the step; without one says a card did', async () => {
    const closed = new Run({ workflow: wf([step('model-1', 'model', { attrs: { model: 'm' } }), phase('a')]), engine: new FakeEngine(), switchModel: async () => ({ to: 'closed' }) });
    const t = testIo(() => null);
    await driveRun(closed, t.io, () => {});
    expect(t.lines[0]).toBe('⏸ model-1: the switch question was closed before it was answered; Resume asks it again');

    const card = new Run({ workflow: wf([phase('a')]), engine: new FakeEngine() });
    card.queueCard('wait', 'stop');
    const u = testIo(() => null);
    await driveRun(card, u.io, () => {});
    expect(u.lines[0]).toBe('⏹ stopped by a card: wait');
  });

  it('runOptions passes switchModel through', () => {
    const switchModel = async () => ({ to: 'same' as const, label: 'x' });
    const o = runOptions(testIo().io, { workflow: wf([]), engine: new FakeEngine(), cwd: process.cwd(), resolveBlock: () => undefined, onEvent: () => {}, switchModel });
    expect(o.switchModel).toBe(switchModel);
  });

  it('runOptions passes openSubagent through, and has no such key without it', () => {
    const openSubagent = async () => { throw new Error('unused'); };
    const base = { workflow: wf([]), engine: new FakeEngine(), cwd: process.cwd(), resolveBlock: () => undefined, onEvent: () => {} };
    expect(runOptions(testIo().io, { ...base, openSubagent }).openSubagent).toBe(openSubagent);
    expect('openSubagent' in runOptions(testIo().io, base)).toBe(false);
  });
});

describe('driveRun', () => {
  it('a gate question with the terminal prompt, approve goes on and finishes', async () => {
    const t = testIo(() => 'approve');
    const run = gateRun();
    const r = await driveRun(run, t.io, () => {});
    expect(r).toEqual({ result: 'finished' });
    expect(run.status).toBe('done');
    expect(t.questions).toEqual([expect.objectContaining({ kind: 'gate', prompt: 'approve / changes <note> / stop' })]);
    expect(t.questions[0]!.id).toMatch(/^[0-9a-f]+$/);
    expect(t.lines[0]).toMatch(/^⏸ gate g: until /);
  });

  it('a null answer detaches; the run stays paused', async () => {
    const run = gateRun();
    const r = await driveRun(run, testIo(() => null).io, () => {});
    expect(r).toEqual({ result: 'detached' });
    expect(run.status).toBe('paused');
  });

  it('stop finishes as stopped', async () => {
    const run = gateRun();
    expect(await driveRun(run, testIo(() => 'stop').io, () => {})).toEqual({ result: 'finished' });
    expect(run.status).toBe('stopped');
  });

  it('closing a gate question after run.stop() (null answer) ends driveRun as finished (3b.8)', async () => {
    const run = gateRun();
    const t = testIo(async () => { await run.stop(); return null; });
    expect(await driveRun(run, t.io, () => {})).toEqual({ result: 'finished' });
    expect(run.status).toBe('stopped');
  });

  it('an invalid answer prints the hint and asks again', async () => {
    const answers = ['blah', 'approve'];
    const t = testIo(() => answers.shift() ?? null);
    await driveRun(gateRun(), t.io, () => {});
    expect(t.lines).toContain('Type approve, changes <note>, or stop.');
    expect(t.questions).toHaveLength(2);
  });

  it('a blocked agent asks resume [note] / stop', async () => {
    const engine = new FakeEngine([{ text: 'REINS: blocked: need input' }]);
    const run = new Run({ workflow: wf([phase('a')]), engine });
    const t = testIo(() => 'resume go on');
    const r = await driveRun(run, t.io, () => {});
    expect(t.questions[0]).toEqual(expect.objectContaining({ kind: 'resume', prompt: 'resume [note] / stop' }));
    expect(t.lines).toContain('⏸ the agent is blocked: need input');
    expect(r.result).toBe('finished');
  });

  it('a thrown error is printed, returned, and detaches', async () => {
    const engine = new FakeEngine();
    engine.open = async () => { throw new Error('boom'); };
    const run = new Run({ workflow: wf([phase('a')]), engine });
    const t = testIo();
    let saves = 0;
    const r = await driveRun(run, t.io, () => { saves++; });
    expect(r).toEqual({ result: 'detached', error: 'boom' });
    expect(t.lines).toContain('✗ boom');
    expect(saves).toBe(1); // the failed step saved nothing; the save after close still ran
  });

  it('save() runs after every step and once more after close', async () => {
    const run = new Run({ workflow: wf([phase('a'), phase('b')]), engine: new FakeEngine() });
    let saves = 0;
    await driveRun(run, testIo().io, () => { saves++; });
    expect(saves).toBe(3 + 1); // three steps (turn a, turn b, END), then the save after close
  });
});

describe('askTool and askJudge', () => {
  it('askTool: the terminal prompt, JSON in detail, y allows, n <reason> denies with the reason', async () => {
    const t = testIo(() => 'y');
    expect(await askTool(t.io, { tool: 'Edit', input: { file_path: 'a.ts' } })).toEqual({ behavior: 'allow' });
    expect(t.questions[0]).toEqual(expect.objectContaining({ kind: 'tool', prompt: '? Allow Edit: a.ts  [y / n <reason>]', detail: '{"file_path":"a.ts"}' }));
    const no = testIo(() => 'n not now');
    expect(await askTool(no.io, { tool: 'Edit', input: { file_path: 'a.ts' } })).toEqual({ behavior: 'deny', message: 'The user said no: not now' });
    expect(await askTool(testIo(() => 'n').io, { tool: 'Edit', input: {} })).toEqual({ behavior: 'deny', message: 'The user said no.' });
    expect(await askTool(testIo(() => null).io, { tool: 'Edit', input: {} })).toEqual({ behavior: 'deny', message: 'The user said no.' });
  });

  it('askTool with a reason names it in the prompt; without one the words are today\'s', async () => {
    const t = testIo(() => 'y');
    await askTool(t.io, { tool: 'Read', input: { file_path: '/x' }, reason: 'outside the project' });
    expect(t.questions[0]!.prompt).toBe('? Allow Read (outside the project): /x  [y / n <reason>]');
    const plain = testIo(() => 'y');
    await askTool(plain.io, { tool: 'Read', input: { file_path: '/x' } });
    expect(plain.questions[0]!.prompt).toBe('? Allow Read: /x  [y / n <reason>]');
  });

  it('askTool with a title puts it on the question; without one there is no title key (not even undefined)', async () => {
    const t = testIo(() => 'y');
    await askTool(t.io, { tool: 'Bash', input: { command: 'ls' } }, 'Subagent research (`subagent-1`)');
    expect(t.questions[0]!.title).toBe('Subagent research (`subagent-1`)');
    expect(t.questions[0]).toMatchObject({ kind: 'tool', prompt: '? Allow Bash: ls  [y / n <reason>]' });
    await askTool(t.io, { tool: 'Bash', input: { command: 'ls' } });
    expect('title' in t.questions[1]!).toBe(false);
    await askTool(t.io, { tool: 'Bash', input: { command: 'ls' } }, '');
    expect('title' in t.questions[2]!).toBe(false);
  });

  it('askJudge: prints the question and the last 15 lines, y is yes, anything else is no', async () => {
    const cond: Cond = { t: 'llm', q: 'ok' };
    const t = testIo(() => 'y');
    expect(await askJudge(t.io, cond, { lastText: 'one\ntwo' })).toBe(true);
    expect(t.lines).toEqual(['? You judge: llm says "ok"', '    one\n    two']);
    expect(t.questions[0]).toEqual(expect.objectContaining({ kind: 'judge', prompt: 'y / n' }));
    expect(await askJudge(testIo(() => 'n').io, cond, { lastText: '' })).toBe(false);
    expect(await askJudge(testIo(() => null).io, cond, { lastText: '' })).toBe(false);
  });
});

describe('runOptions', () => {
  it('#repeat tests pass with a failing test command loops, through the io (3b.8)', async () => {
    const t = testIo(() => 'stop');
    const workflow = { ...wf([step('r', 'repeat', { attrs: { max: '2' }, cond: { t: 'tests' }, kids: [phase('a')] })]), test: 'exit 1' };
    const engine = new FakeEngine();
    const run = new Run(runOptions(t.io, { workflow, engine, cwd: process.cwd(), resolveBlock: () => undefined, onEvent: () => {} }));
    await driveRun(run, t.io, () => {});
    expect(t.lines.filter((l) => l === '$ exit 1').length).toBeGreaterThanOrEqual(2);
    expect(t.lines).toContain('✗ failed (exit 1)');
    expect(t.questions[0]!.kind).toBe('budget');
    expect(engine.receivedTexts.length).toBeGreaterThanOrEqual(2);
  });

  it('command output goes through io.write raw, and passing commands print ✓', async () => {
    const t = testIo();
    const workflow = wf([step('c', 'run', { attrs: { cmd: 'echo hello' } })]);
    const run = new Run(runOptions(t.io, { workflow, engine: new FakeEngine(), cwd: process.cwd(), resolveBlock: () => undefined, onEvent: () => {} }));
    await driveRun(run, t.io, () => {});
    expect(t.lines).toEqual(expect.arrayContaining(['$ echo hello', '✓ passed']));
    expect(t.chunks.join('')).toContain('hello');
  });

  describe('REINS_COMMAND_TIMEOUT_MIN', () => {
    const timeoutFor = async (env?: Record<string, string>) => {
      runCommandSpy.mockClear();
      const base = { workflow: wf([]), engine: new FakeEngine(), cwd: process.cwd(), resolveBlock: () => undefined, onEvent: () => {} };
      const o = runOptions(testIo().io, { ...base, ...(env ? { env: () => ({ PATH: process.env.PATH, ...env }) } : {}) });
      await o.commandRunner!('echo hi');
      return runCommandSpy.mock.calls[0]![1].timeoutMs;
    };
    it('passes the minutes from the command environment as timeoutMs', async () => {
      expect(await timeoutFor({ REINS_COMMAND_TIMEOUT_MIN: '25' })).toBe(25 * 60_000);
      expect(await timeoutFor({ REINS_COMMAND_TIMEOUT_MIN: '0.5' })).toBe(30_000);
    });
    it('reads o.env, not process.env, when o.env is given', async () => {
      process.env.REINS_COMMAND_TIMEOUT_MIN = '99';
      try {
        expect(await timeoutFor({})).toBeUndefined();
        expect(await timeoutFor()).toBe(99 * 60_000);
      } finally { delete process.env.REINS_COMMAND_TIMEOUT_MIN; }
    });
    it('ignores a missing, zero, negative or non-numeric value', async () => {
      expect(await timeoutFor()).toBeUndefined();
      for (const v of ['', '0', '-5', 'abc', 'Infinity', 'NaN']) expect(await timeoutFor({ REINS_COMMAND_TIMEOUT_MIN: v }), v).toBeUndefined();
    });
  });
});

// ---- M2 task 13: the driver asks every track's pause at once, answers it by its key, and settles what is open when the run ends --------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => 'timeout' as const)]);
const until = async (f: () => boolean) => { for (let k = 0; k < 600 && !f(); k++) await sleep(5); expect(f(), 'the condition was not met in time').toBe(true); };

/** Questions that stay open until a test answers them, in the order they were asked; `cancel` settles every open one with null, as the server's does. */
function heldIo() {
  const lines: string[] = [];
  const asked: Question[] = [];
  const settlers: Array<(a: string | null) => void> = [];
  const open = new Set<number>();
  const cancels: string[] = [];
  const io: DriveIo = {
    ask: (q) => new Promise((resolve) => {
      const i = asked.push(q) - 1;
      open.add(i);
      settlers[i] = (a) => { open.delete(i); resolve(a); };
    }),
    say: (l) => lines.push(l),
    write: () => {},
    cancel: (why) => { cancels.push(why); for (const i of [...open]) settlers[i]!(null); },
  };
  return { io, lines, asked, cancels, answer: (i: number, a: string | null) => settlers[i]!(a), isOpen: (i: number) => open.has(i), get openCount() { return open.size; } };
}

const tracksWf = (body: string, budget = 'turns: 40, minutes: 60'): Workflow => {
  const r = parseWorkflow(`---\nreins: 1\nname: t\nbudget: { ${budget} }\nalways: []\n---\n\n${body}\n`);
  expect(r.diagnostics).toEqual([]);
  expect(validate(r.workflow!).filter((d) => d.severity === 'error')).toEqual([]);
  return r.workflow!;
};
const MAIN = '## phase main\n> m\n\n## end\n\n';
const done = (text: string, cost?: number): ScriptedTurn => ({ text: `${text}\nREINS: done`, ...(cost !== undefined ? { cost } : {}) });
const subOf = (s: string, key: string) => `${s}-sub-${key}`;

describe('driveRun with tracks (M2 task 13)', () => {
  const disposers: Array<() => void> = [];
  beforeAll(() => { disposers.push(register(split)); });
  afterAll(() => { for (const d of disposers.splice(0).reverse()) d(); });
  const mk = (h: ReturnType<typeof m2harness>, body: string, budget?: string, o: Partial<ConstructorParameters<typeof Run>[0]> = {}) =>
    new Run({ workflow: tracksWf(body, budget), engine: h.engine, openSubagent: h.openSubagent, now: h.now, ...o });
  const TWO_GATES = `## split\nnext: a\nnext: b\n\n${MAIN}## phase a\n> a\n\n## gate\nid: ga\nuntil: you approve\n\n## end\n\n## phase b\n> b\n\n## gate\nid: gb\nuntil: you approve\n\n## end`;

  it('two gates at once: each question is titled, each shows its own branch\'s last reply, and answering one resumes only that track; no gate is asked twice', async () => {
    const h = m2harness('D1');
    h.script(subOf('D1', 'a'), done('ALPHA-REPLY'));
    h.script(subOf('D1', 'b'), done('BETA-REPLY'));
    const t = heldIo();
    const run = mk(h, TWO_GATES);
    const driven = driveRun(run, t.io, () => {});
    await until(() => t.asked.length === 2);
    expect(t.asked.map((q) => [q.kind, q.title])).toEqual([['gate', 'Split split-1'], ['gate', 'Split split-1']]);
    const textAfter = (gate: string) => t.lines[t.lines.findIndex((l) => l.startsWith(`⏸ gate ${gate}:`)) + 1]!;
    expect(textAfter('ga')).toContain('ALPHA-REPLY');
    expect(textAfter('ga')).not.toContain('BETA-REPLY');
    expect(textAfter('gb')).toContain('BETA-REPLY');
    expect(textAfter('gb')).not.toContain('ALPHA-REPLY');
    await sleep(80);
    expect(t.asked).toHaveLength(2);   // the loop went round again: the same gate is not asked a second time
    t.answer(1, 'approve');   // the second question is b's
    await until(() => run.ended.some((e) => e.key === 'b'));
    expect(run.pauses().map((p) => p.track)).toEqual(['a']);
    expect(run.getEvents().filter((e) => e.type === 'gate_approved').map((e) => e.data)).toEqual([{ track: 'b' }]);
    expect(t.isOpen(0)).toBe(true);
    await sleep(40);
    expect(t.asked).toHaveLength(2);
    t.answer(0, 'approve');
    expect(await within(driven, 3000)).toEqual({ result: 'finished' });
    expect(run.status).toBe('done');
  }, 15_000);

  it('a track pause that arises while the run\'s own question is open is asked at once; after the Allow the run goes on to its end', async () => {
    const h = m2harness('D3');
    // a's reply costs more than the workflow has: the run-wide USD card. b's turn is still held, so a step() is asleep when the card is written.
    h.script(subOf('D3', 'a'), done('a', 0.6));
    h.script(subOf('D3', 'b'), { text: 'stuck\nREINS: blocked: nope' }, done('b'));
    const hb = h.hold(subOf('D3', 'b'));
    const t = heldIo();
    const run = mk(h, `## split\nnext: a\nnext: b\n\n${MAIN}## phase a\n> a\n\n## verify\nagainst: a\n\n## end\n\n## phase b\n> b\n\n## end`, 'turns: 40, minutes: 60, usd: 0.5');
    const driven = driveRun(run, t.io, () => {});
    await hb.started;
    await until(() => t.asked.some((q) => q.kind === 'usd'));
    expect(run.status).toBe('paused');
    expect(t.asked.map((q) => q.kind)).toEqual(['usd']);
    hb.release();   // b's reply says it is blocked while the USD question is still open
    await until(() => t.asked.some((q) => q.kind === 'resume'));
    expect(t.asked.map((q) => q.kind)).toEqual(['usd', 'resume']);
    expect(t.asked[1]!.title).toBe('Split split-1');
    expect(t.isOpen(0)).toBe(true);
    t.answer(1, 'resume');
    await until(() => run.pauses().length === 1);
    expect(run.pauses()[0]).toMatchObject({ type: 'usd-budget-used' });
    t.answer(0, 'allow $1');   // the sleeping loop wakes and the run goes on
    expect(await within(driven, 3000)).toEqual({ result: 'finished' });
    expect(run.status).toBe('done');
  }, 15_000);

  it('an invalid answer on a track\'s gate wakes the loop: the gate is asked again, though no track can run', async () => {
    const h = m2harness('D4');
    const hb = h.hold(subOf('D4', 'b'));
    const t = heldIo();
    const run = mk(h, `## split\nnext: ga\nnext: b\n\n${MAIN}## gate\nid: ga\nuntil: you approve\n\n## end\n\n## phase b\n> b\n\n## end`);
    const driven = driveRun(run, t.io, () => {});
    await hb.started;
    await until(() => t.asked.length === 1);
    t.answer(0, 'what?');
    await until(() => t.asked.length === 2);   // the loop was asleep in step() on b's held turn; only the settle handler's poke wakes it
    expect(t.lines).toContain('Type approve, changes <note>, or stop.');
    t.answer(1, 'approve');
    hb.release();
    expect(await within(driven, 3000)).toEqual({ result: 'finished' });
  }, 15_000);

  it('a null answer to a track\'s gate detaches the run at once, though a branch is mid-turn; the run keeps its tracks running for a restore', async () => {
    const h = m2harness('D5');
    const hb = h.hold(subOf('D5', 'b'));
    const t = heldIo();
    const run = mk(h, `## split\nnext: ga\nnext: b\n\n${MAIN}## gate\nid: ga\nuntil: you approve\n\n## end\n\n## phase b\n> b\n\n## end`);
    const driven = driveRun(run, t.io, () => {});
    await hb.started;
    await until(() => t.asked.length === 1);
    t.answer(0, null);
    expect(await within(driven, 2000)).toEqual({ result: 'detached' });
    expect(run.status).toBe('running');
    expect(run.tracks.get('b')!.state).toBe('running');
    expect(h.stats(subOf('D5', 'b')).closed).toBe(1);
  }, 15_000);

  it('"changes <note>" on a track\'s gate sends the change request on THAT track, and the gate is asked again', async () => {
    const h = m2harness('D9');
    h.script(subOf('D9', 'a'), done('first'), done('revised'));
    const t = heldIo();
    const run = mk(h, `## split\nnext: a\n\n${MAIN}## phase a\n> a\n\n## gate\nid: ga\nuntil: you approve\n\n## end`);
    const driven = driveRun(run, t.io, () => {});
    await until(() => t.asked.length === 1);
    t.answer(0, 'changes tighten the plan');
    await until(() => t.asked.length === 2);
    const texts = h.stats(subOf('D9', 'a')).texts;
    expect(texts).toHaveLength(2);   // the change request was a turn of the track's own session
    expect(texts[1]).toContain('tighten the plan');
    expect(run.getEvents().filter((e) => e.type === 'card_delivered').map((e) => e.data)).toMatchObject([{ card: 'tighten the plan', track: 'a' }]);
    t.answer(1, 'approve');
    expect(await within(driven, 3000)).toEqual({ result: 'finished' });
  }, 15_000);

  it('"allow <n>" on one track\'s loop budget question raises only that track', async () => {
    const h = m2harness('D10');
    const loop = (n: number) => '## repeat\nuntil: tests pass\nmax: 1\n\n### run `npm test`\n\n### phase fix' + n + '\n> fix ' + n + '\n\n## end';
    const commandRunner = async () => ({ exitCode: 1, stdout: '', stderr: '' });
    const t = heldIo();
    const run = mk(h, `## split\nnext: repeat-1\nnext: repeat-2\n\n${MAIN}${loop(1)}\n\n${loop(2)}`, undefined, { commandRunner });
    const driven = driveRun(run, t.io, () => {});
    await until(() => t.asked.length === 2);
    expect(t.asked.map((q) => q.kind)).toEqual(['budget', 'budget']);
    expect(t.lines.filter((l) => l.startsWith('⏸ loop ')).map((l) => l.split(' ')[2])).toEqual(['repeat-1', 'repeat-2']);
    t.answer(1, 'allow 1');   // the second question is repeat-2's
    await until(() => t.asked.length === 3);   // repeat-2 tried once more and used its budget again
    expect(run.snapshot().loopLimitExtensions).toEqual({ 'repeat-2': 1 });
    expect(t.isOpen(0)).toBe(true);
    expect(run.pauses().map((p) => p.track)).toEqual(['repeat-1', 'repeat-2']);
    await run.stop();
    expect(await within(driven, 3000)).toEqual({ result: 'finished' });
  }, 15_000);

  it('a question of a track that throws ends the run as detached with the error said, though a branch is mid-turn', async () => {
    const h = m2harness('D8');
    const hb = h.hold(subOf('D8', 'b'));
    const t = heldIo();
    t.io.ask = async () => { throw new Error('boom'); };
    const run = mk(h, `## split\nnext: ga\nnext: b\n\n${MAIN}## gate\nid: ga\nuntil: you approve\n\n## end\n\n## phase b\n> b\n\n## end`);
    const driven = driveRun(run, t.io, () => {});
    await hb.started;
    expect(await within(driven, 2000)).toEqual({ result: 'detached', error: 'boom' });
    expect(t.lines).toContain('✗ boom');
    expect(h.stats(subOf('D8', 'b')).closed).toBe(1);
  }, 15_000);

  it('a detach with a branch in a judge question: cancel settles it (also from `finally`), and the run closes within 2 s', async () => {
    const h = m2harness('D6');
    const t = heldIo();
    const judge = () => t.io.ask({ id: 'j', kind: 'judge', prompt: 'y / n' }).then((a) => a === 'y');
    const run = mk(h, `## split\nnext: a\nnext: gb\n\n${MAIN}## phase a\n> a\n\n## gate\nid: ja\nuntil: llm says "fine"\n\n## end\n\n## gate\nid: gb\nuntil: you approve\n\n## end`, undefined, { judge });
    const driven = driveRun(run, t.io, () => {});
    await until(() => t.asked.some((q) => q.kind === 'judge') && t.asked.some((q) => q.kind === 'gate'));
    t.answer(t.asked.findIndex((q) => q.kind === 'gate'), null);   // the asker went away
    expect(await within(driven, 2000)).toEqual({ result: 'detached' });
    expect(t.openCount).toBe(0);
    expect(t.cancels.length).toBeGreaterThan(0);
  }, 15_000);

  it('Stop on one track\'s gate while another is in a judge question: the run ends within 2 s, with cancel called before the run closes', async () => {
    const h = m2harness('D7');
    const t = heldIo();
    const judge = () => t.io.ask({ id: 'j', kind: 'judge', prompt: 'y / n' }).then((a) => a === 'y');
    const run = mk(h, `## split\nnext: a\nnext: b\n\n${MAIN}## phase a\n> a\n\n## gate\nid: ja\nuntil: llm says "fine"\n\n## end\n\n## phase b\n> b\n\n## gate\nid: gb\nuntil: you approve\n\n## end`, undefined, { judge });
    const order: string[] = [];
    const close = run.close.bind(run);
    run.close = async () => { order.push('close'); return close(); };
    const cancel = t.io.cancel!;
    t.io.cancel = (why) => { order.push('cancel'); cancel(why); };
    const driven = driveRun(run, t.io, () => {});
    await until(() => t.asked.some((q) => q.kind === 'judge') && t.asked.some((q) => q.kind === 'gate'));
    t.answer(t.asked.findIndex((q) => q.kind === 'gate'), 'stop');
    expect(await within(driven, 2000)).toEqual({ result: 'finished' });
    expect(run.status).toBe('stopped');
    expect(t.openCount).toBe(0);
    expect(t.asked).toHaveLength(2);   // the gate that is still listed after the Stop is not asked again
    expect(order[0]).toBe('cancel');
    expect(order.filter((o) => o === 'close')).toHaveLength(1);
    expect(h.stats(subOf('D7', 'a')).closed).toBe(1);
    expect(h.stats(subOf('D7', 'b')).closed).toBe(1);
  }, 15_000);
});
