import { describe, it, expect } from 'vitest';
import type { LogRow } from '@reins/server/store.js';
import { initial, reduceAll } from '../src/state.js';
import { PHASE, didNotStart, firstRowOf, meter, runView, sameSteps, stepPos, thinkingHeads, type RunPhase } from '../src/runState.js';
import { parseWorkflow } from '@reins/core';
import { runRows, stepStatus } from '../src/stepStatus.js';

let seq = 0;
const row = (type: string, data?: unknown, runId = 'r1'): LogRow => ({
  sessionId: 's1', seq: ++seq, ts: 1000 + seq * 1000, type, data, ...(runId ? { runId } : {}),
});
const plain = (type: string, data?: unknown): LogRow => row(type, data, '');
const status = (s: string) => plain('status', { status: s });
const ss = (step: string, parents: string[] = []) => row('step_started', { step, kind: 'phase', parents });
const started = (steps: object[] = [{ id: 'plan', kind: 'phase' }, { id: 'gate-1', kind: 'gate' }]) => row('run_started', { workflow: 'wf', steps });
const text = (t: string) => row('engine', { type: 'text', text: t });
const sess = (rows: LogRow[]) => reduceAll(initial(), rows, 0).sessions.s1!;
const view = (rows: LogRow[]) => runView(sess(rows));
const ask = (id: string, kind: string, runId = 'r1') => row('question', { id, kind, prompt: 'p' }, runId);
const reset = () => { seq = 0; };

describe('dock facts', () => {
  it('latest line includes say and turn failures', () => {
    reset();
    expect(view([started(), text('agent'), row('say', { text: 'budget used' })]).last?.text).toBe('budget used');
    expect(view([started(), row('turn_failed', { error: 'engine died' })]).last?.text).toBe('engine died');
  });
  const w = parseWorkflow('---\nreins: 1\nname: demo\nbudget: { turns: 40, minutes: 30, usd: 4 }\nalways: []\n---\n\n## phase plan\n> Plan.\n\n## repeat\nid: loop\nuntil: tests pass\nmax: 2\n\n### phase build\n> Build.\n\n## use demo\nid: use-1\n\n## end\n').workflow!;
  it('counts top-level headers, including containers, use and end', () => {
    expect(stepPos(w, ['plan'])).toEqual({ n: 1, m: 4 });
    expect(stepPos(w, ['loop', 'build'])).toEqual({ n: 2, m: 4 });
    expect(stepPos(w, ['build'])).toEqual({ n: 2, m: 4 });
    expect(stepPos(w, ['use-1', 'blk/plan'])).toEqual({ n: 3, m: 4 });
    expect(stepPos(w, ['missing'])).toBeUndefined();
    expect(stepPos(w, [])).toBeUndefined();
  });
  it.each([[31, 'ok'], [32, 'near'], [40, 'over']] as const)('turn meter at %i', (turns, level) => {
    const v = view([started()]); v.turns = turns;
    expect(meter(v, w.budget, 0)[0]).toMatchObject({ key: 'turns', level, enforced: true });
    expect(meter(v, w.budget, 0)[0]!.text).toContain(`${turns} / 40 turns`);
  });
  it('near says so in words for turns, minutes and money, not by colour alone', () => {
    const v = view([started()]); v.startedAt = 0; v.turns = 32; v.cost = 3.2;
    const items = meter(v, w.budget, 24 * 60_000);
    expect(items.map((i) => i.level)).toEqual(['near', 'near', 'near']);
    for (const i of items) expect(i.text).toMatch(/ · near$/);
    v.turns = 1; v.cost = 0;
    for (const i of meter(v, w.budget, 60_000)) expect(i.text).not.toContain('near');
  });
  it('minutes and money report unenforced limits; ended time freezes; absent usd stays absent', () => {
    const v = view([started()]); v.startedAt = 0; v.cost = 5;
    const items = meter(v, w.budget, 31 * 60_000);
    for (const item of items.slice(1)) expect(item).toMatchObject({ level: 'over', enforced: false, text: expect.stringContaining('over (not enforced)') });
    v.endedTs = 60_000;
    expect(meter(v, { turns: 40, minutes: 30 }, 31 * 60_000)).toEqual([
      { key: 'turns', text: '0 / 40 turns', level: 'ok', enforced: true },
      { key: 'minutes', text: '1m 00s / 30m', level: 'ok', enforced: false },
    ]);
  });
  it('does not report a refused start before a busy-to-idle transition', () => {
    reset(); const before = status('idle');
    expect(didNotStart([before], before.seq)).toBeUndefined();
    const working = status('running');
    expect(didNotStart([before, working], before.seq)).toBeUndefined();
    const note = plain('note', { text: 'The workflow is not trusted, so it did not run.' });
    const idle = status('idle');
    expect(didNotStart([before, working, note, idle], before.seq)).toBe('The workflow is not trusted, so it did not run.');
    expect(didNotStart([before, working, started(), note, idle], before.seq)).toBeUndefined();
    expect(didNotStart([before, working, idle], before.seq)).toBe('The run did not start.');
  });
});

