// Characterization of cd6e958 (M1 task 4): snapshots taken inside onEvent (the server's way) are restored from a recorded file, and edit() during an awaited command or judge is recorded.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseWorkflow } from '../src/format/parse.js';
import { Run, type RunOptions, type RunSnapshot } from '../src/run.js';
import type { ScriptedTurn } from '../src/fake-engine.js';
import type { Workflow } from '../src/model.js';
import { golden } from './golden-3a/stable.js';
import { harness, type Hold } from './m1-harness.js';

const GOLDEN = path.join(__dirname, 'golden-m1');
const FLAG = 'REINS_RECORD_M1';

const wf = (body: string, budget = 'turns: 40, minutes: 60'): Workflow => {
  const r = parseWorkflow(`---\nreins: 1\nname: t\nbudget: { ${budget} }\nalways: []\n---\n\n${body}\n`);
  expect(r.diagnostics).toEqual([]);
  return r.workflow!;
};

type H = ReturnType<typeof harness>;
type Ev = Parameters<NonNullable<RunOptions['onEvent']>>[0];
const base = (h: H, workflow: Workflow): RunOptions => ({ workflow, engine: h.engine, now: h.now, judge: h.judge, commandRunner: h.commandRunner });
const drive = async (run: Run) => { for (let k = 0; k < 50 && run.status === 'running'; k++) await run.step(); };
const shape = (run: Run, h: H) => ({
  events: run.getEvents().map((e) => ({ type: e.type, data: e.data })),
  receivedTexts: h.engine.receivedTexts,
  status: run.status,
  pauseReason: run.pauseReason,
  programCounter: run.snapshot().programCounter,
});
const done = (text: string, cost?: number): ScriptedTurn => ({ text: `${text}\nREINS: done`, ...(cost === undefined ? {} : { cost }) });
const switchModel: Partial<RunOptions> = { switchModel: async (m) => ({ to: 'switched', label: m }) };
const USD = 'turns: 40, minutes: 60, usd: 2';
const SUB = '## subagent research\nmodel: m1\nusd: 0.50\n> Look.\n\n';

/** The n-th event of a type (and, when given, of a step): a fresh matcher per run. */
const nth = (type: string, n: number, step?: string) => {
  let seen = 0;
  return (ev: Ev) => ev.type === type && (step === undefined || ev.data.step === step) && ++seen === n;
};

interface Setup {
  workflow: Workflow;
  script?: ScriptedTurn[];
  /** The scripted replies on the fresh harness after the restore. */
  after?: ScriptedTurn[];
  opts?: (h: H) => Partial<RunOptions>;
  /** The snapshot is taken inside onEvent at the first event this matcher accepts, as the server does; absent, the test takes it itself (`taken`). */
  at?: () => (ev: Ev) => boolean;
}

/** (a) drive a fresh run and keep the snapshot; (b) restore from the RECORDED FILE on a fresh harness, answer, drive; (c) record what followed. */
async function freeze(id: string, s: Setup, driveTo: (run: Run, h: H) => Promise<RunSnapshot | void>, answer?: (run: Run, g: H) => void | Promise<void>) {
  const h = harness(id, s.script);
  const match = s.at?.();
  let snap: RunSnapshot | undefined;
  const run: Run = new Run({ ...base(h, s.workflow), ...s.opts?.(h), onEvent: (ev) => { if (!snap && match?.(ev)) snap = run.snapshot(); } });
  snap = (await driveTo(run, h)) ?? snap;
  expect(snap, 'no snapshot was taken').toBeDefined();
  golden(`snap-${id}.json`, snap, FLAG, GOLDEN);

  const recorded = JSON.parse(fs.readFileSync(path.join(GOLDEN, `snap-${id}.json`), 'utf8')) as RunSnapshot;
  const g = harness(id, s.after);
  const back = Run.restore(recorded, { ...base(g, recorded.workflow), ...s.opts?.(g) });
  await answer?.(back, g);
  await drive(back);
  golden(`after-${id}.json`, shape(back, g), FLAG, GOLDEN);
  return { run, back, g, recorded };
}

