// Characterization of cd6e958 (M1 task 3): a snapshot of every pause type is recorded once, then always restored from the recorded file.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseWorkflow } from '../src/format/parse.js';
import { Run, type RunOptions, type RunSnapshot } from '../src/run.js';
import { receipt } from '../src/receipt.js';
import type { ScriptedTurn } from '../src/fake-engine.js';
import type { Workflow } from '../src/model.js';
import { golden } from './golden-3a/stable.js';
import { harness } from './m1-harness.js';

const GOLDEN = path.join(__dirname, 'golden-m1');
const FLAG = 'REINS_RECORD_M1';

const wf = (body: string, budget = 'turns: 40, minutes: 60'): Workflow => {
  const r = parseWorkflow(`---\nreins: 1\nname: t\nbudget: { ${budget} }\nalways: []\n---\n\n${body}\n`);
  expect(r.diagnostics).toEqual([]);
  return r.workflow!;
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
const done = (text: string, cost?: number): ScriptedTurn => ({ text: `${text}\nREINS: done`, ...(cost === undefined ? {} : { cost }) });
const switchModel: Partial<RunOptions> = { switchModel: async (m) => ({ to: 'switched', label: m }) };

interface Setup {
  workflow: Workflow;
  /** The scripted replies before the pause, and (fresh harness) after the restore. */
  script?: ScriptedTurn[];
  after?: ScriptedTurn[];
  /** Options beyond the harness's, for the first run and the restored one alike. */
  opts?: (h: H) => Partial<RunOptions>;
}

/** (a) drive a fresh run to the pause and record its snapshot; (b) restore from the RECORDED FILE on a fresh harness, answer, drive; (c) record what followed. */
async function freeze(id: string, s: Setup, driveTo: (run: Run, h: H) => Promise<void>, answer?: (run: Run) => void | Promise<void>) {
  const h = harness(id, s.script);
  const run = new Run({ ...base(h, s.workflow), ...s.opts?.(h) });
  await driveTo(run, h);
  golden(`snap-${id}.json`, run.snapshot(), FLAG, GOLDEN);

  const recorded = JSON.parse(fs.readFileSync(path.join(GOLDEN, `snap-${id}.json`), 'utf8')) as RunSnapshot;
  const g = harness(id, s.after);
  const back = Run.restore(recorded, { ...base(g, recorded.workflow), ...s.opts?.(g) });
  await answer?.(back);
  await drive(back);
  golden(`after-${id}.json`, shape(back, g), FLAG, GOLDEN);
  return { run, back, g };
}

const GATE = '## phase plan\n> plan\n\n## gate\nuntil: you approve\n\n## phase build\n> build';

describe('m1 snapshots: every pause type is restored from a recorded file', () => {
  it('P1a gate pause, approve()', async () => {
    const { run, back } = await freeze('P1a', { workflow: wf(GATE) }, drive, (r) => r.approve());
    expect(run.pauseReason?.type).toBe('gate');
    expect(back.status).toBe('done');
  });

  it('P1b gate pause, requestChanges then approve', async () => {
    const { back } = await freeze('P1b', { workflow: wf(GATE) }, drive, async (r) => { await r.requestChanges('x'); r.approve(); });
    expect(back.status).toBe('done');
  });

  it('P2 budget-used (repeat max 1, judge false), allowMore(1)', async () => {
    const { run, back } = await freeze('P2', { workflow: wf('## repeat\nuntil: llm says "ok"\nmax: 1\n\n### phase work\n> work') },
      async (r, h) => { h.hold('judge').release(false); await drive(r); }, (r) => r.allowMore(1));
    expect(run.pauseReason?.type).toBe('budget-used');
    expect(back.status).toBe('done');
  });

  it('P3v link-budget-used on a verify on-fail key, allowMore(1)', async () => {
    const { run, back } = await freeze('P3v', {
      workflow: wf('## phase plan\n> plan\n\n## verify\nagainst: plan\non-fail: plan (max 1)'),
      script: [done('plan'), { text: 'REINS: fail' }, done('plan2'), { text: 'REINS: fail' }],
      after: [done('plan3'), { text: 'all good' }],
    }, drive, (r) => r.allowMore(1));
    expect(run.pauseReason).toMatchObject({ type: 'link-budget-used', linkKey: expect.stringContaining('->') });
    expect(back.status).toBe('done');
  });

  it('P3r link-budget-used on a run on-fail key, allowMore(1)', async () => {
    const { run, back } = await freeze('P3r', { workflow: wf('## phase fix\n> fix\n\n## run `npm test`\non-fail: fix (max 1)') },
      async (r, h) => {
        for (const stderr of ['fail 1', 'fail 2']) h.hold('command').release({ exitCode: 1, stdout: '', stderr });
        await drive(r);
      }, (r) => r.allowMore(1));
    expect(run.pauseReason?.type).toBe('link-budget-used');
    expect(back.status).toBe('done');
  });

  it('P3j link-budget-used on a next link key, allowMore(1)', async () => {
    // b jumps over c to d once (max 1); a failing verify sends the run back to a, so the second jump pauses
    const { run, back } = await freeze('P3j', {
      workflow: wf('## phase a\n> a\n\n## phase b\nnext: d (max 1)\n> b\n\n## phase c\n> c\n\n## phase d\n> d\n\n## verify\nagainst: d\non-fail: a'),
      script: [done('a'), done('b'), done('d'), { text: 'REINS: fail' }, done('a2'), done('b2')],
      after: [done('d2'), { text: 'all good' }],
    }, drive, (r) => r.allowMore(1));
    expect(run.pauseReason).toMatchObject({ type: 'link-budget-used', linkKey: expect.stringContaining('~next->') });
    expect(back.status).toBe('done');
  });

  it('P4 stop pause from a stop card during a turn, resume()', async () => {
    const { run, back } = await freeze('P4', { workflow: wf('## phase a\n> a\n\n## phase b\n> b') }, async (r, h) => {
      const turn = h.hold('turn');
      const p = r.step();
      await turn.started;
      r.queueCard('halt', 'stop');
      turn.release();
      await p;
    }, (r) => r.resume());
    expect(run.pauseReason).toEqual({ type: 'stop', text: 'halt' });
    expect(back.status).toBe('done');
  });

  it('P4t stop() during a held subagent turn is terminal: restore and resume() do nothing', async () => {
    const { run, back } = await freeze('P4t', { workflow: wf('## subagent research\nmodel: m1\n> Look.\n\n## phase use\n> use it'), opts: (h) => ({ openSubagent: h.openSubagent }) },
      async (r, h) => {
        const turn = h.hold('turn');
        const p = r.step();
        await turn.started;
        await r.stop();
        turn.release();
        await p;
      }, (r) => r.resume());
    expect(run.status).toBe('stopped');
    expect(back.status).toBe('stopped');
    expect(run.getEvents().filter((e) => e.type === 'run_resumed')).toEqual([]);
    expect(back.getEvents().filter((e) => e.type === 'run_resumed')).toEqual([]);
  });

  it('P5 run-turn-budget-used stays paused: no answer exists', async () => {
    const { run, back } = await freeze('P5', { workflow: wf('## phase a\n> a\n\n## phase b\n> b', 'turns: 1, minutes: 60') }, drive);
    expect(run.pauseReason?.type).toBe('run-turn-budget-used');
    expect(back.status).toBe('paused');
  });

  it('P6 agent-blocked, resume()', async () => {
    const { run, back } = await freeze('P6', {
      workflow: wf('## phase a\n> a\n\n## phase b\n> b'),
      script: [{ text: 'REINS: blocked: need a key' }],
      after: [done('a'), done('b')],
    }, drive, (r) => r.resume());
    expect(run.pauseReason?.type).toBe('agent-blocked');
    expect(back.status).toBe('done');
  });

  it('P7 step-deleted stays paused: no answer exists', async () => {
    const { run, back } = await freeze('P7', { workflow: wf(GATE) }, async (r) => {
      await drive(r);
      r.edit(wf('## phase plan\n> plan\n\n## phase build\n> build'));
    });
    expect(run.pauseReason?.type).toBe('step-deleted');
    expect(back.status).toBe('paused');
  });

  it('P8w usd-budget-used on the workflow budget, allowUsd(1)', async () => {
    const { run, back } = await freeze('P8w', {
      workflow: wf('## phase a\n> a\n\n## phase b\n> b\n\n## phase c\n> c', 'turns: 40, minutes: 60, usd: 1'),
      script: [done('a', 1.5)],
    }, drive, (r) => { expect(r.allowUsd(1)).toBeUndefined(); });
    expect(run.pauseReason).toEqual({ type: 'usd-budget-used', limit: 1, spent: 1.5 });
    expect(back.status).toBe('done');
  });

  it('P8m usd-budget-used on a model slice, allowUsd(1)', async () => {
    const { run, back } = await freeze('P8m', {
      workflow: wf('## model claude-x\nusd: 0.01\n\n## phase a\n> a\n\n## phase b\n> b\n\n## phase c\n> c', 'turns: 40, minutes: 60, usd: 2'),
      script: [done('a', 0.02), done('b', 0.02), done('c', 0.02)],
      opts: () => switchModel,
    }, drive, (r) => { expect(r.allowUsd(1)).toBeUndefined(); });
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', stepId: 'model-1' });
    expect(back.status).toBe('done');
  });

  it('P8s usd-budget-used on a subagent slice, allowUsd(0.2)', async () => {
    const { run, back } = await freeze('P8s', {
      workflow: wf('## subagent research\nmodel: m1\nusd: 0.50\n> Look.\n\n## phase use\n> use it', 'turns: 40, minutes: 60, usd: 2'),
      script: [{ text: '', cost: 0.52, total: 0.52, isError: true }],
      after: [{ ...done('found it', 0.05), total: 0.57 }, done('used it')],
      opts: (h) => ({ openSubagent: h.openSubagent, ...switchModel }),
    }, drive, (r) => { expect(r.allowUsd(0.2)).toBeUndefined(); });
    expect(run.pauseReason).toEqual({ type: 'usd-budget-used', stepId: 'subagent-1', limit: 0.5, spent: 0.52 });
    expect(back.status).toBe('done');
  });
});
