// drive.ts: the answer parser, the pause loop, the two ask helpers, and runOptions (plan 15d 3b.2).
import { describe, it, expect } from 'vitest';
import { FakeEngine, Run, type Cond, type Step, type Workflow } from '@reins/core';
import { askJudge, askTool, driveRun, parseAnswer, runOptions, type DriveIo, type Question } from '../src/drive.js';

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
      detail: 'Block `model-1` has used $0.12 of its $0.10. The workflow\'s USD budget has $1.18 left.',
    }]);
    // 0.12 spent + 0.05 allowed = 0.17; c costs 0.06 more and is the last step
    expect(run.snapshot().runCost).toBeCloseTo(0.18, 9);
  });

  it('an allow past the workflow says the refusal and asks again', async () => {
    const run = blockRun(0.2);
    const answers = ['allow $5', 'stop'];
    const t = testIo(() => answers.shift() ?? null);
    await driveRun(run, t.io, () => {});
    expect(t.lines).toContain("Allow at most $0.08: the workflow's USD budget has that much left.");
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
});
