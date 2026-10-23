// M3 fix round, group A (engine). Item 1: a fork branch whose first block is an own playbook (the branch key and the playbook's track key were the same word).
// Item 2: an own playbook without `usd:` opened its session with no cap although the workflow has a budget.
// The core project's setup registers the pack, so `fork`, `playbook` and `model` are here; `split` is the toy that starts tracks with no share.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { parseWorkflow } from '../src/format/parse.js';
import { validate } from '../src/validate.js';
import { Run, type RunSnapshot } from '../src/run.js';
import { register } from '../src/nodes/index.js';
import type { ScriptedTurn } from '../src/fake-engine.js';
import type { Workflow } from '../src/model.js';
import { m2harness } from './m2-harness.js';
import { split } from './fixtures/split.js';

let off: Array<() => void> = [];
beforeAll(() => { off = [register(split)]; });
afterAll(() => { for (const d of off.reverse()) d(); });

const FIX = path.join(__dirname, 'fixtures', 'blocks');
const blockText = (body: string) => `---\nreins: 1\nblock: b\n---\n\n${body}\n`;
const resolver = (extra: Record<string, string> = {}) => (name: string): Workflow | undefined => {
  if (Object.hasOwn(extra, name)) return parseWorkflow(extra[name]!).workflow;
  const p = path.join(FIX, `${name}.reins.md`);
  return /^[a-z-]+$/.test(name) && fs.existsSync(p) ? parseWorkflow(fs.readFileSync(p, 'utf8')).workflow : undefined;
};
const wf = (body: string, usd?: number): Workflow => {
  const r = parseWorkflow(`---\nreins: 1\nname: t\nbudget: { turns: 60, minutes: 60${usd === undefined ? '' : `, usd: ${usd.toFixed(2)}`} }\nalways: []\n---\n\n${body}\n`);
  expect(r.diagnostics).toEqual([]);
  return r.workflow!;
};
const errors = (w: Workflow, extra: Record<string, string> = {}) => validate(w, resolver(extra)).filter((d) => d.severity === 'error').map((d) => d.message);
type Harness = ReturnType<typeof m2harness>;
const mk = (h: Harness, body: string, usd?: number, extra: Record<string, string> = {}) =>
  new Run({ workflow: wf(body, usd), engine: h.engine, openSubagent: h.openSubagent, now: h.now, resolveBlock: resolver(extra) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Steps until the run is not running; a step that waits for 2 seconds is a run that is stuck (a branch paused alone), and the test reads what it can. */
const drive = async (run: Run) => {
  for (let k = 0; k < 60 && run.status === 'running'; k++) if (await Promise.race([run.step().then(() => 'ok'), sleep(2000).then(() => 'stuck')]) === 'stuck') return;
};
const named = (run: Run, type: string) => run.getEvents().filter((e) => e.type === type);
const done = (text: string, cost = 0): ScriptedTurn => ({ text: `${text}\nREINS: done`, cost });
const keys = (run: Run) => named(run, 'track_started').map((e) => e.data.track as string).sort();

// ---- item 1 ----

const FORK = (a: string, b: string) => `## fork\nnext: ${a}\nnext: ${b}\n\n## phase after\n> after\n\n## end\n\n`;
const PHASE = (id: string) => `## phase ${id}\nid: ${id}\nmode: read-only\n> ${id}\n\n## end\n\n`;
const OWN = (id: string, extra = '') => `## playbook review-pass\nid: ${id}\ninput: target = t; depth = 1\nsession: own\n${extra}\n## end\n\n`;
/** The playbook file's three turns (review, findings, the verify). */
const pbTurns = (h: Harness, sid: string, cost = 0) => h.script(sid, done('r', cost), done('FOUND', cost), { text: 'fine', cost });

describe('item 1: an own playbook first in a fork branch', () => {
  it('the review reproduction: validate says nothing, and the run now goes to its end (the playbook track has its own key)', async () => {
    const h = m2harness('A1');
    pbTurns(h, 'A1-sub-pb#own');
    const run = mk(h, FORK('a', 'pb') + PHASE('a') + OWN('pb'));
    expect(errors(run.workflow)).toEqual([]);
    await drive(run);
    expect(run.status).toBe('done');
    expect(keys(run)).toEqual(['a', 'pb', 'pb#own']);
    expect(named(run, 'run_paused')).toEqual([]);
    expect(named(run, 'fork_done')).toHaveLength(1);
    expect(named(run, 'playbook_done')).toHaveLength(1);
    expect(h.stats('A1-sub-pb#own').texts[0]).toContain('Review t, 1 levels deep.');
    expect(h.stats('A1-main-1').texts.at(-1)).toContain('Result of Playbook review-pass (step pb).');   // the branch's reply is the playbook's result, named by the playbook's step
    await run.close();
  });

  it('the same playbook in the first branch', async () => {
    const h = m2harness('A2');
    pbTurns(h, 'A2-sub-pb#own');
    const run = mk(h, FORK('pb', 'a') + OWN('pb') + PHASE('a'));
    expect(errors(run.workflow)).toEqual([]);
    await drive(run);
    expect(run.status).toBe('done');
    expect(keys(run)).toEqual(['a', 'pb', 'pb#own']);
    await run.close();
  });

  it('two own playbooks, one first in each branch: two inner tracks run at the same time', async () => {
    const h = m2harness('A3');
    pbTurns(h, 'A3-sub-p1#own');
    pbTurns(h, 'A3-sub-p2#own');
    const h1 = h.hold('A3-sub-p1#own'), h2 = h.hold('A3-sub-p2#own');
    const run = mk(h, FORK('p1', 'p2') + OWN('p1') + OWN('p2'));
    expect(errors(run.workflow)).toEqual([]);
    const driven = drive(run);
    await Promise.all([h1.started, h2.started]);
    expect(run.tracks.size).toBe(4);
    h1.release(); h2.release();
    await driven;
    expect(run.status).toBe('done');
    expect(keys(run)).toEqual(['p1', 'p1#own', 'p2', 'p2#own']);
    await run.close();
  });

  it('an own playbook first in one branch AND second in another', async () => {
    const h = m2harness('A4');
    pbTurns(h, 'A4-sub-p1#own');
    pbTurns(h, 'A4-sub-p2#own');
    const run = mk(h, FORK('p1', 'a') + OWN('p1') + `## phase a\nid: a\nmode: read-only\n> a\n\n` + OWN('p2'));
    expect(errors(run.workflow)).toEqual([]);
    await drive(run);
    expect(run.status).toBe('done');
    expect(keys(run)).toEqual(['a', 'p1', 'p1#own', 'p2#own']);
    await run.close();
  });

  it('a nested own playbook: the outer one is first in a branch and the file it runs has an own playbook of its own', async () => {
    const outer = blockText('## playbook review-pass\ninput: target = t; depth = 1\nsession: own\n\n## phase tail\n> tail');
    const h = m2harness('A5');
    pbTurns(h, 'A5-sub-pb/playbook-1#own');
    const run = mk(h, FORK('a', 'pb') + PHASE('a') + '## playbook outer\nid: pb\nsession: own\n\n## end\n', undefined, { outer });
    expect(errors(run.workflow, { outer })).toEqual([]);
    await drive(run);
    expect(run.status).toBe('done');
    expect(keys(run)).toEqual(['a', 'pb', 'pb#own', 'pb/playbook-1#own']);
    expect(h.stats('A5-sub-pb#own').texts).toHaveLength(1);   // the outer playbook's one turn, `tail`
    expect(h.stats('A5-sub-pb/playbook-1#own').texts[0]).toContain('Review t, 1 levels deep.');
    await run.close();
  });

  it('Stop while the playbook track works: everything closes and the run is stopped', async () => {
    const h = m2harness('A6');
    pbTurns(h, 'A6-sub-pb#own');
    const hold = h.hold('A6-sub-pb#own');
    const run = mk(h, FORK('a', 'pb') + PHASE('a') + OWN('pb'));
    const driven = drive(run);
    await hold.started;
    await run.stop();
    await Promise.race([driven.catch(() => {}), sleep(3000)]);
    expect(run.status).toBe('stopped');
    expect(h.stats('A6-sub-pb#own').interrupts + h.stats('A6-sub-pb#own').closed).toBeGreaterThan(0);
    expect(named(run, 'run_paused')).toEqual([]);
    await run.close();
  });

  it('a snapshot taken while the playbook track works restores: the track goes on under its own key, nothing starts twice', async () => {
    const h = m2harness('A7');
    pbTurns(h, 'A7-sub-pb#own');
    const hold = h.hold('A7-sub-pb#own');
    const run = mk(h, FORK('a', 'pb') + PHASE('a') + OWN('pb'));
    const driven = drive(run);
    await hold.started;
    const snap = JSON.parse(JSON.stringify(run.snapshot())) as RunSnapshot;
    expect(snap.tracks!.map((t) => t.key)).toEqual(expect.arrayContaining(['pb', 'pb#own']));
    expect(snap.tracks!.find((t) => t.key === 'pb#own')).toMatchObject({ parent: 'pb', title: 'Playbook review-pass' });
    const back = Run.restore(snap, { engine: h.engine, openSubagent: h.openSubagent, now: h.now, resolveBlock: resolver() });
    hold.fail(new Error('closed'));
    await run.close();
    await Promise.race([driven.catch(() => {}), sleep(2000)]);
    await drive(back);
    expect(back.status).toBe('done');
    expect(named(back, 'playbook_started')).toHaveLength(1);
    expect(named(back, 'playbook_done')).toHaveLength(1);
    expect(named(back, 'fork_done')).toHaveLength(1);
    await back.close();
  });

  it('a step id that is the name the playbook track would take is refused with words (it is the only way left to meet that key)', () => {
    const w = wf(FORK('a', 'pb') + PHASE('a') + OWN('pb') + PHASE('pb#own'));
    expect(errors(w)).toEqual(['playbook `pb` runs as the track `pb#own`, and a step has that id; give the step another id']);
  });

  it('the same inside a file: the outer playbook\'s file has an own playbook and a step named like its track', () => {
    const outer = blockText('## playbook review-pass\ninput: target = t; depth = 1\nsession: own\n\n## phase clash\nid: playbook-1#own\n> x');
    const w = wf(FORK('a', 'pb') + PHASE('a') + '## playbook outer\nid: pb\nsession: own\n\n## end\n');
    expect(errors(w, { outer })).toEqual(['`outer` line 6: playbook `playbook-1` runs as the track `playbook-1#own`, and a step has that id; give the step another id']);
  });
});

// ---- item 2 ----

const PB = (usd?: number) => `## phase one\n> first\n\n## playbook review-pass\ninput: target = t; depth = 1\nsession: own\n${usd === undefined ? '' : `usd: ${usd}\n`}\n## phase two\n> second\n\n## end`;
const opensOf = (h: Harness, key: string) => h.subagentOpens.filter((o) => o.step === key);

describe('item 2: every track without a share is capped like a main-line subagent', () => {
  it('the review reproduction: workflow usd 4, an own playbook with no usd: the session opens with maxUsd 4 and a live room', async () => {
    const h = m2harness('B1');
    pbTurns(h, 'B1-sub-playbook-1#own', 0.2);
    const run = mk(h, PB(), 4);
    await drive(run);
    expect(run.status).toBe('done');
    const o = opensOf(h, 'playbook-1#own')[0]!;
    expect(o.maxUsd).toBe(4);
    expect(typeof o.usdRoom).toBe('function');
    expect(o.usdRoom!()).toBeCloseTo(4 - 0.6, 6);   // the live room: the workflow's, less everything the run spent
    await run.close();
  });

  it('no workflow limit and no slice: still no cap and no room (nothing to hold)', async () => {
    const h = m2harness('B2');
    const run = mk(h, PB());
    await drive(run);
    const o = opensOf(h, 'playbook-1#own')[0]!;
    expect(o.maxUsd).toBeUndefined();
    expect(o.usdRoom).toBeUndefined();
    await run.close();
  });

  it('an open model slice caps it too (the smaller of the slice room and the workflow room)', async () => {
    const h = m2harness('B3');
    const run = mk(h, '## model claude-x\nusd: 0.5\n\n' + PB(), 4);
    await drive(run);
    expect(opensOf(h, 'playbook-1#own')[0]!.maxUsd).toBe(0.5);
    await run.close();
    const g = m2harness('B3w');
    const wide = mk(g, '## model claude-x\nusd: 9\n\n' + PB(), 4);
    await drive(wide);
    expect(opensOf(g, 'playbook-1#own')[0]!.maxUsd).toBe(4);
    await wide.close();
  });

  it('the cap is what is left when the track starts', async () => {
    const h = m2harness('B4');
    h.script('B4-main-1', done('one', 1.5));
    const run = mk(h, PB(), 4);
    await drive(run);
    expect(opensOf(h, 'playbook-1#own')[0]!.maxUsd).toBe(2.5);
    await run.close();
  });

  it('the cap is rounded up to a millionth, as every cap is', async () => {
    const h = m2harness('B4r');
    h.script('B4r-main-1', done('one', 0.3333333));
    const run = mk(h, PB(), 1);
    await drive(run);
    expect(opensOf(h, 'playbook-1#own')[0]!.maxUsd).toBe(0.666667);
    await run.close();
  });

  it('a room that is gone gives a cap of 0, never a negative one', () => {
    const run = mk(m2harness('B4n'), PB(), 1);
    const r = run as unknown as { runCost: number; main: unknown; sliceCap(t: unknown): number | undefined };
    r.runCost = 1.5;
    expect(r.sliceCap(r.main)).toBe(0);
  });

  it('with a usd: line it is as before (its own slice, held to the workflow room)', async () => {
    const h = m2harness('B5');
    const run = mk(h, PB(1), 4);
    await drive(run);
    expect(opensOf(h, 'playbook-1#own')[0]).toMatchObject({ maxUsd: 1 });
    await run.close();
    const g = m2harness('B5b');
    const big = mk(g, PB(10), 4);
    await drive(big);
    expect(opensOf(g, 'playbook-1#own')[0]).toMatchObject({ maxUsd: 4 });
    await big.close();
  });

  it('a playbook with no usd inside an own playbook with no usd: both are capped', async () => {
    const outer = blockText('## playbook review-pass\ninput: target = t; depth = 1\nsession: own\n\n## phase tail\n> tail');
    const h = m2harness('B6');
    const run = mk(h, '## playbook outer\nsession: own\n\n## phase after\n> after', 3, { outer });
    await drive(run);
    expect(run.status).toBe('done');
    expect(opensOf(h, 'playbook-1#own')[0]!.maxUsd).toBe(3);
    expect(opensOf(h, 'playbook-1/playbook-1#own')[0]!.maxUsd).toBe(3);
    await run.close();
  });

  it('a fork branch (it has a share) with an own playbook with no usd inside: the branch and the playbook are both capped', async () => {
    const h = m2harness('B7');
    pbTurns(h, 'B7-sub-b#own');
    const run = mk(h, FORK('a', 'b') + PHASE('a') + `## phase b\nid: b\n> b\n\n## playbook review-pass\nid: p\ninput: target = t; depth = 1\nsession: own\n\n## end\n\n`, 2);
    await drive(run);
    expect(run.status).toBe('done');
    expect(opensOf(h, 'a')[0]!.maxUsd).toBe(1);
    expect(opensOf(h, 'b')[0]!.maxUsd).toBe(1);
    expect(opensOf(h, 'p#own')[0]!.maxUsd).toBeDefined();
    expect(opensOf(h, 'p#own')[0]!.maxUsd!).toBeLessThanOrEqual(2);
    await run.close();
  });

  it('a limit crossed by two tracks at once: both were capped at the room, the run asks once and keeps both replies', async () => {
    const h = m2harness('B8');
    h.script('B8-sub-a', done('a', 0.7));
    h.script('B8-sub-b', done('b', 0.7));
    const ha = h.hold('B8-sub-a'), hb = h.hold('B8-sub-b');
    const run = mk(h, '## split\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n' + PHASE('a') + PHASE('b'), 1);
    const driven = drive(run);
    await Promise.all([ha.started, hb.started]);
    expect(opensOf(h, 'a')[0]!.maxUsd).toBe(1);
    expect(opensOf(h, 'b')[0]!.maxUsd).toBe(1);
    expect(opensOf(h, 'a')[0]!.usdRoom!()).toBe(1);
    ha.release(); hb.release();
    await Promise.race([driven.catch(() => {}), sleep(3000)]);
    expect(run.status).toBe('paused');
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used' });
    expect(named(run, 'budget_reached')).toHaveLength(1);
    expect(opensOf(h, 'a')[0]!.usdRoom!()).toBeLessThanOrEqual(0);
    await run.close();
  });
});
