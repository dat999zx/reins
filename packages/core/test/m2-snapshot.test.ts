// M2 task 9: a saved run keeps its tracks (one optional `tracks` key, its live groups and its ended results) and a restore runs them on; a changed program
// or changed kind versions pause the restored run with one stop pause. The toy `split` (fixtures/split.ts) makes the tracks. Money per track,
// the per-track answers API and the server are later tasks.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseWorkflow } from '../src/format/parse.js';
import { validate } from '../src/validate.js';
import { Run, type RunOptions, type RunSnapshot, type Track } from '../src/run.js';
import { register } from '../src/nodes/index.js';
import { FakeEngine, type ScriptedTurn } from '../src/fake-engine.js';
import type { Workflow } from '../src/model.js';
import { m2harness } from './m2-harness.js';
import { split } from './fixtures/split.js';

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
const GATES2 = '## split\nnext: g1\nnext: g2\n\n## end\n\n## gate\nid: g1\nuntil: you approve\n\n## end\n\n## gate\nid: g2\nuntil: you approve\n\n## end';
const NUMERIC = '## split\nnext: 2\nnext: 10\n\n## phase main\n> m\n\n## end\n\n## verify\nid: 2\n\n## end\n\n## verify\nid: 10\n\n## end';
const PLAIN = '## phase one\n> 1\n\n## end';

type Harness = ReturnType<typeof m2harness>;
const mk = (h: Harness, body: string, opts: Partial<RunOptions> = {}) =>
  new Run({ workflow: wf(body), engine: h.engine, openSubagent: h.openSubagent, now: h.now, ...opts });
/** What a host does: the snapshot goes through JSON, and the restore gets a fresh harness. */
const back = (snap: RunSnapshot, h: Harness, opts: Partial<RunOptions> = {}) =>
  Run.restore(JSON.parse(JSON.stringify(snap)) as RunSnapshot, { engine: h.engine, openSubagent: h.openSubagent, now: h.now, ...opts });
const done = (text: string): ScriptedTurn => ({ text: `${text}\nREINS: done` });
const subOf = (s: string, key: string) => `${s}-sub-${key}`;
const mainOf = (s: string) => `${s}-main-1`;
const drive = (run: Run) => (async () => { for (let k = 0; k < 50 && run.status === 'running'; k++) await run.step(); })();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean) => { for (let k = 0; k < 400 && !f(); k++) await sleep(5); expect(f()).toBe(true); };
const named = (run: Run, type: string) => run.getEvents().filter((e) => e.type === type);
const plain = (run: Run) => run.getEvents().map((e) => ({ type: e.type, data: e.data }));
const addTrack = (run: Run, key: string, at: number): Track => {
  const t: Track = { key, title: key, parent: '', group: '', pc: at, state: 'running', turnInFlight: false, capped: false, handback: [], policy: { mode: 'write', guards: [], allowShell: true }, recall: [] };
  run.tracks.set(key, t);
  return t;
};
/** The run stopped and closed: the snapshot already taken is all that is left of it. */
const abandon = async (run: Run) => { await run.stop(); await run.close(); };

