import { describe, it, expect } from 'vitest';
import { FakeEngine, Run, type Cond } from '../src/index.js';
import { heldJudge, phase, step, workflow } from './wf3b.js';

const llm: Cond = { t: 'llm', q: 'ok' };

describe('a stop during a judge holds (3b.1)', () => {
  it('GATE: run.stop() while the judge is out leaves the run stopped, not paused at the gate', async () => {
    const h = heldJudge();
    const run = new Run({ workflow: workflow([step('g', 'gate', { cond: llm })]), engine: new FakeEngine(), judge: h.judge });
    const p = run.step();
    await h.started;
    await run.stop();
    h.release(false);
    expect(await p).toBe('stopped');
    expect(run.pauseReason).toBeUndefined();
    expect(run.getEvents().some((e) => e.type === 'gate_paused')).toBe(false);
  });

  it('GATE: a stop card while the judge is out pauses with reason stop, not gate', async () => {
    const h = heldJudge();
    const run = new Run({ workflow: workflow([step('g', 'gate', { cond: llm })]), engine: new FakeEngine(), judge: h.judge });
    const p = run.step();
    await h.started;
    run.queueCard('halt', 'stop');
    h.release(false);
    expect(await p).toBe('paused');
    expect(run.pauseReason).toEqual({ type: 'stop', text: 'halt' });
  });

  it('IF: a stop during the judge does not move the program counter', async () => {
    const h = heldJudge();
    const run = new Run({ workflow: workflow([step('i', 'if', { cond: llm, kids: [phase('a')], else: [] })]), engine: new FakeEngine(), judge: h.judge });
    const before = run.snapshot().programCounter;
    const p = run.step();
    await h.started;
    await run.stop();
    h.release(true);
    expect(await p).toBe('stopped');
    expect(run.snapshot().programCounter).toBe(before);
  });

  it('LOOP_BK: a stop during the judge does not overwrite stopped with budget-used', async () => {
    const h = heldJudge();
    const run = new Run({
      workflow: workflow([step('r', 'repeat', { attrs: { max: '1' }, cond: llm, kids: [phase('a')] })]),
      engine: new FakeEngine(), judge: h.judge,
    });
    await run.step(); // LOOP_IN
    await run.step(); // the body turn
    const p = run.step(); // LOOP_BK, judge held
    await h.started;
    await run.stop();
    h.release(false);
    expect(await p).toBe('stopped');
    expect(run.pauseReason).toBeUndefined();
    expect(run.getEvents().some((e) => e.type === 'loop_iteration' || e.type === 'loop_budget_exceeded')).toBe(false);
  });

  it('RUN.repeatCond: a stop during the judge does not move the program counter', async () => {
    const h = heldJudge();
    const run = new Run({
      workflow: workflow([step('r', 'repeat', { attrs: { max: '3' }, cond: llm, kids: [step('c', 'run', { attrs: { cmd: 'echo hi' } })] })]),
      engine: new FakeEngine(), judge: h.judge,
      commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });
    await run.step(); // LOOP_IN
    const at = run.snapshot().programCounter;
    const p = run.step(); // RUN, then the judge is held
    await h.started;
    await run.stop();
    h.release(true);
    expect(await p).toBe('stopped');
    expect(run.snapshot().programCounter).toBe(at);
  });

  it('TURN: a stop while a whenever judge is out leaves the run stopped, not agent-blocked', async () => {
    let release!: (lines: number) => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    const run = new Run({
      workflow: workflow([phase('a')], { autos: [{ id: 'w', cond: { t: 'diff', n: 0 }, card: { kind: 'note', text: 'x' } }] }),
      engine: new FakeEngine([{ text: 'REINS: blocked: x' }]),
      diffLines: () => new Promise<number>((r) => { release = r; entered(); }),
    });
    const p = run.step();
    await started;
    await run.stop();
    release(5);
    expect(await p).toBe('stopped');
    expect(run.pauseReason).toBeUndefined();
  });
});

const tool = { events: [{ type: 'tool_call' as const, tool: 'Read', input: { file_path: 'a.txt' } }] };

describe('a stop during a turn holds (3b.1)', () => {
  it('requestChanges does not put the gate pause back over stopped', async () => {
    const engine = new FakeEngine([{ ...tool, text: 'REINS: done' }]);
    const run = new Run({ workflow: workflow([step('g', 'gate', { cond: { t: 'approve' } })]), engine });
    await run.step();
    engine.onToolCall = () => { void run.stop(); };
    await run.requestChanges('tweak');
    expect(run.status).toBe('stopped');
  });

  it('a turn that says REINS: blocked leaves stopped, not agent-blocked', async () => {
    const engine = new FakeEngine([{ ...tool, text: 'REINS: blocked: x' }]);
    const run = new Run({ workflow: workflow([phase('a')]), engine });
    engine.onToolCall = () => { void run.stop(); };
    expect(await run.step()).toBe('stopped');
    expect(run.pauseReason).toBeUndefined();
  });

  it('the turn budget does not overwrite stopped', async () => {
    const engine = new FakeEngine([{ ...tool, text: 'REINS: done' }]);
    const run = new Run({ workflow: workflow([phase('a')], { budget: { turns: 1, minutes: 5 } }), engine });
    engine.onToolCall = () => { void run.stop(); };
    expect(await run.step()).toBe('stopped');
  });

  it('a pending now card goes to pendingCards, so it ends as cards_unsent', async () => {
    const engine = new FakeEngine([{ text: 'REINS: done', events: [{ type: 'text', text: 'x' }, ...tool.events] }]);
    const run = new Run({ workflow: workflow([phase('a')]), engine });
    engine.onToolCall = () => { run.queueCard('later', 'now'); void run.stop(); };
    expect(await run.step()).toBe('stopped');
    expect(run.snapshot().pendingCards).toEqual(['later']);
  });

  it('a pending stop card is dropped when the run was stopped', async () => {
    const engine = new FakeEngine([{ ...tool, text: 'REINS: done' }]);
    const run = new Run({ workflow: workflow([phase('a')]), engine });
    engine.onToolCall = () => { run.queueCard('halt', 'stop'); void run.stop(); };
    expect(await run.step()).toBe('stopped');
    expect(run.snapshot().pendingCards).toEqual([]);
    expect(run.getEvents().some((e) => e.type === 'card_delivered' && e.data.kind === 'stop')).toBe(false);
  });
});