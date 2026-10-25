// M2 task 3: what the code does at 59d1cf2 and the tracks will touch, recorded before they do. A pin is never edited by a later task.
// Recorded values live in golden-m2/pin-*.json (REINS_RECORD_M2=1 on this one file); small facts are plain expects.
// Already pinned elsewhere and not repeated: a Stop at a pause after a subagent turn goes to the parent (subagent-run.test.ts), snapshots of every
// pause type (m1-snapshots.test.ts and golden-m1/snap-*.json), the subagent's own cost base (subagent-run.test.ts, "the parent's lastTotal").
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseWorkflow } from '../src/format/parse.js';
import { Run, type RunOptions, type RunSnapshot } from '../src/run.js';
import { FakeEngine, type ScriptedTurn } from '../src/fake-engine.js';
import { NODES } from '../src/nodes/index.js';
import { CONDS } from '../src/conds/index.js';
import { CARDS } from '../src/cards/index.js';
import { USD_UNKNOWN } from '../src/display.js';
import type { Workflow } from '../src/model.js';
import { driveRun, type DriveIo, type Question } from '../../server/src/drive.js';
import { golden } from './golden-3a/stable.js';
import { harness } from './m1-harness.js';
import { m2harness } from './m2-harness.js';

const GOLDEN = path.join(__dirname, 'golden-m2');
const FLAG = 'REINS_RECORD_M2';
const pin = (name: string, v: unknown) => golden(`pin-${name}.json`, v, FLAG, GOLDEN);

const wf = (body: string, budget = 'turns: 40, minutes: 60'): Workflow => {
  const r = parseWorkflow(`---\nreins: 1\nname: t\nbudget: { ${budget} }\nalways: []\n---\n\n${body}\n`);
  expect(r.diagnostics).toEqual([]);
  return r.workflow!;
};
const done = (text: string, over: Partial<ScriptedTurn> = {}): ScriptedTurn => ({ text: `${text}\nREINS: done`, ...over });
const drive = async (run: Run) => { for (let k = 0; k < 50 && run.status === 'running'; k++) await run.step(); };
const rows = (run: Run) => run.getEvents().map((e) => ({ type: e.type, data: e.data }));
const named = (run: Run, type: string) => run.getEvents().filter((e) => e.type === type).map((e) => e.data);
const snap = (run: Run): RunSnapshot => JSON.parse(JSON.stringify(run.snapshot()));

// ---- a run with a parent turn done and the subagent's turn held --------------------------------------------------------------------------------

const SUB = '## phase a\n> a\n\n## subagent research\nmodel: m1\n> Look.\n\n## phase use\n> use it';
const subOf = (scenario: string) => `${scenario}-sub-subagent-1`;
const mainOf = (scenario: string) => `${scenario}-main-1`;

async function atHeldSub(scenario: string, body = SUB, opts: Partial<RunOptions> = {}) {
  const h = m2harness(scenario);
  const run = new Run({ workflow: wf(body), engine: h.engine, now: h.now, openSubagent: h.openSubagent, ...opts });
  await run.step();   // the first phase: the parent's session is open and idle
  const hold = h.hold(subOf(scenario));
  const step = run.step();
  await hold.started;
  return { h, run, hold, step };
}

const counts = (h: ReturnType<typeof m2harness>, scenario: string) => {
  const m = h.stats(mainOf(scenario)), s = h.stats(subOf(scenario));
  return { main: { opened: m.opened, closed: m.closed, interrupts: m.interrupts, texts: m.texts }, sub: { opened: s.opened, closed: s.closed, interrupts: s.interrupts, texts: s.texts } };
};

