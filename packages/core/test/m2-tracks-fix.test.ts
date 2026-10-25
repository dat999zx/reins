// M2 task 8, fix round: six defects a review found in the scheduler, each reproduced here first. See docs/plan/m2-codex-8-review.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { validate } from '../src/validate.js';
import { Run, type RunOptions, type SubagentOpen, type Track } from '../src/run.js';
import { register } from '../src/nodes/index.js';
import type { Workflow } from '../src/model.js';
import { m2harness } from './m2-harness.js';
import { split } from './fixtures/split.js';

const disposers: Array<() => void> = [];
beforeAll(() => { disposers.push(register(split)); });
afterAll(() => { for (const d of disposers.splice(0).reverse()) d(); });

const wf = (body: string): Workflow => {
  const r = parseWorkflow(`---\nreins: 1\nname: t\nbudget: { turns: 40, minutes: 60 }\nalways: []\n---\n\n${body}\n`);
  expect(r.diagnostics).toEqual([]);
  expect(validate(r.workflow!).filter((d) => d.severity === 'error').map((d) => d.message)).toEqual([]);
  return r.workflow!;
};
// [SPLIT, END, TURN a, END, END]
const ONE = '## split\nnext: a\n\n## end\n\n## phase a\n> a\n\n## end';
type Harness = ReturnType<typeof m2harness>;
const mk = (h: Harness, body: string, opts: Partial<RunOptions> = {}) =>
  new Run({ workflow: wf(body), engine: h.engine, openSubagent: h.openSubagent, now: h.now, ...opts });
const subOf = (s: string, key: string) => `${s}-sub-${key}`;
const drive = (run: Run) => (async () => { for (let k = 0; k < 50 && run.status === 'running'; k++) await run.step(); })();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean) => { for (let k = 0; k < 400 && !f(); k++) await sleep(5); expect(f()).toBe(true); };
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => 'timeout' as const)]);
const deferred = <T = void>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => (resolve = r)); return { promise, resolve }; };
const named = (run: Run, type: string) => run.getEvents().filter((e) => e.type === type);

describe('fix round: Stop, close and throw on tracks', () => {
  it('1. a Stop that lands right after a track session opened lets no turn start after it', async () => {
    for (let k = 0; k < 12; k++) {
      const scenario = `F1-${k}`;
      const h = m2harness(scenario);
      const ref: { run?: Run } = {};
      const letOpen = deferred();
      const openSubagent = async (o: SubagentOpen) => {
        await letOpen.promise;
        const r = await h.openSubagent(o);
        let n = k;
        const tick = () => (n-- > 0 ? queueMicrotask(tick) : void ref.run!.stop());   // Stop lands k microtasks after the opener returned
        queueMicrotask(tick);
        return r;
      };
      const run = (ref.run = mk(h, ONE, { openSubagent }));
      const driven = drive(run);
      await sleep(5);
      letOpen.resolve();
      await sleep(15);
      await run.stop();
      await driven;
      const evs = run.getEvents();
      const stoppedAt = evs.findIndex((e) => e.type === 'run_stopped');
      expect(evs.slice(stoppedAt).filter((e) => e.type === 'turn_started'), `k=${k}`).toEqual([]);
      await run.close();
    }
  });

  it('2. close() wakes a step() asleep behind it', async () => {
    const h = m2harness('F2');
    const run = mk(h, ONE);
    await run.step();   // the split starts a
    const closing = run.close();
    const stepping = run.step();   // closing: nothing starts, step() sleeps
    await closing;
    expect(await within(stepping, 500)).not.toBe('timeout');
  });

  it('3. close() closes the session of a subagent step held on a track, and does not wait for the turn to end by itself', async () => {
    const h = m2harness('F3');
    const hold = h.hold(subOf('F3', 'subagent-1'));
    const run = mk(h, '## split\nnext: subagent-1\n\n## end\n\n## subagent\nmodel: m1\n> Look.\n\n## end');
    const driven = drive(run);
    await hold.started;
    const t = run.tracks.get('subagent-1')!;
    expect(t.session).toBeUndefined();   // the subagent's session is the turn's, not the track's own
    const r = await within(run.close(), 1000);
    expect(r).toBeUndefined();
    expect(h.stats(subOf('F3', 'subagent-1')).closed).toBeGreaterThanOrEqual(1);
    expect(t.state).toBe('running');   // a detach does not pause the track
    expect(named(run, 'run_paused')).toEqual([]);
    void driven;
  });

  it('4. close() waits for a track that is ending and still closing its session', async () => {
    const h = m2harness('F4');
    const closeStarted = deferred(), letClose = deferred();
    const openSubagent = async (o: SubagentOpen) => {
      const r = await h.openSubagent(o);
      return { ...r, session: { ...r.session, close: async () => { closeStarted.resolve(); await letClose.promise; await r.session.close(); } } };
    };
    const run = mk(h, ONE, { openSubagent });
    drive(run);
    await closeStarted.promise;   // the track ran its turn and its END, and is closing its session
    expect(run.tracks.size).toBe(0);
    const closing = run.close();
    expect(await within(closing, 100)).toBe('timeout');
    letClose.resolve();
    expect(await within(closing, 1000)).toBeUndefined();
  });

  it('5. close() waits for a main-line instruction started on the old no-track path', async () => {
    const h = m2harness('F5');
    const started = deferred(), release = deferred<{ exitCode: number; stdout: string; stderr: string }>();
    const run = mk(h, '## run echo hi\n\n## end', { commandRunner: () => { started.resolve(); return release.promise; } });
    const stepping = run.step();
    await started.promise;
    const closing = run.close();
    expect(await within(closing, 100)).toBe('timeout');
    release.resolve({ exitCode: 0, stdout: 'hi', stderr: '' });
    expect(await within(closing, 1000)).toBeUndefined();
    await stepping;
  });

  it('6. a track throw while the main line is paused still pauses that track and closes its session', async () => {
    const h = m2harness('F6');
    const hA = h.hold(subOf('F6', 'a'));
    const run = mk(h, ONE);
    const driven = drive(run);
    await hA.started;
    (run as unknown as { pauseForStop(t: Track, text: string): void }).pauseForStop(run.main, 'pause');   // the parked main line is paused (not by a stop card: that card now interrupts the track turns too, Task 11)
    expect(run.status).toBe('paused');
    hA.fail(new Error('boom'));
    await until(() => run.tracks.get('a')?.state === 'paused');
    const a = run.tracks.get('a')!;
    expect(a.pause).toEqual({ type: 'stop', stepId: 'a', text: 'Split split-1 failed: boom; Resume tries again' });
    expect(named(run, 'run_paused').filter((e) => e.data.track === 'a')).toHaveLength(1);
    expect(run.status).toBe('paused');
    expect(run.pauseReason).toEqual({ type: 'stop', text: 'pause' });
    expect(h.stats(subOf('F6', 'a')).closed).toBe(1);
    await driven;
    await run.close();
  });
});