describe('a snapshot with tracks', () => {
  it('mid-split it has tracks with order, parent, group, title, programCounter, status; restored and driven it ends with the same events as an uninterrupted run', async () => {
    const hU = m2harness('S1');
    hU.script(subOf('S1', 'a'), done('alpha'));
    hU.script(subOf('S1', 'b'), done('beta'));
    const whole = mk(hU, STACK2);
    await drive(whole);
    expect(whole.status).toBe('done');

    const h1 = m2harness('S1');
    const first = mk(h1, STACK2);
    await first.step();   // the split starts both tracks and parks the main line
    const snap = first.snapshot();
    await abandon(first);
    expect(snap.tracks).toMatchObject([
      { key: 'a', order: 0, parent: '', group: 'split-1', title: 'Split split-1', programCounter: 3, status: 'running' },
      { key: 'b', order: 1, parent: '', group: 'split-1', title: 'Split split-1', programCounter: 5, status: 'running' },
    ]);
    expect(snap.groups).toEqual([{ group: 'split-1', parent: '', keys: ['a', 'b'], results: [] }]);
    expect(snap.status).toBe('running');

    const h2 = m2harness('S1');
    h2.script(subOf('S1', 'a'), done('alpha'));
    h2.script(subOf('S1', 'b'), done('beta'));
    const again = back(snap, h2);
    await drive(again);
    expect(again.status).toBe('done');
    expect(plain(again)).toEqual(plain(whole));
    await again.close();
    await whole.close();
  });

  it('a run with no tracks writes exactly the M1 keys, and a command result of the main line has no track', async () => {
    const h = m2harness('S2');
    const run = mk(h, PLAIN);
    await drive(run);
    run.recordCommandResult('c', 0, 'o');
    const snap = run.snapshot();
    for (const k of ['tracks', 'groups', 'ended', 'programHash', 'kinds']) expect(snap).not.toHaveProperty(k);
    expect(snap.commandResults).toEqual([{ cmd: 'c', exitCode: 0, output: 'o' }]);
    await run.close();
  });

  it('a command result of a track carries its key, and it comes back through a restore', async () => {
    const h = m2harness('S2b');
    const run = mk(h, PLAIN);
    run.recordCommandResult('m', 0, 'o');
    run.recordCommandResult('x', 1, 'bad', addTrack(run, 'X', 0));
    const snap = run.snapshot();
    expect(snap.commandResults).toEqual([{ cmd: 'm', exitCode: 0, output: 'o' }, { cmd: 'x', exitCode: 1, output: 'bad', track: 'X' }]);
    const again = back(snap, m2harness('S2b'));
    expect(again.snapshot().commandResults).toEqual(snap.commandResults);
    await abandon(run);
    await again.close();
  });

  it('two paused tracks keep both pauseReasons while the top-level status stays running', async () => {
    const h = m2harness('S3');
    const run = mk(h, GATES2);
    const driven = drive(run);
    await until(() => run.tracks.size === 2 && [...run.tracks.values()].every((t) => t.state === 'paused'));
    const snap = run.snapshot();
    expect(snap.status).toBe('running');
    expect(snap.pauseReason).toBeUndefined();
    expect(snap.tracks!.map((t) => [t.key, t.status, t.pauseReason?.type, t.pauseReason?.stepId])).toEqual([['g1', 'paused', 'gate', 'g1'], ['g2', 'paused', 'gate', 'g2']]);
    await abandon(run);
    await driven;

    const again = back(snap, m2harness('S3'));
    expect(again.status).toBe('running');
    expect(again.pauseReason).toBeUndefined();
    expect([...again.tracks.values()].map((t) => [t.key, t.state, t.pause?.type])).toEqual([['g1', 'paused', 'gate'], ['g2', 'paused', 'gate']]);
    expect(again.snapshot()).toEqual(snap);   // everything snapshot() wrote is rebuilt
    await again.close();
  });

  it('an ended track is not run again after a restore, and its result still reaches the step under the split', async () => {
    const h1 = m2harness('S4');
    h1.script(subOf('S4', 'a'), done('alpha'));
    h1.hold(subOf('S4', 'b'));
    const first = mk(h1, STACK2);
    const driven = drive(first);
    await until(() => first.ended.length === 1);
    const snap = first.snapshot();
    await abandon(first);
    await driven;
    expect(snap.tracks!.map((t) => t.key)).toEqual(['b']);
    expect(snap.ended).toEqual([{ key: 'a', text: 'alpha' }]);
    expect(snap.groups).toMatchObject([{ group: 'split-1', parent: '', keys: ['a', 'b'], results: [{ key: 'a', text: 'alpha' }] }]);

    const h2 = m2harness('S4');
    h2.script(subOf('S4', 'b'), done('beta'));
    const again = back(snap, h2);
    expect([...again.tracks.keys()]).toEqual(['b']);
    expect(again.ended).toEqual([{ key: 'a', text: 'alpha' }]);
    await drive(again);
    expect(again.status).toBe('done');
    expect(h2.stats(subOf('S4', 'a')).opened).toBe(0);   // a was not run again
    expect(named(again, 'track_started').filter((e) => e.data.track === 'a')).toHaveLength(1);
    expect(named(again, 'track_ended').filter((e) => e.data.track === 'a')).toHaveLength(1);
    const [text] = h2.stats(mainOf('S4')).texts;
    expect(text).toContain('Result of a: alpha');
    expect(text).toContain('Result of b: beta');
    await again.close();
  });

  it('a split waiting on a branch still parks after a restore and takes when the branch ends', async () => {
    const h1 = m2harness('S5');
    h1.script(subOf('S5', 'a'), done('alpha'));
    h1.hold(subOf('S5', 'b'));
    const first = mk(h1, STACK2);
    const driven = drive(first);
    await until(() => first.ended.length === 1);
    const snap = first.snapshot();
    await abandon(first);
    await driven;

    const h2 = m2harness('S5');
    const hold = h2.hold(subOf('S5', 'b'));
    const again = back(snap, h2);
    const run = drive(again);
    await hold.started;
    await sleep(30);
    expect(h2.stats(mainOf('S5')).texts).toEqual([]);   // parked: b is not done
    expect(again.status).toBe('running');
    hold.release();
    await run;
    expect(again.status).toBe('done');
    expect(h2.stats(mainOf('S5')).texts).toHaveLength(1);
    await again.close();
  });

  it('a track keyed "2" keeps start order next to "10"', async () => {
    const h = m2harness('S6');
    const first = mk(h, NUMERIC);
    await first.step();
    const snap = first.snapshot();
    await abandon(first);
    expect(snap.tracks!.map((t) => [t.key, t.order])).toEqual([['2', 0], ['10', 1]]);
    const scrambled = { ...snap, tracks: [...snap.tracks!].reverse() };   // the order field decides, not the array or the key text
    const again = back(scrambled, m2harness('S6'));
    expect([...again.tracks.keys()]).toEqual(['2', '10']);
    expect(again.snapshot().tracks!.map((t) => t.key)).toEqual(['2', '10']);
    await again.close();
  });

  it('a track that ran a turn keeps its session id, reply and handback, and opens the same session again', async () => {
    const h1 = m2harness('S7');
    h1.script(subOf('S7', 'a'), done('alpha'));
    h1.hold(subOf('S7', 'b'));
    const first = mk(h1, STACK2);
    const driven = drive(first);
    await until(() => first.ended.length === 1);
    const t = first.tracks.get('b')!;
    t.lastTurnText = 'thinking';
    t.handback.push('carried');
    const snap = first.snapshot();
    await abandon(first);
    await driven;
    expect(snap.tracks![0]).toMatchObject({ key: 'b', sessionId: subOf('S7', 'b'), lastTurnText: 'thinking', handback: ['carried'], capped: false });

    const h2 = m2harness('S7');
    const again = back(snap, h2);
    const r = again.tracks.get('b')!;
    expect([r.lastTurnText, r.handback]).toEqual(['thinking', ['carried']]);
    await drive(again);
    expect(h2.subagentOpens.find((o) => o.step === 'b')!.sessionId).toBe(subOf('S7', 'b'));
    await again.close();
  });
});