describe('Q1 and Q2: cards during a held subagent turn', () => {
  it('Q1 a now card interrupts the subagent only; its follow-up goes to the subagent; the parent hears nothing', async () => {
    const { h, run, step } = await atHeldSub('Q1');
    h.script(subOf('Q1'), done('found it', { cost: 0.01 }));
    run.queueCard('look in docs/', 'now');
    await step;
    pin('q1-now-card', { counts: counts(h, 'Q1'), status: run.status, pendingCards: run.snapshot().pendingCards, events: rows(run).slice(-9) });
    expect(h.stats(subOf('Q1')).interrupts).toBe(1);
    expect(h.stats(mainOf('Q1')).interrupts).toBe(0);
  });

  it('Q2 a stop card interrupts the subagent only, pauses the run on the stop card, and closes the subagent once', async () => {
    const { h, run, step } = await atHeldSub('Q2');
    run.queueCard('halt', 'stop');
    await step;
    pin('q2-stop-card', { counts: counts(h, 'Q2'), status: run.status, pauseReason: run.pauseReason, subagents: run.snapshot().subagents, events: rows(run).slice(-6) });
    expect(h.stats(subOf('Q2')).interrupts).toBe(1);
    expect(h.stats(mainOf('Q2')).interrupts).toBe(0);
    expect(h.stats(subOf('Q2')).closed).toBe(1);
  });
});

describe('Q3: Run.policy() and the subagent session\'s policy', () => {
  it('the engine reads the run\'s current policy in a TURN; a subagent session reads its own step\'s, fixed at open', async () => {
    const tool = (file: string): ScriptedTurn['events'] => [{ type: 'tool_call', tool: 'Write', input: { file_path: file } }];
    const body = '## phase one\nguard: migrations/**\n> first\n\n## subagent research\nmodel: m1\n> Look.\n\n## phase two\n> second';
    const h = m2harness('Q3');
    h.script(mainOf('Q3'), done('one', { events: tool('migrations/x.sql') }), done('two', { events: tool('src/y.ts') }));
    h.script(subOf('Q3'), done('found', { events: tool('src/z.ts') }));
    const run = new Run({ workflow: wf(body), engine: h.engine, now: h.now, openSubagent: h.openSubagent });
    const initial = run.policy();
    await run.step();
    const afterOne = run.policy();
    const hold = h.hold(subOf('Q3'));
    const p = run.step();
    await hold.started;
    const duringSub = run.policy();
    hold.release();
    await p;
    const subSeen = h.subagentOpens[0]!.policy();
    await run.step();
    const afterTwo = run.policy();
    const checks = (id: string) => h.fake(id)!.recordedPolicyChecks.map((c) => ({ tool: c.tool, input: c.input, policy: c.policy }));
    pin('q3-policy', { initial, afterOne, duringSub, subSeen, afterTwo, mainChecks: checks(mainOf('Q3')), subChecks: checks(subOf('Q3')) });
    expect(initial).toEqual({ mode: 'write', guards: [], allowShell: true });
    expect(duringSub).toBe(afterOne);   // the parent's policy is not changed by a subagent turn
    expect(afterOne.guards).toEqual(['migrations/**']);
  });
});

describe('Q4: stop() and close() with a subagent turn held', () => {
  it('stop() interrupts the subagent session only; the subagent is closed once; close() closes the parent once and again is a no-op', async () => {
    const { h, run, step } = await atHeldSub('Q4');
    await run.stop();
    await step;
    expect(run.status).toBe('stopped');
    expect(counts(h, 'Q4')).toMatchObject({ main: { interrupts: 0, closed: 0 }, sub: { interrupts: 1, closed: 1, opened: 1 } });
    await run.stop();   // a second stop is a no-op
    expect(h.stats(subOf('Q4')).interrupts).toBe(1);
    expect(named(run, 'run_stopped')).toHaveLength(1);
    await run.close();
    await run.close();
    expect(counts(h, 'Q4')).toMatchObject({ main: { interrupts: 0, closed: 1 }, sub: { interrupts: 1, closed: 1 } });
    expect(run.snapshot().sessionId).toBe(mainOf('Q4'));
  });

  it('stop() with no turn in flight interrupts the parent session', async () => {
    const h = m2harness('Q4b');
    const run = new Run({ workflow: wf(SUB), engine: h.engine, now: h.now, openSubagent: h.openSubagent });
    await run.step();
    await run.stop();
    expect(h.stats(mainOf('Q4b')).interrupts).toBe(1);
    expect(h.opened).toEqual([mainOf('Q4b')]);
  });
});