/** Step until the hold is reached; returns the step that waits on it. */
async function stepTo(run: Run, hold: Hold) {
  let arrived = false;
  void hold.started.then(() => { arrived = true; });
  let p: Promise<unknown> = Promise.resolve();
  for (let k = 0; k < 20 && !arrived; k++) {
    p = run.step();
    await Promise.race([p, hold.started]);
  }
  expect(arrived).toBe(true);
  return { pending: p };   // boxed: awaiting it here would wait for the hold
}

const subOpts = (h: H): Partial<RunOptions> => ({ openSubagent: h.openSubagent, ...switchModel });
const countedFirst: ScriptedTurn = { text: 'looking', cost: 0.06, total: 0.06 };

describe('m1 boundaries: snapshots taken inside onEvent are restored from a recorded file', () => {
  it('B1 first turn_ended of a subagent that asks for a second turn, drive', async () => {
    const { recorded, g } = await freeze('B1', {
      workflow: wf(`${SUB}## phase use\n> use it`, USD),
      script: [countedFirst, { text: 'found it\nREINS: done', cost: 0.04, total: 0.1 }, done('used')],
      after: [{ text: 'found it\nREINS: done', cost: 0.04, total: 0.1 }, done('used')],
      opts: subOpts,
      at: () => nth('turn_ended', 1, 'subagent-1'),
    }, async (r, h) => {
      const turn = h.hold('turn');
      const p = r.step();
      await turn.started;
      r.queueCard('look in docs/', 'now');
      turn.release();
      await p;
      await drive(r);
    });
    // BASELINE: the interrupting `now` card is held outside the snapshot (pendingCards is empty), so the restored subagent gets only the carry-on text; the card is never delivered
    expect(recorded.pendingCards).toEqual([]);
    expect(recorded.subagents).toEqual({ 'subagent-1': { sessionId: 'B1-sub-subagent-1', cost: 0.06, total: 0.06 } });
    expect(g.engine.opens.map((o) => o.sessionId)).toContain('B1-sub-subagent-1');
  });

  it('B2 subagent_result (record finished, handback pending), drive', async () => {
    const { recorded, g } = await freeze('B2', {
      workflow: wf(`${SUB}## phase use\n> use it`, USD),
      script: [{ text: 'found it', cost: 0.06 }, done('used')],
      after: [done('used')],
      opts: subOpts,
      at: () => nth('subagent_result', 1),
    }, drive);
    expect(recorded.handback).toHaveLength(1);
    // BASELINE: the event fires before the counter moves, so the snapshot still sits on the subagent step: the restore runs the subagent AGAIN (new session, its own earlier result in its prompt) and only the second turn, the parent's, is the next parent turn
    expect(recorded.programCounter).toBe(0);
    expect(g.engine.receivedTexts).toHaveLength(2);
    expect(g.engine.receivedTexts[0]).toContain(recorded.handback![0]);
  });

  it('B3 VERIFY turn_started (in flight), drive', async () => {
    const { recorded, back } = await freeze('B3', {
      workflow: wf('## phase plan\n> plan\n\n## verify\nagainst: plan'),
      script: [done('plan'), { text: 'all good' }],
      after: [{ text: 'all good' }],
      at: () => nth('turn_started', 2),
    }, drive);
    expect(recorded.status).toBe('running');
    expect(back.status).toBe('done');
  });

  it('B4 VERIFY with a handback pending, its turn throws, snapshot after the throw, drive', async () => {
    const { recorded, g } = await freeze('B4', {
      workflow: wf(`${SUB}## verify\nagainst: subagent-1`, USD),
      script: [{ text: 'found it', cost: 0.06 }],
      after: [{ text: 'all good' }],
      opts: subOpts,
    }, async (r, h) => {
      await r.step();
      const turn = h.hold('turn');
      const p = r.step();
      await turn.started;
      turn.fail(new Error('x'));
      await expect(p).rejects.toThrow('x');
      return r.snapshot();
    });
    expect(recorded.handback).toHaveLength(1);
    expect(g.engine.receivedTexts[0]).toContain(recorded.handback![0]);
  });

  it('B5 second budget-used pause after allowMore(1), allowMore(1) again: the allowance adds up', async () => {
    const { recorded, back } = await freeze('B5', {
      workflow: wf('## repeat\nuntil: llm says "ok"\nmax: 1\n\n### phase work\n> work'),
      opts: () => ({ judge: async () => false }),
      at: () => nth('loop_budget_exceeded', 2),
    }, async (r) => { await drive(r); r.allowMore(1); await drive(r); }, (r) => r.allowMore(1));
    expect(recorded.pauseReason).toMatchObject({ type: 'budget-used', limit: 2 });
    expect(back.pauseReason).toMatchObject({ type: 'budget-used', limit: 3 });
  });

  it('B6 second link-budget-used pause after allowMore(1), allowMore(1) again: the allowance adds up', async () => {
    const fail = (stderr: string) => ({ exitCode: 1, stdout: '', stderr });
    const { recorded, back } = await freeze('B6', {
      workflow: wf('## phase fix\n> fix\n\n## run `npm test`\non-fail: fix (max 1)'),
      at: () => nth('link_budget_exceeded', 2),
    }, async (r, h) => {
      for (const e of ['fail 1', 'fail 2', 'fail 3']) h.hold('command').release(fail(e));
      await drive(r);
      r.allowMore(1);
      await drive(r);
    }, (r, g) => { g.hold('command').release(fail('fail 4')); r.allowMore(1); });
    expect(recorded.pauseReason).toMatchObject({ type: 'link-budget-used', limit: 2 });
    expect(back.pauseReason).toMatchObject({ type: 'link-budget-used', limit: 3 });
  });
});

