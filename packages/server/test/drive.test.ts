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