describe('Q5: a main-line reply with isError', () => {
  it('is taken as a reply: it is the step output and the program goes on, with or without a USD budget', async () => {
    for (const budget of ['turns: 40, minutes: 60', 'turns: 40, minutes: 60, usd: 2']) {
      const eng = new FakeEngine([{ text: 'oops', isError: true, cost: 0.01 }, done('b')]);
      const run = new Run({ workflow: wf('## phase a\n> a\n\n## phase b\n> b', budget), engine: eng });
      await run.step();
      expect(run.status).toBe('running');
      expect(run.pauseReason).toBeUndefined();
      expect(run.snapshot().programCounter).toBe(1);
      expect(run.snapshot().turnOutputs).toEqual({ a: 'oops' });
      await drive(run);
      expect(run.status).toBe('done');
      expect(eng.receivedTexts).toHaveLength(2);
    }
  });
});

describe('Q6: auto cards after a TURN', () => {
  it('a stop: auto card pauses the run once the TURN\'s reply is in; the counter has moved on; the auto is disarmed', async () => {
    const eng = new FakeEngine([done('ok'), done('two')]);
    const run = new Run({ workflow: wf('## phase one\n> first\n\n## phase two\n> second\n\n## whenever agent says done\nstop: check it'), engine: eng });
    await run.step();
    pin('q6-auto-stop', { status: run.status, pauseReason: run.pauseReason, pc: run.snapshot().programCounter, autoArmed: run.snapshot().autoArmed, queued: named(run, 'card_queued'), turns: eng.receivedTexts.length });
    expect(run.pauseReason).toEqual({ type: 'stop', text: 'check it' });
  });

  it('a now: auto card waits in pendingCards and is the next turn\'s text', async () => {
    const eng = new FakeEngine([done('ok'), done('two')]);
    const run = new Run({ workflow: wf('## phase one\n> first\n\n## phase two\n> second\n\n## whenever agent says done\nnow: look again'), engine: eng });
    await run.step();
    expect(run.snapshot().pendingCards).toEqual(['look again']);
    expect(named(run, 'card_queued')).toEqual([{ card: 'look again', kind: 'now', source: 'auto' }]);
    await run.step();
    expect(eng.receivedTexts[1]).toContain('look again');
    expect(run.snapshot().pendingCards).toEqual([]);
  });
});

describe('Q7: edit() while a TURN is held', () => {
  it('a step inserted before the running one: the counter follows the step and moves on when the turn ends', async () => {
    const h = harness('Q7');
    const run = new Run({ workflow: wf('## phase a\n> a\n\n## phase b\n> b'), engine: h.engine, now: h.now });
    const turn = h.hold('turn');
    const p = run.step();
    await turn.started;
    run.edit(wf('## phase x\n> x\n\n## phase a\n> a\n\n## phase b\n> b'));
    const mid = run.snapshot().programCounter;
    turn.release();
    await p;
    const after = run.snapshot().programCounter;
    await drive(run);
    expect({ mid, after, status: run.status, texts: h.engine.receivedTexts.length }).toEqual({ mid: 1, after: 2, status: 'done', texts: 2 });
  });

  it('the running step deleted: the run pauses step-deleted at once; the turn that ends then still moves the counter and keeps its output', async () => {
    const h = harness('Q7d');
    const run = new Run({ workflow: wf('## phase a\n> a\n\n## phase b\n> b'), engine: h.engine, now: h.now });
    const turn = h.hold('turn');
    const p = run.step();
    await turn.started;
    run.edit(wf('## phase b\n> b'));
    expect({ status: run.status, reason: run.pauseReason?.type }).toEqual({ status: 'paused', reason: 'step-deleted' });
    turn.release();
    await p;
    const s = run.snapshot();
    expect({ status: s.status, reason: s.pauseReason?.type, pc: s.programCounter, outputs: Object.keys(s.turnOutputs) }).toEqual({ status: 'paused', reason: 'step-deleted', pc: 1, outputs: ['a'] });
  });
});