describe('m1 boundaries: edit() while a command or a judge is awaited', () => {
  it('E1 edit replaces the held RUN step with a phase of the same id, then exit 0', async () => {
    const h = harness('E1');
    const commands: string[] = [];
    const commandRunner = (cmd: string) => { commands.push(cmd); return h.commandRunner(cmd); };
    const w = wf('## repeat\nuntil: tests pass\nmax: 3\n\n### run `npm test`\n\n### phase fix\n> fix it');
    const run = new Run({ ...base(h, w), commandRunner });
    const hold = h.hold('command');
    const { pending } = await stepTo(run, hold);
    const edited: Workflow = JSON.parse(JSON.stringify(w));
    const kids = edited.steps[0]!.kids!;
    expect(kids[0]!.id).toBe('run-1');
    kids[0] = { id: 'run-1', kind: 'phase', title: 'check', prompt: 'check it', attrs: {}, cards: [], links: [] };
    run.edit(edited);
    hold.release({ exitCode: 0, stdout: '', stderr: '' });
    await pending;
    await drive(run);
    // BASELINE: edit() moves the counter onto the new phase's TURN while the RUN is awaited; the exit 0 then reaches the repeat's cond with atRun read live (false), so `tests pass` runs the command itself: commands is [npm test, npm test]
    golden('edit-E1.json', { ...shape(run, h), commands }, FLAG, GOLDEN);
    expect(commands).toEqual(['npm test', 'npm test']);
  });

  it('E2 edit raises the repeat max from 2 to 4 while the loop judge is awaited, judge false', async () => {
    const h = harness('E2');
    // the SECOND judge is held: it is the attempt that meets the old max, so only the live program decides whether the loop goes on
    let calls = 0;
    const judge: RunOptions['judge'] = async (c, e) => (++calls === 2 ? (h.judge(c, e) as Promise<boolean>) : false);
    const body = (max: number) => `## repeat\nuntil: llm says "ok"\nmax: ${max}\n\n### phase work\n> work`;
    const run = new Run({ ...base(h, wf(body(2))), judge });
    const hold = h.hold('judge');
    const { pending } = await stepTo(run, hold);
    run.edit(wf(body(4)));
    hold.release(false);
    await pending;
    await drive(run);
    // BASELINE: LOOP_BK reads the program after its judge, so the new max 4 applies: the run pauses at budget-used with limit 4 (not 2)
    golden('edit-E2.json', { ...shape(run, h) }, FLAG, GOLDEN);
    expect(run.pauseReason).toMatchObject({ type: 'budget-used', limit: 4 });
  });
});