describe('the program hash and the kinds', () => {
  const snapOf = async (kinds?: Record<string, string>) => {
    const run = mk(m2harness('H'), PLAIN, kinds ? { kinds } : {});
    const snap = run.snapshot();
    await run.close();
    return snap;
  };
  const resumedWords = (s: string) => `This run was saved with other blocks (${s}); Stop it, or Resume to run it with the blocks you have now.`;

  it('the hash and the kinds are written when the host gave kinds, and not otherwise', async () => {
    const snap = await snapOf({ split: '1' });
    expect(snap.kinds).toEqual({ split: '1' });
    expect(snap.programHash).toMatch(/^[0-9a-f]+$/);
    const bare = await snapOf();
    expect(bare).not.toHaveProperty('programHash');
    expect(bare).not.toHaveProperty('kinds');
  });

  it('the same program and kinds restore running', async () => {
    const again = back(await snapOf({ split: '1' }), m2harness('H'), { kinds: { split: '1' } });
    expect(again.status).toBe('running');
    expect(named(again, 'run_paused')).toEqual([]);
  });

  it('a changed kind version pauses with the exact words naming it; Resume runs', async () => {
    const snap = await snapOf({ split: '1', beep: '1' });
    const h = m2harness('H');
    const again = back(snap, h, { kinds: { split: '2', beep: '1' } });
    expect(again.status).toBe('paused');
    expect(again.pauseReason).toEqual({ type: 'stop', text: resumedWords('split') });
    expect(named(again, 'run_paused')).toHaveLength(1);
    expect(named(again, 'run_paused')[0]!.data).toEqual({ reason: 'stop', text: resumedWords('split') });
    again.resume();
    await drive(again);
    expect(again.status).toBe('done');
    await again.close();
  });

  it('a kind added or removed counts as changed; several are named in order', async () => {
    const again = back(await snapOf({ split: '1', beep: '1' }), m2harness('H'), { kinds: { split: '1', zap: '1' } });
    expect(again.pauseReason).toEqual({ type: 'stop', text: resumedWords('beep, zap') });
  });

  it('a changed program with the same kinds pauses with "the program"; Resume runs', async () => {
    const snap = await snapOf({ split: '1' });
    const h = m2harness('H');
    const again = back({ ...snap, programHash: 'deadbeef' }, h, { kinds: { split: '1' } });
    expect(again.pauseReason).toEqual({ type: 'stop', text: resumedWords('the program') });
    expect(named(again, 'run_paused')).toHaveLength(1);
    again.resume();
    expect(again.status).toBe('running');
    await drive(again);
    expect(again.status).toBe('done');
    await again.close();
  });

  it('a changed program is caught without kinds when the snapshot has tracks', async () => {
    const first = mk(m2harness('H2'), STACK2);
    await first.step();
    const snap = first.snapshot();
    await abandon(first);
    expect(snap.programHash).toBeDefined();
    expect(snap).not.toHaveProperty('kinds');
    const again = back({ ...snap, programHash: 'deadbeef' }, m2harness('H2'));
    expect(again.pauseReason).toEqual({ type: 'stop', text: resumedWords('the program') });
    await again.close();
  });

  it('a run that was done or stopped is not paused by a change', async () => {
    const snap = await snapOf({ split: '1' });
    expect(back({ ...snap, status: 'done' }, m2harness('H'), { kinds: { split: '2' } }).status).toBe('done');
    expect(back({ ...snap, status: 'stopped' }, m2harness('H'), { kinds: { split: '2' } }).status).toBe('stopped');
  });

  it('an old snapshot without the fields restores as today', async () => {
    const snap = await snapOf({ split: '1' });
    const { programHash: _h, kinds: _k, ...old } = snap;
    const again = back(old, m2harness('H'), { kinds: { split: '9' } });
    expect(again.status).toBe('running');
    expect(named(again, 'run_paused')).toEqual([]);
  });
});