// ---- Q8 ----------------------------------------------------------------------------------------------------------------------------------------

describe('Q8: the snapshot keys at the end of every scenario of m1-behaviour.test.ts', () => {
  const EX = path.resolve(__dirname, '../../../examples');
  const exBlock = (name: string) => {
    const p = path.join(EX, 'blocks', `${name}.reins.md`);
    return fs.existsSync(p) ? parseWorkflow(fs.readFileSync(p, 'utf8')).workflow : undefined;
  };
  type H = ReturnType<typeof harness>;
  const base = (h: H, workflow: Workflow): RunOptions => ({ workflow, engine: h.engine, now: h.now, judge: h.judge, commandRunner: h.commandRunner });
  const keys = (run: Run) => Object.keys(run.snapshot()).sort();
  const fin = (text: string) => ({ text: `${text}\nREINS: done` });

  it('the key lists, and no tracks key', async () => {
    const all: Record<string, unknown> = {};

    {
      const body = '## phase one\nguard: migrations/**\n> first\n\n## say\n> hello\n\n## recall\nknowl: upload\n\n## phase use\n> use it\n\n## phase after\n> after\n\n## store\nknowl: decision';
      const script = [fin('one'), fin('say'), fin('used'), fin('after'), { text: 'decision text\nREINS: done' }];
      const h = harness('S1', script);
      h.hold('recall').release(['PRIOR: upload retries']);
      const withFns = new Run({ ...base(h, wf(body)), recall: h.recall, store: h.store });
      await drive(withFns);
      const g = harness('S1', script);
      const noFns = new Run(base(g, wf(body)));
      await drive(noFns);
      all.S1 = { withFns: keys(withFns), noFns: keys(noFns) };
    }
    {
      const h = harness('S2', [fin('plan'), { text: 'looks fine' }, { text: 'REINS: fail' }, fin('plan2'), { text: 'looks fine' }, { text: 'REINS: fail' }, fin('plan3'), { text: 'looks fine' }, { text: 'all good' }]);
      const run = new Run(base(h, wf('## phase plan\n> plan it\n\n## verify\nagainst: plan\n\n## verify\nagainst: plan\non-fail: plan (max 1)')));
      await drive(run);
      run.allowMore(1);
      await drive(run);
      all.S2 = keys(run);
    }
    {
      const h = harness('S3');
      for (const [exitCode, stderr] of [[1, 'fail 1'], [1, 'fail 2'], [0, '']] as const) h.hold('command').release({ exitCode, stdout: '', stderr });
      const run = new Run(base(h, wf('## repeat\nuntil: tests pass\nmax: 3\n\n### run `npm test`\n\n### phase fix\n> fix it')));
      await drive(run);
      all.S3 = keys(run);
    }
    {
      const h = harness('S4');
      const run = new Run({ ...base(h, wf('## repeat\nuntil: you approve\nmax: 2\n\n### phase work\n> work')), judge: async () => false });
      await drive(run);
      run.allowMore(1);
      await drive(run);
      all.S4 = keys(run);
    }
    {
      const h = harness('S5', [fin('plan v1'), fin('plan v2'), fin('built')]);
      const run = new Run(base(h, wf('## phase plan\n> plan\n\n## gate\nuntil: you approve\n\n## phase build\n> build\n\n## gate\nuntil: llm says "all good"')));
      await drive(run);
      await run.requestChanges('x');
      run.approve();
      await drive(run);
      all.S5 = keys(run);
    }
    {
      const h = harness('S6');
      h.hold('judge').release(true);
      h.hold('judge').release(false);
      const run = new Run(base(h, wf('## if llm says "first"\n\n### phase yes1\n> y1\n\n### else\n\n### phase no1\n> n1\n\n## if llm says "second"\n\n### phase yes2\n> y2\n\n### else\n\n### phase no2\n> n2')));
      await drive(run);
      all.S6 = keys(run);
    }
    {
      const h = harness('S7');
      const switched = new Run({ ...base(h, wf('## model claude-x\n\n## phase a\n> a')), switchModel: async (m) => ({ to: 'switched', label: m }) });
      await drive(switched);
      const g = harness('S7');
      const noHost = new Run(base(g, wf('## model claude-x\n\n## phase a\n> a')));
      await drive(noHost);
      const u = harness('S7', [{ ...fin('a'), cost: 0.02 }, { ...fin('b'), cost: 0.02 }, { ...fin('c'), cost: 0.02 }]);
      const slice = new Run({ ...base(u, wf('## model claude-x\nusd: 0.01\n\n## phase a\n> a\n\n## phase b\n> b\n\n## phase c\n> c', 'turns: 40, minutes: 60, usd: 2')), switchModel: async (m) => ({ to: 'switched', label: m }) });
      await drive(slice);
      expect(slice.allowUsd(1)).toBeUndefined();
      await drive(slice);
      all.S7 = { switched: keys(switched), noHost: keys(noHost), slice: keys(slice) };
    }
    {
      const h = harness('S8', [fin('found it'), fin('used it'), { text: 'ok' }]);
      const run = new Run({ ...base(h, wf('## subagent research\nmodel: m1\nusd: 0.50\n> Look.\n\n## phase use\n> use it\n\n## verify\nagainst: research', 'turns: 40, minutes: 60, usd: 2')), openSubagent: h.openSubagent });
      await drive(run);
      all.S8 = keys(run);
    }
    {
      const h = harness('S9');
      const run = new Run({ ...base(h, wf('## phase one\n> first\n\n## playbook review-pass\n\n## end\n\n## phase free\n> free')), resolveBlock: exBlock });
      await drive(run);
      all.S9 = keys(run);
    }
    {
      const h = harness('S11');
      const run = new Run(base(h, wf('## phase a\n> a\n\n## gate\nuntil: you approve\n\n## phase b\n> b')));
      await drive(run);
      run.edit(wf('## phase a\n> a\n\n## phase inserted\n> new\n\n## gate\nuntil: you approve\n\n## phase b\n> b'));
      run.approve();
      await drive(run);
      all.S11 = keys(run);
    }

    pin('q8-snapshot-keys', all);
    expect(JSON.stringify(all)).not.toContain('tracks');
  });
});