describe('runView phase', () => {
  it('none: no rows with a run, idle', () => {
    reset();
    expect(view([status('idle')]).phase).toBe('none');
  });

  it('busy: a workflow trust question carries no run id and there is no run (and a plain turn)', () => {
    reset();
    expect(view([status('running'), ask('q1', 'trust', ''), status('waiting')]).phase).toBe('busy');
    expect(view([plain('message', { role: 'user', text: 'hi' }), status('running')]).phase).toBe('busy');
  });

  it('busy: a trust question after a finished run is the next work, not the old run', () => {
    reset();
    const old = [started(), ss('plan'), row('run_finished'), row('receipt', { workflow: 'wf' })];
    expect(view([...old, status('running'), ask('q2', 'trust', ''), status('waiting')]).phase).toBe('busy');
  });

  it('a just-finished run whose session is still winding down reads done, not busy', () => {
    reset();
    expect(view([started(), ss('plan'), status('running'), row('run_finished'), row('receipt', { workflow: 'wf' })]).phase).toBe('done');
  });

  it('running: newest run live, session running', () => {
    reset();
    expect(view([status('running'), started(), ss('plan')]).phase).toBe('running');
  });

  it('waiting: an open gate question', () => {
    reset();
    const v = view([status('running'), started(), ss('gate-1'), row('gate_paused', { step: 'gate-1' }), ask('q1', 'gate'), status('waiting')]);
    expect(v.phase).toBe('waiting');
    expect(v.open.map((r) => (r.data as { kind: string }).kind)).toEqual(['gate']);
  });

  it('waiting: the folder trust question inside a run carries the run id (N6)', () => {
    reset();
    expect(view([status('running'), started(), ask('q1', 'trust'), status('waiting')]).phase).toBe('waiting');
  });

  it('done, stopped, paused, failed', () => {
    reset();
    expect(view([started(), ss('plan'), row('run_finished'), row('receipt', {})]).phase).toBe('done');
    reset();
    expect(view([started(), ss('plan'), row('run_stopped')]).phase).toBe('stopped');
    reset();
    expect(view([started(), ss('plan'), row('run_detached', {})]).phase).toBe('paused');
    reset();
    const f = view([started(), ss('build'), row('run_detached', { error: 'x' })]);
    expect(f.phase).toBe('failed');
    expect(f.error).toBe('x');
  });

  it('a resumed run is live again and has no error', () => {
    reset();
    const v = view([started(), ss('plan'), row('run_detached', { error: 'x' }), row('note', { text: 'Resumed run r1.' }), status('running')]);
    expect(v.phase).toBe('running');
    expect(v.live).toBe(true);
    expect(v.error).toBeUndefined();
  });

  it('failed, resumed, then left paused cleanly is paused with no old error', () => {
    reset();
    const v = view([started(), ss('plan'), row('run_detached', { error: 'x' }), row('note', { text: 'Resumed run r1.' }), status('running'), ss('plan'), row('run_detached', {}), status('idle')]);
    expect(v.phase).toBe('paused');
    expect(v.error).toBeUndefined();
    reset();
    const done = view([started(), ss('plan'), row('run_detached', { error: 'x' }), row('note', { text: 'Resumed run r1.' }), ss('plan'), row('run_finished'), row('receipt', {})]);
    expect(done.phase).toBe('done');
    expect(done.error).toBeUndefined();
  });

  it('PHASE.ended and .resumable per spec 4.1', () => {
    const ended: Record<RunPhase, [boolean, boolean]> = {
      none: [false, false], busy: [false, false], running: [false, false], waiting: [false, false],
      done: [true, false], stopped: [true, false], paused: [true, true], failed: [true, true],
    };
    for (const [p, [e, r]] of Object.entries(ended)) {
      expect([p, PHASE[p as RunPhase].ended, PHASE[p as RunPhase].resumable]).toEqual([p, e, r]);
    }
  });

  it('PHASE.words gives spec 4.1 words without a position', () => {
    reset();
    const running = view([status('running'), started(), ss('build')]);
    expect(PHASE.running.words(running)).toBe('Running `build`');
    expect(PHASE.running.words(running, { n: 2, m: 4 })).toBe('Running `build` · step 2 of 4');
    reset();
    const waiting = view([status('running'), started(), ss('gate-1'), ask('q1', 'gate'), status('waiting')]);
    expect(PHASE.waiting.words(waiting)).toBe('Waiting for you · gate question');
    reset();
    const done = view([
      started(), ss('plan'), row('turn_ended', { step: 'plan', cost: 0.1 }), row('turn_ended', { step: 'plan', cost: 0.1 }),
      row('turn_ended', { step: 'plan', cost: 0.0564 }), row('turn_ended', { step: 'plan', cost: 0.1 }), row('run_finished'),
    ]);
    expect(PHASE.done.words(done)).toMatch(/^Done · 4 turns · \d+s · \$0\.3564$/);
    reset();
    const stopped = view([started(), ss('build'), row('turn_ended', { step: 'build', cost: 0.1282 }), row('run_stopped')]);
    expect(PHASE.stopped.words(stopped)).toMatch(/^Stopped at `build` · 1 turn · \d+s · \$0\.1282$/);
    reset();
    expect(PHASE.paused.words(view([started(), ss('gate-1'), row('run_detached', {})]))).toBe('Left paused at `gate-1`. Resume continues it.');
    reset();
    expect(PHASE.failed.words(view([started(), ss('build'), row('run_detached', { error: 'x' })]))).toBe('Failed at `build`: x');
    expect(PHASE.busy.words(view([status('running')]))).toBe('The agent is working (not a workflow run).');
  });
});

