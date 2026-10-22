// M2 task 11: the boundaries of a run with tracks, as M1's `freeze` does them: drive a run and keep the snapshot taken at the boundary, write it to
// golden-m2/snap-<id>.json, READ THE FILE BACK, restore from it on a fresh harness, answer, drive, and record what followed in after-<id>.json.
// Record once, on this one file: `REINS_RECORD_M2=1 npx vitest run packages/core/test/m2-boundaries.test.ts`. The toy `split` makes the tracks.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseWorkflow } from '../src/format/parse.js';
import { validate } from '../src/validate.js';
import { Run, type RunOptions, type RunSnapshot } from '../src/run.js';
import { register } from '../src/nodes/index.js';
import type { ScriptedTurn } from '../src/fake-engine.js';
import type { Workflow } from '../src/model.js';
import { golden } from './golden-3a/stable.js';
import { m2harness } from './m2-harness.js';
import { split } from './fixtures/split.js';

const GOLDEN = path.join(__dirname, 'golden-m2');
const FLAG = 'REINS_RECORD_M2';

const disposers: Array<() => void> = [];
beforeAll(() => { disposers.push(register(split)); });
afterAll(() => { for (const d of disposers.splice(0).reverse()) d(); });

const wf = (body: string): Workflow => {
  const r = parseWorkflow(`---\nreins: 1\nname: t\nbudget: { turns: 40, minutes: 60 }\nalways: []\n---\n\n${body}\n`);
  expect(r.diagnostics).toEqual([]);
  expect(validate(r.workflow!).filter((d) => d.severity === 'error')).toEqual([]);
  return r.workflow!;
};

// [SPLIT, TURN main, END, TURN a, END, TURN b, END, END]
const STACK2 = '## split\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## end\n\n## phase b\n> b\n\n## end';
// branch a has two turns
const TWO_TURNS = '## split\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## phase a2\n> a2\n\n## end\n\n## phase b\n> b\n\n## end';
const GATES2 = '## split\nnext: g1\nnext: g2\n\n## end\n\n## gate\nid: g1\nuntil: you approve\n\n## end\n\n## gate\nid: g2\nuntil: you approve\n\n## end';