// ---- Q9 ----------------------------------------------------------------------------------------------------------------------------------------

describe('Q9: requestChanges at a gate', () => {
  it('sends the note as a turn on the same session with every write locked; the gate asks again; the revised reply replaces the step output', async () => {
    const h = m2harness('Q9');
    h.script(mainOf('Q9'), done('plan v1'), done('plan v2', { events: [{ type: 'tool_call', tool: 'Write', input: { file_path: 'src/a.ts' } }] }), done('built'));
    const run = new Run({ workflow: wf('## phase plan\n> plan\n\n## gate\nuntil: you approve\n\n## phase build\n> build'), engine: h.engine, now: h.now });
    await drive(run);
    expect(run.pauseReason?.type).toBe('gate');
    const before = run.policy();
    await run.requestChanges('use fewer files');
    const during = run.policy();
    const pausedAgain = { status: run.status, pauseReason: run.pauseReason };
    const outputs = run.snapshot().turnOutputs;
    run.approve();
    await drive(run);
    pin('q9-request-changes', {
      opened: h.opened, stats: h.stats(mainOf('Q9')), before, during, pausedAgain, outputs,
      delivered: named(run, 'card_delivered'), refusals: named(run, 'refusal'), policyChecks: h.fake(mainOf('Q9'))!.recordedPolicyChecks.map((c) => c.policy),
      afterBuild: run.policy(), status: run.status,
    });
    expect(h.opened).toEqual([mainOf('Q9')]);
    expect(during.pendingGate).toBeDefined();
  });
});