describe('runView fold', () => {
  it('stepsAtStart comes from run_started.steps (title kept); undefined for an older run_started', () => {
    reset();
    expect(view([started([{ id: 'plan', kind: 'phase', title: 'plan' }, { id: 'gate-1', kind: 'gate' }])]).stepsAtStart)
      .toEqual([{ id: 'plan', kind: 'phase', title: 'plan' }, { id: 'gate-1', kind: 'gate' }]);
    reset();
    expect(view([row('run_started', { workflow: 'wf' })]).stepsAtStart).toBeUndefined();
  });

  it('current is [...parents, step]; v1 is the turn step; [] after the end; endedAt is the innermost current', () => {
    reset();
    expect(view([started(), ss('loop'), ss('inner', ['loop'])]).current).toEqual(['loop', 'inner']);
    reset();
    expect(view([started(), row('turn_started', { step: 'old' })]).current).toEqual(['old']);
    reset();
    const done = view([started(), ss('loop'), ss('inner', ['loop']), row('run_stopped')]);
    expect(done.current).toEqual([]);
    expect(done.endedAt).toBe('inner');
    reset();
    expect(view([started(), ss('a'), row('run_finished')]).current).toEqual([]);
  });

  it('a turn on the step that just started does not change the path; endedAt clears when the run goes on', () => {
    reset();
    expect(view([started(), ss('loop'), ss('inner', ['loop']), row('turn_started', { step: 'inner' })]).current).toEqual(['loop', 'inner']);
    reset();
    const v = view([started(), ss('a'), row('run_detached', {}), row('note', {}), ss('a')]);
    expect(v.endedAt).toBeUndefined();
  });

  it('went: consecutive started steps, equal neighbours merged (a, b, b, c -> a>b, b>c)', () => {
    reset();
    expect(view([started(), ss('a'), ss('b'), ss('b'), ss('c')]).went).toEqual([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]);
  });

  it('stepOf: the newest run only; v2 attributes rows after step_started', () => {
    reset();
    const older = [row('run_started', { workflow: 'wf' }, 'r0'), row('step_started', { step: 'old', parents: [] }, 'r0'), row('say', { text: 'x' }, 'r0'), row('run_finished', {}, 'r0')];
    const rows = [started(), ss('run-1'), row('command_output', { chunk: 'o' }), ss('b'), text('hi')];
    const all = [...older, ...rows];
    const v = view(all);
    const out = [...v.stepOf.entries()].map(([sq, id]) => [all.find((r) => r.seq === sq)!.type, id]);
    expect(out).toEqual([['step_started', 'run-1'], ['command_output', 'run-1'], ['step_started', 'b'], ['engine', 'b']]);
    for (const r of older) expect(v.stepOf.has(r.seq)).toBe(false);
  });

  it('stepOf v1: only inside turns, not a say after turn_ended', () => {
    reset();
    const rows = [started(), row('turn_started', { step: 'a' }), text('t'), row('turn_ended', { step: 'a' }), row('say', { text: 'after' })];
    const v = view(rows);
    expect(rows.map((r) => v.stepOf.get(r.seq))).toEqual([undefined, 'a', 'a', 'a', undefined]);
  });

  it('a gate_paused sets the step; a run end clears it', () => {
    reset();
    const rows = [started(), ss('g'), row('gate_paused', { step: 'g' }), ask('q', 'gate'), row('run_finished'), row('receipt', {})];
    const v = view(rows);
    expect(rows.map((r) => v.stepOf.get(r.seq))).toEqual([undefined, 'g', 'g', 'g', undefined, undefined]);
    reset();
    const old = [started(), row('gate_paused', { step: 'g' })];
    expect(view(old).current).toEqual(['g']);
  });
});

