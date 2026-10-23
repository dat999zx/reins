// Characterization of cd6e958 (M1 task 2): scripted runs of every block kind, recorded whole as goldens.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseWorkflow } from '../src/format/parse.js';
import { Run, type RunOptions } from '../src/run.js';
import { receipt } from '../src/receipt.js';
import type { Workflow } from '../src/model.js';
import { golden } from './golden-3a/stable.js';
import { harness } from './m1-harness.js';

const GOLDEN = path.join(__dirname, 'golden-m1');
const rec = (name: string, v: unknown) => golden(`runs-${name}.json`, v, 'REINS_RECORD_M1', GOLDEN);

const wf = (body: string, usd = false): Workflow => {
  const r = parseWorkflow(`---\nreins: 1\nname: t\nbudget: { turns: 40, minutes: 60${usd ? ', usd: 2' : ''} }\nalways: []\n---\n\n${body}\n`);
  expect(r.diagnostics).toEqual([]);
  return r.workflow!;
};

const EX = path.resolve(__dirname, '../../../examples');
const exBlock = (name: string) => {
  const p = path.join(EX, 'blocks', `${name}.reins.md`);
  return fs.existsSync(p) ? parseWorkflow(fs.readFileSync(p, 'utf8')).workflow : undefined;
};

type H = ReturnType<typeof harness>;
const base = (h: H, workflow: Workflow): RunOptions => ({ workflow, engine: h.engine, now: h.now, judge: h.judge, commandRunner: h.commandRunner });
const drive = async (run: Run) => { for (let k = 0; k < 50 && run.status === 'running'; k++) await run.step(); };
const shape = (run: Run, h: H) => ({
  events: run.getEvents().map((e) => ({ type: e.type, data: e.data })),
  receivedTexts: h.engine.receivedTexts,
  status: run.status,
  pauseReason: run.pauseReason,
  receipt: receipt(run.getEvents()),
});
const done = (text: string) => ({ text: `${text}\nREINS: done` });