// ---- Q10, Q11 ------------------------------------------------------------------------------------------------------------------------------------

describe('Q10: notes for a resumed subagent', () => {
  it('a card pending when a stopped subagent resumes is its note, not the parent\'s; a fresh subagent leaves it for the parent', async () => {
    const h = m2harness('Q10');
    h.script(subOf('Q10'), { text: 'x', cost: 0.01, total: 0.01, isError: true }, done('found it', { cost: 0.01, total: 0.02 }));
    const run = new Run({ workflow: wf('## subagent research\nmodel: m1\n> Look.\n\n## phase use\n> use it'), engine: h.engine, now: h.now, openSubagent: h.openSubagent });
    run.queueCard('fresh card', 'steer');   // typed before the subagent starts: it waits for the parent
    await drive(run);
    expect(run.status).toBe('paused');
    expect(h.stats(subOf('Q10')).texts[0]).not.toContain('fresh card');
    expect(run.snapshot().pendingCards).toEqual(['fresh card']);
    run.resume();
    await drive(run);
    pin('q10-resumed-notes', { subTexts: h.stats(subOf('Q10')).texts, mainTexts: h.stats(mainOf('Q10')).texts, delivered: named(run, 'card_delivered'), pendingCards: run.snapshot().pendingCards, status: run.status });
    expect(h.stats(subOf('Q10')).texts[1]).toContain('[Reins · a note from the user]\nfresh card');
    expect(h.stats(mainOf('Q10')).texts.join('')).not.toContain('fresh card');
  });
});

describe('Q11: a Resume note', () => {
  it('driveRun queues it as a steer card and the step it resumes sends it', async () => {
    const h = m2harness('Q11');
    h.script(mainOf('Q11'), { text: 'REINS: blocked: need a key' }, done('ok'));
    const run = new Run({ workflow: wf('## phase a\n> a'), engine: h.engine, now: h.now });
    const asked: Question[] = [];
    const io: DriveIo = { ask: async (q) => { asked.push(q); return q.kind === 'resume' ? 'resume use the other file' : null; }, say: () => {}, write: () => {} };
    const out = await driveRun(run, io, () => {});
    pin('q11-resume-note', { out, asked: asked.map((q) => ({ kind: q.kind, prompt: q.prompt })), queued: named(run, 'card_queued'), delivered: named(run, 'card_delivered'), texts: h.stats(mainOf('Q11')).texts, status: run.status });
    expect(named(run, 'card_queued')).toEqual([{ card: 'use the other file', kind: 'steer', source: 'live' }]);
    expect(h.stats(mainOf('Q11')).texts[1]).toContain('use the other file');
  });
});

// ---- Q12 ---------------------------------------------------------------------------------------------------------------------------------------