describe('runView cards', () => {
  const queued = (card: string, kind = 'steer', source = 'live') => row('card_queued', { card, kind, source });

  it('queued, then delivered by an engine card_delivered; auto and stop are not listed', () => {
    reset();
    const v = view([started(), queued('a'), queued('b', 'now'), queued('c', 'stop'), queued('auto', 'steer', 'auto'), row('engine', { type: 'card_delivered', card: 'a', channel: 'mid-turn' })]);
    expect(v.cards).toEqual([{ text: 'a', kind: 'steer', state: 'delivered' }, { text: 'b', kind: 'now', state: 'queued' }]);
  });

  it('delivered by a card_delivered row; equal texts are first in first out', () => {
    reset();
    const v = view([started(), queued('x'), queued('x'), row('card_delivered', { card: 'x', channel: 'next-turn' }), row('card_delivered', { card: 'zzz', channel: 'next-turn' })]);
    expect(v.cards.map((c) => c.state)).toEqual(['delivered', 'queued']);
  });

  it('cards_unsent without a run id after the receipt marks the card not sent', () => {
    reset();
    const v = view([started(), queued('z'), row('receipt', {}), plain('cards_unsent', { cards: ['z'] })]);
    expect(v.cards).toEqual([{ text: 'z', kind: 'steer', state: 'unsent' }]);
  });

  it('cards_unsent after the next run_started is not matched to the old run', () => {
    reset();
    const v = view([started(), queued('z'), row('receipt', {}), row('run_started', { workflow: 'wf' }, 'r2'), plain('cards_unsent', { cards: ['z'] })]);
    expect(v.runId).toBe('r2');
    expect(v.cards).toEqual([]);
  });

  it('cards_unsent before the run ends is not matched', () => {
    reset();
    expect(view([started(), queued('z'), plain('cards_unsent', { cards: ['z'] })]).cards[0]!.state).toBe('queued');
  });
});