type Harness = ReturnType<typeof m2harness>;
type Ev = Parameters<NonNullable<RunOptions['onEvent']>>[0];
const done = (text: string): ScriptedTurn => ({ text: `${text}\nREINS: done` });
const subOf = (s: string, key: string) => `${s}-sub-${key}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => 'timeout' as const)]);
const until = async (f: () => boolean) => { for (let k = 0; k < 400 && !f(); k++) await sleep(5); expect(f()).toBe(true); };
const drive = (run: Run) => (async () => { for (let k = 0; k < 50 && run.status === 'running'; k++) await run.step(); })();

/** What a restored run did: rows, what every session was sent, and how the sessions were opened. */
const shape = (run: Run, h: Harness) => ({
  events: run.getEvents().map((e) => ({ type: e.type, data: e.data })),
  texts: Object.fromEntries([...new Set(h.opened)].sort().map((id) => [id, h.stats(id).texts])),
  opens: h.subagentOpens.map((o) => ({ step: o.step, sessionId: o.sessionId, costBase: o.costBase })),
  status: run.status,
  pauseReason: run.pauseReason,
  pauses: run.pauses(),
  tracks: [...run.tracks.values()].map((t) => ({ key: t.key, state: t.state, pc: t.pc })),
  ended: run.ended,
  programCounter: run.snapshot().programCounter,
});

interface Setup {
  body: string;
  /** The scripted replies of the first run, and of the restored one. */
  before?: (h: Harness) => void;
  after?: (h: Harness) => void;
  /** The snapshot is taken inside onEvent at the first row this accepts, as the server does. */
  at?: (ev: Ev) => boolean;
  /** Or the test takes it itself, once the run is where it should be. */
  take?: (run: Run) => Promise<RunSnapshot>;
}

/** (a) drive a fresh run and keep the snapshot; (b) restore from the RECORDED FILE on a fresh harness, answer, drive; (c) record what followed. */
async function freeze(id: string, s: Setup, answer?: (run: Run) => void) {
  const h = m2harness(id);
  s.before?.(h);
  let snap: RunSnapshot | undefined;
  const run: Run = new Run({
    workflow: wf(s.body), engine: h.engine, openSubagent: h.openSubagent, now: h.now,
    onEvent: (ev) => { if (!snap && s.at?.(ev)) snap = run.snapshot(); },
  });
  const driven = drive(run);
  if (s.take) {
    await until(() => run.tracks.size > 0 && [...run.tracks.values()].every((t) => t.state === 'paused'));
    snap = await s.take(run);
  } else await within(driven, 300);
  expect(snap, 'no snapshot was taken').toBeDefined();
  golden(`snap-${id}.json`, snap, FLAG, GOLDEN);
  await run.stop();
  await within(driven, 1000);
  await run.close();

  const recorded = JSON.parse(fs.readFileSync(path.join(GOLDEN, `snap-${id}.json`), 'utf8')) as RunSnapshot;
  const g = m2harness(id);
  s.after?.(g);
  const back = Run.restore(recorded, { engine: g.engine, openSubagent: g.openSubagent, now: g.now });
  answer?.(back);
  const redriven = drive(back);
  await within(redriven, 300);   // a run that waits on a pause, or is done, is quiet by now
  const after = shape(back, g);
  golden(`after-${id}.json`, after, FLAG, GOLDEN);
  await back.stop();
  await within(redriven, 1000);
  await back.close();
  return { run, after, g, recorded };
}

describe('m2 boundaries: a snapshot taken inside onEvent is restored from a recorded file', () => {
  const scripts = (id: string, h: Harness) => { h.script(subOf(id, 'a'), done('alpha')); h.script(subOf(id, 'b'), done('beta')); };

  it('X1 track_started: both tracks exist, nothing has run; the restore starts them from their first instruction', async () => {
    const id = 'track-started';
    const { recorded, g, after } = await freeze(id, {
      body: STACK2, before: (h) => scripts(id, h), after: (h) => scripts(id, h),
      at: (ev) => ev.type === 'track_started',
    });
    expect(recorded.tracks!.map((t) => [t.key, t.status, t.programCounter])).toEqual([['a', 'running', 3], ['b', 'running', 5]]);
    expect(recorded.groups).toEqual([{ group: 'split-1', parent: '', keys: ['a', 'b'], results: [] }]);
    expect(after.status).toBe('done');
    expect(g.opened.sort()).toEqual([subOf(id, 'a'), subOf(id, 'b'), `${id}-main-1`].sort());
  });

  it('X2 the first turn_ended of a track with a second turn to come: the restore resumes its session id with its costBase', async () => {
    const id = 'track-turn';
    const { recorded, g, after } = await freeze(id, {
      body: TWO_TURNS,
      before: (h) => { h.script(subOf(id, 'a'), { text: 'first\nREINS: done', cost: 0.03, total: 0.03 }, done('second')); h.script(subOf(id, 'b'), done('beta')); },
      after: (h) => { h.script(subOf(id, 'a'), done('second')); h.script(subOf(id, 'b'), done('beta')); },
      at: (ev) => ev.type === 'turn_ended' && ev.data.track === 'a',
    });
    const a = recorded.tracks!.find((t) => t.key === 'a')!;
    expect(a.sessionId).toBe(subOf(id, 'a'));
    expect(a.money).toEqual({ cost: 0.03, total: 0.03 });
    expect(a.programCounter).toBe(3);   // the row is written inside the turn: the counter has not moved, so the restored track sends this step again, on the resumed session
    const opened = g.subagentOpens.find((o) => o.step === 'a')!;
    expect(opened).toMatchObject({ sessionId: subOf(id, 'a'), costBase: 0.03 });
    expect(after.status).toBe('done');
  });

  it('X3 track_ended: the result is kept in the group, and the other track goes on alone', async () => {
    const id = 'track-ended';
    const { recorded, after } = await freeze(id, {
      body: STACK2, before: (h) => scripts(id, h), after: (h) => scripts(id, h),
      at: (ev) => ev.type === 'track_ended',
    });
    expect(recorded.ended).toHaveLength(1);
    expect(recorded.groups![0]!.results).toHaveLength(1);
    expect(recorded.tracks!).toHaveLength(1);
    expect(after.status).toBe('done');
  });

  it('X4 split_done: the group is taken and forgotten; what the restore does is recorded as it is', async () => {
    const id = 'split-done';
    const { recorded } = await freeze(id, {
      body: STACK2, before: (h) => scripts(id, h), after: (h) => scripts(id, h),
      at: (ev) => ev.type === 'split_done',
    });
    expect(recorded.groups).toBeUndefined();
    expect(recorded.tracks).toBeUndefined();
    expect(recorded.ended).toHaveLength(2);
  });

  it('X5 a track\'s gate pause: it keeps its pause through the file; the key approves it and the other gate still waits', async () => {
    const id = 'track-gate';
    const { recorded, after } = await freeze(id, {
      body: GATES2,
      at: (ev) => ev.type === 'gate_paused' && ev.data.track === 'g1',
    }, (r) => {
      expect(r.pauses().map((p) => p.track)).toEqual(['g1']);
      r.approve('g1');
    });
    expect(recorded.tracks![0]).toMatchObject({ key: 'g1', status: 'paused', pauseReason: { type: 'gate', stepId: 'g1' } });
    expect(recorded.status).toBe('running');
    expect(after.pauses.map((p) => p.track)).toEqual(['g2']);
  });

  it('X6 after approve(key): the approved track has moved on, the other still waits, and both come back that way', async () => {
    const id = 'approve-b';
    const { recorded, after } = await freeze(id, {
      body: GATES2,
      take: async (run) => { run.approve('g2'); return run.snapshot(); },
    });
    expect(recorded.tracks!.map((t) => [t.key, t.status, t.programCounter])).toEqual([['g1', 'paused', 2], ['g2', 'running', 5]]);
    expect(after.pauses.map((p) => p.track)).toEqual(['g1']);
    expect(after.ended.map((e) => e.key)).toEqual(['g2']);
  });
});
