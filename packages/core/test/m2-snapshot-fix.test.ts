// M2 task 9 fix round (Codex review): a track keeps its session id through a close, a snapshot inside the first track_started row lists the whole group,
// a restore without kinds names the saved ones, the program hash tells two Dates apart, and a restore rejects an inconsistent snapshot before it runs.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { validate } from '../src/validate.js';
import { Run, type RunOptions, type RunSnapshot } from '../src/run.js';
import { register, type NodeType } from '../src/nodes/index.js';
import type { ScriptedTurn } from '../src/fake-engine.js';
import type { Workflow } from '../src/model.js';
import { m2harness } from './m2-harness.js';
import { split } from './fixtures/split.js';

declare module '../src/model.js' {
  interface NodeKinds { deadline: true }
}
declare module '../src/compile.js' {
  interface Instrs { DEADLINE: { step: string; when: Date } }
}

/** A toy kind whose instruction holds a Date, which JSON cannot tell apart from another Date. */
let day = '2026-10-22';
const deadline: NodeType = {
  kind: 'deadline',
  attrs: [],
  compile(step, ctx) { ctx.push({ op: 'DEADLINE', step: step.id, when: new Date(day) }); },
  ops: { DEADLINE: { async exec(_i, vm) { vm.next(); } } },
};

const disposers: Array<() => void> = [];
beforeAll(() => { disposers.push(register(split), register(deadline)); });
afterAll(() => { for (const d of disposers.splice(0).reverse()) d(); });

const wf = (body: string): Workflow => {
  const r = parseWorkflow(`---\nreins: 1\nname: t\nbudget: { turns: 40, minutes: 60 }\nalways: []\n---\n\n${body}\n`);
  expect(r.diagnostics).toEqual([]);
  expect(validate(r.workflow!).filter((d) => d.severity === 'error')).toEqual([]);
  return r.workflow!;
};

const STACK2 = '## split\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## end\n\n## phase b\n> b\n\n## end';
// branch a has two turns in a row
const LONG_A = '## split\nnext: a\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a1\n\n## phase a2\n> a2\n\n## end';
const PLAIN = '## phase one\n> 1\n\n## end';

type Harness = ReturnType<typeof m2harness>;
const mk = (h: Harness, body: string, opts: Partial<RunOptions> = {}) =>
  new Run({ workflow: wf(body), engine: h.engine, openSubagent: h.openSubagent, now: h.now, ...opts });
const back = (snap: RunSnapshot, h: Harness, opts: Partial<RunOptions> = {}) =>
  Run.restore(JSON.parse(JSON.stringify(snap)) as RunSnapshot, { engine: h.engine, openSubagent: h.openSubagent, now: h.now, ...opts });
const done = (text: string): ScriptedTurn => ({ text: `${text}\nREINS: done` });
const subOf = (s: string, key: string) => `${s}-sub-${key}`;
const drive = (run: Run) => (async () => { for (let k = 0; k < 50 && run.status === 'running'; k++) await run.step(); })();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean) => { for (let k = 0; k < 400 && !f(); k++) await sleep(5); expect(f()).toBe(true); };
const abandon = async (run: Run) => { await run.stop(); await run.close(); };
const words = (s: string) => `This run was saved with other blocks (${s}); Stop it, or Resume to run it with the blocks you have now.`;

describe('fix 1: a track keeps its session id through a close', () => {
  it('a snapshot after close() still names the session, and the restored track opens it again', async () => {
    const h = m2harness('F1');
    const hold = h.hold(subOf('F1', 'a'));
    const run = mk(h, LONG_A);
    await run.step();   // the split starts a
    const stepping = run.step();   // a's first turn is held
    await hold.started;
    await run.close();   // detach: the held turn is rejected "closed", the track stays running
    await stepping;
    const snap = run.snapshot();
    expect(snap.tracks![0]!.status).toBe('running');
    expect(snap.tracks![0]!.sessionId).toBe(subOf('F1', 'a'));

    const h2 = m2harness('F1');
    const again = back(snap, h2);
    await drive(again);
    expect(h2.subagentOpens.find((o) => o.step === 'a')!.sessionId).toBe(subOf('F1', 'a'));
    await again.close();
  });
});

describe('fix 2: a snapshot inside the first track_started row lists the whole group', () => {
  it('both tracks are already there, and the restored run finishes', async () => {
    const h = m2harness('F2');
    let snap: RunSnapshot | undefined;
    const run: Run = mk(h, STACK2, { onEvent: (ev) => { if (ev.type === 'track_started' && !snap) snap = run.snapshot(); } });
    await run.step();
    await abandon(run);
    expect(snap!.groups![0]!.keys).toEqual(['a', 'b']);
    expect(snap!.tracks!.map((t) => t.key)).toEqual(['a', 'b']);

    const h2 = m2harness('F2');
    h2.script(subOf('F2', 'a'), done('alpha'));
    h2.script(subOf('F2', 'b'), done('beta'));
    const again = back(snap!, h2);
    await drive(again);
    expect(again.status).toBe('done');
    await again.close();
  });
});