describe('m1 behaviour: scripted runs', () => {
  it('S1 phase with a guard card, say, recall and store, with and without the functions', async () => {
    const body = '## phase one\nguard: migrations/**\n> first\n\n## say\n> hello\n\n## recall\nknowl: upload\n\n## phase use\n> use it\n\n## phase after\n> after\n\n## store\nknowl: decision';
    const script = [done('one'), done('say'), done('used'), done('after'), { text: 'decision text\nREINS: done' }];

    const h = harness('S1', script);
    h.hold('recall').release(['PRIOR: upload retries']);
    const withFns = new Run({ ...base(h, wf(body)), recall: h.recall, store: h.store });
    await drive(withFns);

    const g = harness('S1', script);
    const noFns = new Run(base(g, wf(body)));
    await drive(noFns);

    rec('S1', { withFns: shape(withFns, h), noFns: shape(noFns, g) });
  });

  it('S2 verify passes, a failing verify jumps back until the link budget is used, allowMore(1)', async () => {
    const h = harness('S2', [
      done('plan'), { text: 'looks fine' }, { text: 'REINS: fail' },
      done('plan2'), { text: 'looks fine' }, { text: 'REINS: fail' },
      done('plan3'), { text: 'looks fine' }, { text: 'all good' },
    ]);
    const run = new Run(base(h, wf('## phase plan\n> plan it\n\n## verify\nagainst: plan\n\n## verify\nagainst: plan\non-fail: plan (max 1)')));
    await drive(run);
    expect(run.pauseReason?.type).toBe('link-budget-used');
    run.allowMore(1);
    await drive(run);
    rec('S2', shape(run, h));
  });

  it('S3 repeat until tests pass with a run first, exit codes 1, 1, 0', async () => {
    const h = harness('S3');
    for (const [exitCode, stderr] of [[1, 'fail 1'], [1, 'fail 2'], [0, '']] as const) h.hold('command').release({ exitCode, stdout: '', stderr });
    // atRun leaves no event (tests pass at a RUN reuses the exit 0 instead of running the command again), so the calls are recorded too
    const commandCalls: string[] = [];
    const commandRunner = (cmd: string) => { commandCalls.push(cmd); return h.commandRunner(cmd); };
    const run = new Run({ ...base(h, wf('## repeat\nuntil: tests pass\nmax: 3\n\n### run `npm test`\n\n### phase fix\n> fix it')), commandRunner });
    await drive(run);
    // BASELINE: three runs of the command (1, 1, 0) and two fix turns; the third pass exits the loop with no turn after it and no fourth call
    rec('S3', { ...shape(run, h), commandCalls });
  });

  it('S4 repeat until you approve, max 2, judge false, allowMore(1)', async () => {
    const h = harness('S4');
    const run = new Run({ ...base(h, wf('## repeat\nuntil: you approve\nmax: 2\n\n### phase work\n> work')), judge: async () => false });
    await drive(run);
    expect(run.pauseReason?.type).toBe('budget-used');
    run.allowMore(1);
    await drive(run);
    // BASELINE: allowMore(1) gives one more pass, which fails again, so the run ends paused at budget-used with limit 3 (not done)
    rec('S4', shape(run, h));
  });

  it('S5 gate approve, request changes, approve, then a gate judged by an llm', async () => {
    const h = harness('S5', [done('plan v1'), done('plan v2'), done('built')]);
    const run = new Run(base(h, wf('## phase plan\n> plan\n\n## gate\nuntil: you approve\n\n## phase build\n> build\n\n## gate\nuntil: llm says "all good"')));
    await drive(run);
    expect(run.pauseReason?.type).toBe('gate');
    await run.requestChanges('x');
    run.approve();
    await drive(run);
    rec('S5', shape(run, h));
  });

  it('S6 if with else, the condition true and then false', async () => {
    const h = harness('S6');
    h.hold('judge').release(true);
    h.hold('judge').release(false);
    const run = new Run(base(h, wf('## if llm says "first"\n\n### phase yes1\n> y1\n\n### else\n\n### phase no1\n> n1\n\n## if llm says "second"\n\n### phase yes2\n> y2\n\n### else\n\n### phase no2\n> n2')));
    await drive(run);
    rec('S6', shape(run, h));
  });

  it('S7 model step switched, model step with no host, a usd slice over and allowUsd(1)', async () => {
    const h = harness('S7');
    const switched = new Run({ ...base(h, wf('## model claude-x\n\n## phase a\n> a')), switchModel: async (m) => ({ to: 'switched', label: m }) });
    await drive(switched);

    const g = harness('S7');
    const noHost = new Run(base(g, wf('## model claude-x\n\n## phase a\n> a')));
    await drive(noHost);
    // BASELINE: with no switchModel the model_switched row says how: unsupported, and the run goes on

    const u = harness('S7', [{ ...done('a'), cost: 0.02 }, { ...done('b'), cost: 0.02 }, { ...done('c'), cost: 0.02 }]);
    const slice = new Run({ ...base(u, wf('## model claude-x\nusd: 0.01\n\n## phase a\n> a\n\n## phase b\n> b\n\n## phase c\n> c', true)), switchModel: async (m) => ({ to: 'switched', label: m }) });
    await drive(slice);
    expect(slice.pauseReason?.type).toBe('usd-budget-used');
    expect(slice.allowUsd(1)).toBeUndefined();
    await drive(slice);

    rec('S7', { switched: shape(switched, h), noHost: shape(noHost, g), slice: shape(slice, u) });
  });

  it('S8 subagent, phase, verify against the subagent', async () => {
    const h = harness('S8', [done('found it'), done('used it'), { text: 'ok' }]);
    const run = new Run({ ...base(h, wf('## subagent research\nmodel: m1\nusd: 0.50\n> Look.\n\n## phase use\n> use it\n\n## verify\nagainst: research', true)), openSubagent: h.openSubagent });
    await drive(run);
    rec('S8', shape(run, h));
  });

  it('S9 playbook review-pass, end, a free phase', async () => {
    const h = harness('S9');
    const run = new Run({ ...base(h, wf('## phase one\n> first\n\n## playbook review-pass\n\n## end\n\n## phase free\n> free')), resolveBlock: exBlock });
    await drive(run);
    // BASELINE: the playbook's review and fix run, its gate is judged by the harness judge (true), the top-level END finishes the run; the free phase after the end never runs
    // (nothing links to it; that is not an effect of the block). This was `## use review-pass` until M3 Task 11 (the block was removed); the ids and the playbook's own markers changed, nothing else.
    rec('S9', shape(run, h));
  });

  it('S11 paused at a gate, edit() with a step inserted before it, approve()', async () => {
    const h = harness('S11');
    const run = new Run(base(h, wf('## phase a\n> a\n\n## gate\nuntil: you approve\n\n## phase b\n> b')));
    await drive(run);
    expect(run.pauseReason?.type).toBe('gate');
    run.edit(wf('## phase a\n> a\n\n## phase inserted\n> new\n\n## gate\nuntil: you approve\n\n## phase b\n> b'));
    run.approve();
    await drive(run);
    // BASELINE: edit() matches the GATE instruction by op name and keeps the counter on it, so the inserted step (before the gate) never runs: the turns are a and b only
    rec('S11', shape(run, h));
  });
});
