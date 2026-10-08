import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseWorkflow, compileProgram, Run, FakeEngine } from '../src/index.js';
import type { Workflow } from '../src/index.js';

const head = '---\nreins: 1\nname: starts\nbudget: { turns: 40, minutes: 5 }\nalways: []\n---\n\n';
const ok = (body: string) => {
  const p = parseWorkflow(head + body);
  expect(p.diagnostics).toEqual([]);
  return p.workflow!;
};
const block = (body: string) => {
  const p = parseWorkflow(`---\nblock: blk\n---\n\n${body}\n`);
  expect(p.diagnostics).toEqual([]);
  return p.workflow!;
};
const exit = (code: number) => async () => ({ exitCode: code, stdout: '', stderr: '' });
const startsOf = (run: Run) => run.getEvents().filter((e) => e.type === 'step_started').map((e) => e.data);
const drive = async (run: Run, max = 60) => { for (let i = 0; i < max && run.status === 'running'; i++) await run.step(); };

describe('step_started', () => {
  it('phase, run, gate, end report their start in order; command_result carries the exit code', async () => {
    for (const code of [0, 1]) {
      const run = new Run({
        workflow: ok('## phase plan\n> Plan.\n\n## run `x`\n\n## gate\nuntil: you approve\n\n## end\n'),
        engine: new FakeEngine(), commandRunner: exit(code),
      });
      await drive(run);
      expect(run.status).toBe('paused');
      run.approve();
      await drive(run);
      expect(run.status).toBe('done');
      expect(startsOf(run)).toEqual([
        { step: 'plan', parents: [] }, { step: 'run-1', parents: [] }, { step: 'gate-1', parents: [] }, { step: 'end-1', parents: [] },
      ]);
      const types = run.getEvents().map((e) => e.type);
      expect(types.at(-1)).toBe('run_finished');
      expect(run.getEvents().filter((e) => e.type === 'command_result').map((e) => e.data)).toEqual([{ step: 'run-1', exitCode: code }]);
      // the result follows its own step's start
      expect(types.indexOf('command_result')).toBeGreaterThan(run.getEvents().findIndex((e) => e.type === 'step_started' && e.data.step === 'run-1'));
    }
  });

  it('a repeat starts once, its kids every iteration, and again after allowMore', async () => {
    const run = new Run({
      workflow: ok('## repeat\nmax: 2\n\n### phase a\n> A.\n\n### phase b\n> B.\n'),
      engine: new FakeEngine(),
    });
    await drive(run);
    expect(run.status).toBe('paused');
    expect(startsOf(run)).toEqual([
      { step: 'repeat-1', parents: [] },
      { step: 'a', parents: ['repeat-1'] }, { step: 'b', parents: ['repeat-1'] },
      { step: 'a', parents: ['repeat-1'] }, { step: 'b', parents: ['repeat-1'] },
    ]);
    run.allowMore(1);
    await drive(run);
    expect(startsOf(run).slice(5)).toEqual([{ step: 'a', parents: ['repeat-1'] }, { step: 'b', parents: ['repeat-1'] }]);
  });

  it('an if reports once, then only the path it takes', async () => {
    const body = '## if tests pass\n\n### phase yes\n> Y.\n\n### else\n\n### phase no\n> N.\n';
    for (const [code, path] of [[0, 'yes'], [1, 'no']] as const) {
      const run = new Run({ workflow: ok(body), engine: new FakeEngine(), commandRunner: exit(code) });
      await drive(run);
      expect(run.status).toBe('done');
      expect(startsOf(run)).toEqual([{ step: 'if-1', parents: [] }, { step: path, parents: ['if-1'] }]);
      expect(run.getEvents().some((e) => e.type === 'command_result')).toBe(false);
    }
  });

  it('a next link and an on-fail link report the step they land on, not the ones they skip', async () => {
    const jump = new Run({ workflow: ok('## phase a\nnext: c\n> A.\n\n## phase b\n> B.\n\n## phase c\n> C.\n'), engine: new FakeEngine() });
    await drive(jump);
    expect(startsOf(jump).map((s) => s.step)).toEqual(['a', 'c']);

    const fail = new Run({
      workflow: ok('## run `x`\non-fail: fix\n\n## phase skip\n> S.\n\n## phase fix\n> F.\n'),
      engine: new FakeEngine(), commandRunner: exit(1),
    });
    await drive(fail);
    expect(startsOf(fail).map((s) => s.step)).toEqual(['run-1', 'fix']);
  });

  it('use reports itself, then the block step with the use step as parent, before that step\'s turn', async () => {
    const run = new Run({
      workflow: ok('## use blk\n'), engine: new FakeEngine(),
      resolveBlock: (n) => (n === 'blk' ? block('## phase plan\n> P.') : undefined),
    });
    await drive(run);
    expect(startsOf(run)).toEqual([{ step: 'use-1', parents: [] }, { step: 'blk/plan', parents: ['use-1'] }]);
    const types = run.getEvents().map((e) => `${e.type}:${e.data.step ?? ''}`);
    expect(types.indexOf('step_started:blk/plan')).toBeLessThan(types.indexOf('turn_started:blk/plan'));
  });

  it('a stop card during a turn, then resume(), reports the step again', async () => {
    const eng = new FakeEngine([{ events: [{ type: 'tool_call', tool: 'Read', input: { file_path: 'a' } }], text: '' }]);
    const run = new Run({ workflow: ok('## phase one\n> first\n\n## phase two\n> second\n'), engine: eng });
    eng.onToolCall = () => { eng.onToolCall = undefined; run.queueCard('halt', 'stop'); };
    await drive(run);
    expect(run.status).toBe('paused');
    run.resume();
    await drive(run);
    expect(startsOf(run).map((s) => s.step)).toEqual(['one', 'one', 'two']);
  });

  it('a restored run reports the next start and does not repeat run_started', async () => {
    const wf = ok('## phase plan\n> Plan.\n\n## gate\nuntil: you approve\n\n## phase build\n> Build.\n');
    const first = new Run({ workflow: wf, engine: new FakeEngine() });
    await drive(first);
    expect(first.pauseReason?.type).toBe('gate');
    const seen: Array<{ type: string; data: any }> = [];
    const run = Run.restore(first.snapshot(), { engine: new FakeEngine(), onEvent: (e) => seen.push(e) });
    run.approve();
    await drive(run);
    expect(run.status).toBe('done');
    expect(seen.filter((e) => e.type === 'run_started')).toEqual([]);
    expect(seen.filter((e) => e.type === 'step_started').map((e) => e.data)).toEqual([{ step: 'build', parents: [] }]);
  });

  it('run_started lists the flat depth-first steps, with a title exactly where the step has one', () => {
    const w = ok('## repeat\nmax: 2\n\n### phase a\n> A.\n\n### run `x`\n\n## if tests pass\n\n### phase yes\n> Y.\n\n### else\n\n### phase no\n> N.\n\n## gate\nuntil: you approve\n');
    const flat = (steps: Workflow['steps']): Workflow['steps'] => steps.flatMap((s) => [s, ...flat(s.kids ?? []), ...flat(s.else ?? [])]);
    const expected = flat(w.steps).map((s) => ({ id: s.id, kind: s.kind, ...(s.title ? { title: s.title } : {}) }));
    const run = new Run({ workflow: w, engine: new FakeEngine() });
    const started = run.getEvents()[0]!;
    expect(started.type).toBe('run_started');
    expect(started.data.steps).toEqual(expected);
    expect(started.data.steps.map((s: { id: string }) => s.id)).toEqual(['repeat-1', 'a', 'run-1', 'if-1', 'yes', 'no', 'gate-1']);
    expect(started.data.steps.find((s: { id: string }) => s.id === 'a')).toMatchObject({ title: 'a' });
    expect(started.data.steps.find((s: { id: string }) => s.id === 'run-1')).not.toHaveProperty('title');
  });

  it('compileProgram without a starts map is the same program as with one (upload-retry, review-pass resolved)', () => {
    const read = (f: string) => readFileSync(new URL(`../../../examples/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const w = parseWorkflow(read('upload-retry.reins.md')).workflow!;
    const rb = (n: string) => (n === 'review-pass' ? parseWorkflow(read('blocks/review-pass.reins.md')).workflow : undefined);
    const starts = new Map();
    expect(compileProgram(w, rb, starts)).toEqual(compileProgram(w, rb));
    expect(compileProgram(w, undefined, new Map())).toEqual(compileProgram(w));
    expect([...starts.values()].flat().map((s) => s.step)).toContain('review-pass/review');
  });
});