describe('fix 3: the saved kinds are compared even when the host gives none now', () => {
  const snapOf = async () => {
    const run = mk(m2harness('F3'), PLAIN, { kinds: { split: '1' } });
    const snap = run.snapshot();
    await run.close();
    return snap;
  };
  it('a restore without kinds pauses and names the saved kinds; Resume runs', async () => {
    const again = back(await snapOf(), m2harness('F3'));
    expect(again.status).toBe('paused');
    expect(again.pauseReason).toEqual({ type: 'stop', text: words('split') });
    again.resume();
    await drive(again);
    expect(again.status).toBe('done');
    await again.close();
  });
  it('a snapshot without kinds, restored without kinds, is not paused', async () => {
    const run = mk(m2harness('F3'), PLAIN);
    const again = back(run.snapshot(), m2harness('F3'));
    expect(again.status).toBe('running');
    await run.close();
    await again.close();
  });
});

describe('fix 4: the program hash', () => {
  it('two programs that differ only in a Date give different hashes: the restore pauses with "the program"', async () => {
    day = '2026-10-22';
    const run = mk(m2harness('F4'), `## deadline\nid: d\n\n${PLAIN}`, { kinds: { deadline: '1' } });
    const snap = run.snapshot();
    await run.close();
    day = '2027-10-22';
    const again = back(snap, m2harness('F4'), { kinds: { deadline: '1' } });
    expect(again.pauseReason).toEqual({ type: 'stop', text: words('the program') });
    day = '2026-10-22';
    const same = back(snap, m2harness('F4'), { kinds: { deadline: '1' } });
    expect(same.status).toBe('running');
    await again.close();
    await same.close();
  });
  it('the hash of a JSON-only program is a fixed literal', async () => {
    const run = mk(m2harness('F4b'), PLAIN, { kinds: {} });
    expect(run.snapshot().programHash).toBe('5ad6b508aa164');
    await run.close();
  });
});

describe('fix 5: kinds is the host opt-in', () => {
  it('without the option a never-tracked run has no hash and no kinds; with it both are written', async () => {
    const bare = mk(m2harness('F5'), PLAIN).snapshot();
    expect(bare).not.toHaveProperty('programHash');
    expect(bare).not.toHaveProperty('kinds');
    const given = mk(m2harness('F5'), PLAIN, { kinds: { split: '1' } }).snapshot();
    expect(given.kinds).toEqual({ split: '1' });
    expect(given.programHash).toMatch(/^[0-9a-f]+$/);
  });
});

describe('fix 6: restore rejects an inconsistent snapshot before it runs', () => {
  /** After one step: a and b running, the group waiting on both. */
  const fresh = async (): Promise<RunSnapshot> => {
    const run = mk(m2harness('F6'), STACK2);
    await run.step();
    const snap = JSON.parse(JSON.stringify(run.snapshot())) as RunSnapshot;
    await abandon(run);
    return snap;
  };
  /** a ended, b running. */
  const partway = async (): Promise<RunSnapshot> => {
    const h = m2harness('F6');
    h.script(subOf('F6', 'a'), done('alpha'));
    h.hold(subOf('F6', 'b'));
    const run = mk(h, STACK2);
    const driven = drive(run);
    await until(() => run.ended.length === 1);
    const snap = JSON.parse(JSON.stringify(run.snapshot())) as RunSnapshot;
    await abandon(run);
    await driven;
    return snap;
  };
  const rejects = (snap: RunSnapshot, why: RegExp) =>
    expect(() => Run.restore(snap, { engine: m2harness('F6').engine })).toThrow(new RegExp(`^saved run is inconsistent: .*${why.source}`));

  it('a valid snapshot of either kind restores', async () => {
    expect(Run.restore(await fresh(), { engine: m2harness('F6').engine }).tracks.size).toBe(2);
    expect(Run.restore(await partway(), { engine: m2harness('F6').engine }).tracks.size).toBe(1);
  });
  it('duplicate track keys', async () => { const s = await fresh(); s.tracks![1]!.key = 'a'; rejects(s, /twice/); });
  it('the empty key', async () => { const s = await fresh(); s.tracks![0]!.key = ''; rejects(s, /empty key/); });
  it.each([99999, -1, 1.5])('a program counter of %s', async (pc) => { const s = await fresh(); s.tracks![0]!.programCounter = pc; rejects(s, /does not have/); });
  it('a group key that is neither a live track nor a result', async () => { const s = await fresh(); s.tracks!.pop(); rejects(s, /neither a live track nor a result/); });
  it('a result for a key the group did not start', async () => { const s = await partway(); s.groups![0]!.results.push({ key: 'zz', title: 'z', text: 't', cost: 0 }); rejects(s, /did not start/); });
  it('a live track that also has a result in its group', async () => { const s = await partway(); s.groups![0]!.results.push({ key: 'b', title: 'b', text: 't', cost: 0 }); rejects(s, /live and also has a result/); });
  it('a track whose group is not saved', async () => { const s = await fresh(); delete s.groups; rejects(s, /not saved/); });
  it('kinds that is not a map, ended that is not a list', async () => {
    const a = await fresh(); (a as { kinds: unknown }).kinds = ['x']; rejects(a, /kinds/);
    const b = await fresh(); (b as { ended: unknown }).ended = {}; rejects(b, /ended/);
    const c = await fresh(); (c as { kinds: unknown }).kinds = { split: 1 }; rejects(c, /kinds/);
  });
  it('a run that ended a track in an earlier pass and starts the same key again still restores', async () => {
    const s = await fresh();
    s.ended = [{ key: 'a', text: 'earlier' }];
    expect(Run.restore(s, { engine: m2harness('F6').engine }).ended).toHaveLength(1);
  });
});