describe('details a break round showed were unpinned', () => {
  const midSplit = async (tag: string) => {
    const h = m2harness(tag);
    const first = mk(h, STACK2);
    await first.step();   // the split starts both tracks and parks the main line
    const snap = JSON.parse(JSON.stringify(first.snapshot())) as RunSnapshot;
    await abandon(first);
    return snap;
  };

  it('the program hash does not depend on the order of keys in the program', () => {
    const run = mk(m2harness('S9'), STACK2) as any;
    addTrack(run, 'x', 0);
    const was = run.snapshot().programHash;
    expect(typeof was).toBe('string');
    run.program = run.program.map((i: object) => Object.fromEntries(Object.entries(i).reverse()));
    expect(run.snapshot().programHash).toBe(was);
  });

  it('a session id carried from the last save is saved again when the track has not opened its session yet', async () => {
    const snap = await midSplit('S10');
    snap.tracks![0]!.sessionId = 'saved-session';
    const again = back(snap, m2harness('S10'));
    expect(again.snapshot().tracks![0]!.sessionId).toBe('saved-session');
    await abandon(again);
  });

  it('a saved group whose parent track is missing is refused, not guessed', async () => {
    const snap = await midSplit('S11');
    snap.groups![0]!.parent = 'nope';
    expect(() => back(snap, m2harness('S11'))).toThrow('has no parent track "nope"');
  });
});

describe('an M1 snapshot', () => {
  const dir = path.join(__dirname, 'golden-m1');
  for (const id of ['P1a', 'P2', 'P4', 'B1']) {
    it(`${id} restores as before and writes the same keys again`, () => {
      const recorded = JSON.parse(fs.readFileSync(path.join(dir, `snap-${id}.json`), 'utf8')) as RunSnapshot;
      const again = Run.restore(recorded, { engine: new FakeEngine([]) });
      expect(again.status).toBe(recorded.status);
      expect(again.pauseReason).toEqual(recorded.pauseReason);
      expect(again.tracks.size).toBe(0);
      expect(named(again, 'run_paused').length).toBe(recorded.events.filter((e) => e.type === 'run_paused').length);
      expect(Object.keys(JSON.parse(JSON.stringify(again.snapshot()))).sort()).toEqual(Object.keys(recorded).sort());
    });
  }
});