describe('Q12: the main session\'s cost base after a restore', () => {
  it('opens with the saved lastTotal and totals and the saved session id; a close keeps both; a subagent of the restored run starts with no base', async () => {
    const h = m2harness('Q12');
    h.script(mainOf('Q12'), done('a', { cost: 0.5, total: 1.25, totals: { m: 1.25 } }));
    const body = '## phase a\n> a\n\n## subagent research\nmodel: m1\n> Look.\n\n## phase b\n> b';
    const run = new Run({ workflow: wf(body), engine: h.engine, now: h.now, openSubagent: h.openSubagent });
    await run.step();
    const first = h.fake(mainOf('Q12'))!.opens[0]!;
    expect('costBase' in first || 'sessionId' in first).toBe(false);
    const saved = snap(run);
    expect({ id: saved.sessionId, total: saved.lastTotal, totals: saved.lastTotals }).toEqual({ id: mainOf('Q12'), total: 1.25, totals: { m: 1.25 } });

    const g = m2harness('Q12r');
    const back = Run.restore(saved, { engine: g.engine, now: g.now, openSubagent: g.openSubagent });
    await back.step();   // the subagent step: opens no parent session
    expect(g.opened).toEqual(['Q12r-sub-subagent-1']);
    expect(g.subagentOpens[0]).toMatchObject({ step: 'subagent-1' });
    expect(g.subagentOpens[0]!.costBase).toBeUndefined();
    await back.step();   // phase b: the parent's session opens now
    const reopened = g.fake(mainOf('Q12'))!.opens[0]!;
    expect({ sessionId: reopened.sessionId, costBase: reopened.costBase, costBaseByModel: reopened.costBaseByModel }).toEqual({ sessionId: mainOf('Q12'), costBase: 1.25, costBaseByModel: { m: 1.25 } });

    // a close() keeps the id and the totals for a later turn
    await run.close();
    await run.step();   // the subagent
    await run.step();   // phase b: the parent's session opens again
    expect(h.opened).toEqual([mainOf('Q12'), subOf('Q12'), mainOf('Q12')]);
    expect(h.fake(mainOf('Q12'))!.opens[0]).toMatchObject({ sessionId: mainOf('Q12'), costBase: 1.25 });
  });
});

// ---- Q14 ---------------------------------------------------------------------------------------------------------------------------------------

describe('Q14: the registry after start', () => {
  it('NODES in order with the ops of each kind, CONDS in order, CARDS in order', () => {
    pin('q14-registry', {
      nodes: [...NODES.values()].map((n) => ({ kind: n.kind, ops: Object.keys(n.ops ?? {}) })),
      conds: [...CONDS.keys()],
      cards: [...CARDS.keys()],
    });
    expect([...NODES.keys()]).toEqual(['phase', 'say', 'run', 'gate', 'repeat', 'if', 'verify', 'recall', 'store', 'model', 'subagent', 'end', 'fork', 'playbook']);
    expect([...CONDS.keys()]).toEqual(['approve', 'tests', 'cmd', 'llm', 'review', 'done', 'diff', 'touches', 'attempts', 'same', 'drift']);
    expect([...CARDS.keys()]).toEqual(['guard', 'now', 'stop']);
  });
});

// ---- Q15 ---------------------------------------------------------------------------------------------------------------------------------------

