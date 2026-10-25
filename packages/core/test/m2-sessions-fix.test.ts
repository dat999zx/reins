// M2 task 10a, fix round (docs/plan/m2-codex-10a-review.md): a track with no slice has NO slice, never the main one; a restored track slice is checked.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { validate } from '../src/validate.js';
import { Run, type RunOptions, type RunSnapshot, type Track } from '../src/run.js';
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
type Harness = ReturnType<typeof m2harness>;
const mk = (h: Harness, body: string, opts: Partial<RunOptions> = {}) =>
  new Run({ workflow: wf(body), engine: h.engine, openSubagent: h.openSubagent, now: h.now, ...opts });
const subOf = (s: string, key: string) => `${s}-sub-${key}`;
const BODY = '## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## end\n\n## subagent research\nmodel: m1\n> Look.\n\n## end';

type Inner = { program: Array<{ op: string; step?: string }>; openSlice?: unknown; usdSpent: Record<string, number>; stepTrack(t: Track): Promise<unknown>; guardUsd(t: Track, r: unknown): boolean };
const inner = (run: Run) => run as unknown as Inner;
const exhaustedMain = (run: Run) => { inner(run).openSlice = { step: 'main', usd: 1 }; inner(run).usdSpent = { main: 1 }; };
const trackAt = (run: Run, step: string): Track => {
  const at = inner(run).program.findIndex((i) => i.step === step);
  expect(at).toBeGreaterThan(-1);
  const t: Track = { key: 'x', title: 'x', parent: '', group: '', pc: at, state: 'running', turnInFlight: false, capped: false, handback: [], policy: { mode: 'write', guards: [], allowShell: true }, recall: [] };
  run.tracks.set('x', t);
  return t;
};

describe('a track with no open slice has no slice', () => {
  it('its next instruction does not pause on the main line\'s used-up slice', async () => {
    const h = m2harness('U1');
    const run = mk(h, BODY);
    exhaustedMain(run);
    const t = trackAt(run, 'a');
    await inner(run).stepTrack(t);
    expect(run.pauseReason).toBeUndefined();
    expect(run.status).toBe('running');
    expect(h.stats(subOf('U1', 'x')).texts).toHaveLength(1);   // the track's turn was sent
    await run.close();
  });

  it('guardUsd for the track does not see the main slice', () => {
    const run = mk(m2harness('U2'), BODY);
    exhaustedMain(run);
    const t = trackAt(run, 'a');
    expect(inner(run).guardUsd(t, { text: '', isError: true })).toBe(false);
    expect(run.status).toBe('running');
  });

  it('a subagent step on the track does not pause on the main slice either', async () => {
    const h = m2harness('U3');
    const run = mk(h, BODY);
    exhaustedMain(run);
    const t = trackAt(run, 'subagent-1');
    await inner(run).stepTrack(t);
    expect(run.pauseReason).toBeUndefined();
    expect(h.subagentOpens.map((o) => o.step)).toEqual(['subagent-1']);
    await run.close();
  });

  it('the main line still pauses on its own slice', async () => {
    const run = mk(m2harness('U4'), BODY);
    exhaustedMain(run);
    await inner(run).stepTrack(run.main);
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', stepId: 'main' });
    await run.close();
  });
});

describe('a restored track slice is checked', () => {
  const held = async () => {
    const h = m2harness('R1');
    const hold = h.hold(subOf('R1', 'a'));
    const run = mk(h, '## model claude-x\nusd: 0.40\n\n## split\nnext: a\n\n## end\n\n## phase a\n> a\n\n## end');
    const driven = (async () => { for (let k = 0; k < 20 && run.status === 'running'; k++) await run.step(); })();
    await hold.started;
    const snap = JSON.parse(JSON.stringify(run.snapshot())) as RunSnapshot;
    hold.release();
    await driven;
    await run.close();
    return { h, snap };
  };
  const restore = (h: Harness, snap: RunSnapshot) => Run.restore(snap, { engine: h.engine, openSubagent: h.openSubagent, now: h.now });

  it('refuses NaN, a text number, a negative amount and a step that is not text', async () => {
    const { h, snap } = await held();
    for (const bad of [{ step: 's', usd: NaN }, { step: 's', usd: 'NaN' }, { step: 's', usd: -1 }, { step: 0, usd: 1 }, 'x', null, []]) {
      const s = structuredClone(snap);
      s.tracks![0]!.openSlice = bad as never;
      expect(() => restore(h, s), JSON.stringify(bad)).toThrow(/saved run is inconsistent: /);
    }
  });

  it('restores a valid slice, including 0', async () => {
    const { h, snap } = await held();
    const s = structuredClone(snap);
    s.tracks![0]!.openSlice = { step: 's', usd: 0 };
    delete s.tracks![0]!.spendKey;   // a slice the track opened itself has no inherited spend key (a key must match its slice, see the 10b fix)
    const back = restore(h, s);
    expect(back.tracks.get('a')!.openSlice).toEqual({ step: 's', usd: 0 });
    await back.close();
  });
});