describe('runView facts', () => {
  it('last, turns, cost, startedAt, endedTs, receipt', () => {
    reset();
    const rows = [
      started(), ss('plan'), text('first'), row('turn_ended', { step: 'plan', cost: 0.25 }), ss('build'), text('second'),
      row('turn_ended', { step: 'build', cost: 0.5 }), row('run_finished'), row('receipt', { workflow: 'wf', status: 'done' }),
    ];
    const v = view(rows);
    expect(v.last).toEqual({ seq: rows[5]!.seq, text: 'second' });
    expect(v.turns).toBe(2);
    expect(v.cost).toBeCloseTo(0.75);
    expect(v.startedAt).toBe(rows[0]!.ts);
    expect(v.endedTs).toBe(rows[7]!.ts);
    expect(v.receipt).toEqual({ workflow: 'wf', status: 'done' });
  });

  it('endedTs is unset while the run is live', () => {
    reset();
    expect(view([started(), ss('plan')]).endedTs).toBeUndefined();
  });

  it('steps equals stepStatus of the newest run', () => {
    reset();
    const rows = [started(), ss('plan'), row('turn_ended', { step: 'plan', cost: 0.1 }), ss('gate-1'), row('gate_paused', { step: 'gate-1' })];
    expect(view(rows).steps).toEqual(stepStatus(runRows(rows).rows));
  });
});

describe('thinking', () => {
  const think = (tokens: number, runId = 'r1') => row('engine', { type: 'thinking', tokens }, runId);

  it('thinkingHeads: consecutive thinking rows are one burst whose last seq is the head; other engine rows split bursts', () => {
    reset();
    const a = think(50), b = think(317), c = think(575), t = text('hi'), d = think(700);
    expect([...thinkingHeads([started(), a, b, c, t, d])]).toEqual([c.seq, d.seq]);
    expect([...thinkingHeads([a, b, status('running'), c])]).toEqual([c.seq]);
    const tool = row('engine', { type: 'tool_result', tool: 'Read', output: '' });
    expect([...thinkingHeads([a, tool, b])]).toEqual([a.seq, b.seq]);
    expect([...thinkingHeads([think(5, 'r1'), think(6, 'r2')])]).toHaveLength(2);
    expect(thinkingHeads([]).size).toBe(0);
  });

  it('RunView.thinking is the head tokens only while it is the run newest engine row and the run is live', () => {
    reset();
    const live = [status('running'), started(), ss('plan'), think(50), think(317)];
    expect(view(live).thinking).toBe(317);
    expect(view([...live, text('answer')]).thinking).toBeUndefined();
    expect(view([...live, row('engine', { type: 'cost', usd: 1 })]).thinking).toBeUndefined();
    expect(view([...live, row('run_finished'), status('idle')]).thinking).toBeUndefined();
    expect(view([started(), ss('plan'), text('a')]).thinking).toBeUndefined();
  });

  it('PHASE.running.words adds the count only while thinking', () => {
    reset();
    const v = view([status('running'), started(), ss('plan'), think(1509)]);
    expect(PHASE.running.words(v)).toBe('Running `plan` · thinking… ~1,509 tokens');
    expect(PHASE.running.words(view([status('running'), started(), ss('plan')]))).toBe('Running `plan`');
  });
});

describe('sameSteps, firstRowOf', () => {
  const a = [{ id: 'plan', kind: 'phase' }, { id: 'run-1', kind: 'run' }];
  it('compares id and kind only', () => {
    expect(sameSteps(a, [{ id: 'plan', kind: 'phase' }, { id: 'run-1', kind: 'run' }])).toBe(true);
    expect(sameSteps(a, [...a, { id: 'ship', kind: 'phase' }])).toBe(false);
    expect(sameSteps(a, [{ id: 'plan', kind: 'phase' }, { id: 'run-1', kind: 'verify' }])).toBe(false);
    expect(sameSteps(a, [a[1]!, a[0]!])).toBe(false);
    expect(sameSteps(a, [{ id: 'plan', kind: 'phase', title: 't' } as { id: string; kind: string }, a[1]!])).toBe(true);
  });

  it('firstRowOf is the first row attributed to the step, and must be among the given rows', () => {
    reset();
    const rows = [started(), ss('a'), text('x'), ss('b'), text('y')];
    const v = view(rows);
    expect(firstRowOf(v, rows, 'b')).toBe(rows[3]!.seq);
    expect(firstRowOf(v, rows, 'zz')).toBeUndefined();
    expect(firstRowOf(v, rows.filter((r) => r.type !== 'step_started'), 'b')).toBe(rows[4]!.seq);
  });
});