describe('Q15: unknown spend on the main line', () => {
  const THREE = '## phase a\n> a\n\n## phase b\n> b\n\n## phase c\n> c';

  it('under a workflow budget the next call is refused on the USD card with the engine\'s words; Allow does not lift it; it survives a restore', async () => {
    const h = m2harness('Q15');
    h.script(mainOf('Q15'), done('a', { unknownCost: true }), done('b', { cost: 0.1 }));
    const run = new Run({ workflow: wf(THREE, 'turns: 40, minutes: 60, usd: 2'), engine: h.engine, now: h.now });
    await run.step();
    const afterReply = { status: run.status, runUnknown: run.snapshot().runUnknown, runCost: run.snapshot().runCost, ended: named(run, 'turn_ended')[0] };
    await run.step();
    const refused = { status: run.status, reason: run.pauseReason, texts: h.stats(mainOf('Q15')).texts.length, pc: run.snapshot().programCounter, reached: named(run, 'budget_reached') };
    const s = snap(run);
    expect(run.allowUsd(1)).toBeUndefined();
    await run.step();
    const afterAllow = { status: run.status, reason: run.pauseReason, texts: h.stats(mainOf('Q15')).texts.length };

    const g = m2harness('Q15r');
    const back = Run.restore(s, { engine: g.engine, now: g.now });
    await back.step();   // paused: the restored run is not running, so nothing is sent
    back.allowUsd(0.5);
    await back.step();
    const restored = { runUnknown: back.snapshot().runUnknown, status: back.status, reason: back.pauseReason, opened: g.opened, texts: g.stats(mainOf('Q15')).texts };

    pin('q15-unknown-main', { afterReply, refused, afterAllow, restored });
    expect(refused.reason).toMatchObject({ type: 'usd-budget-used', text: USD_UNKNOWN });
    expect(afterReply.runUnknown).toBe(true);
  });

  it('under a slice limit alone the slice is refused; with no limit nothing is stopped but runUnknown is still noted', async () => {
    const h = m2harness('Q15s');
    h.script(mainOf('Q15s'), done('a', { unknownCost: true }));
    const run = new Run({ workflow: wf('## model claude-x\nusd: 0.5\n\n## phase a\n> a\n\n## phase b\n> b'), engine: h.engine, now: h.now, switchModel: async (m) => ({ to: 'switched', label: m }) });
    await drive(run);
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', stepId: 'model-1', text: USD_UNKNOWN });
    expect(run.snapshot().usdUnknown).toEqual(['model-1']);
    expect(h.stats(mainOf('Q15s')).texts).toHaveLength(1);

    const g = m2harness('Q15n');
    g.script(mainOf('Q15n'), done('a', { unknownCost: true }), done('b'));
    const free = new Run({ workflow: wf('## phase a\n> a\n\n## phase b\n> b'), engine: g.engine, now: g.now });
    await drive(free);
    expect(free.status).toBe('done');
    expect(free.snapshot().runUnknown).toBe(true);
  });
});

// ---- Q16 ---------------------------------------------------------------------------------------------------------------------------------------

describe('Q16: a capped main-line turn', () => {
  const BODY = '## subagent research\nmodel: m1\n> Look.\n\n## phase use\n> use it';

  async function capped(scenario: string, steer?: string) {
    const h = m2harness(scenario);
    h.script(subOf(scenario), done('found it', { cost: 0.1 }));
    h.script(mainOf(scenario), { text: 'cut off', isError: true, cost: 1.5 }, done('used it', { cost: 0.1 }));
    const run = new Run({ workflow: wf(BODY, 'turns: 40, minutes: 60, usd: 1'), engine: h.engine, now: h.now, openSubagent: h.openSubagent });
    await run.step();   // the subagent: its result waits in the handback
    if (steer) run.queueCard(steer, 'steer');
    await run.step();   // the parent turn is capped
    const paused = { status: run.status, reason: run.pauseReason, handback: run.snapshot().handback, outputs: run.snapshot().turnOutputs, pc: run.snapshot().programCounter, pending: run.snapshot().pendingCards };
    expect(run.allowUsd(5)).toBeUndefined();
    await run.step();
    const texts = h.stats(mainOf(scenario)).texts;
    return { paused, texts, handbackAfter: run.snapshot().handback, status: run.status, pc: run.snapshot().programCounter, outputs: run.snapshot().turnOutputs };
  }

  it('guardUsd pauses on the USD card, the handback stays, and the turn after Allow is the same full text', async () => {
    const r = await capped('Q16');
    pin('q16-capped-turn', r);
    expect(r.paused.reason).toMatchObject({ type: 'usd-budget-used', limit: 1 });
    expect(r.paused.handback).toHaveLength(1);
    expect(r.texts).toHaveLength(2);
    expect(r.texts[1]).toBe(r.texts[0]);
    expect(r.handbackAfter).toBeUndefined();
  });

  it('a steer card taken into the capped turn\'s text: what the re-run sends', async () => {
    const r = await capped('Q16c', 'mind the tests');
    pin('q16-capped-turn-card', r);
    expect(r.texts[0]).toContain('mind the tests');
  });
});
