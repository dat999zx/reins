import { describe, it, expect } from 'vitest';
import { groupedIds, parallelGroups, taskState, type ParallelView } from '../src/parallel.js';
import { railGroups, type Sess, type State } from '../src/state.js';

const sess = (id: string, o: Partial<Sess> = {}): Sess => ({
  id, cwd: `/w/${id}`, autoApprove: false, status: 'idle', rows: [], lastSeq: 1, lastTs: 1, cost: 0,
  open: [], answers: {}, closed: {}, detached: [], calls: {}, queue: [], ...o,
});
const stateOf = (...list: Sess[]): State => ({ sessions: Object.fromEntries(list.map((s) => [s.id, s])) });
const run = (o: Partial<ParallelView> = {}): ParallelView => ({
  id: 'p1', title: 'T', createdAt: 1, tasks: [{ name: 'a', sessionId: 'a' }, { name: 'b', sessionId: 'b' }, { name: 'c', sessionId: 'c' }], ...o,
});

describe('app grouping of a parallel run', () => {
  it('sums the cost and flags the cap as reached', () => {
    const st = stateOf(sess('a', { cost: 2.4 }), sess('b', { cost: 1.5 }), sess('c', { cost: 1.1 }));
    const [g] = parallelGroups(st, [run({ capUsd: 5 })]);
    expect(g!.cost).toBeCloseTo(5.0);
    expect(g!.cap).toBe(5);
    expect(g!.over).toBe(true);
    expect(g!.costUnknown).toBe(false);
  });

  it('is not over under the cap or with no cap', () => {
    const st = stateOf(sess('a', { cost: 1 }), sess('b', { costUnknown: true }));
    expect(parallelGroups(st, [run({ capUsd: 5 })])[0]!.over).toBe(false);
    const g = parallelGroups(st, [run()])[0]!;
    expect(g.over).toBe(false);
    expect(g.cap).toBeUndefined();
    expect(g.costUnknown).toBe(true);
  });

  it('counts running, waiting, paused (idle with a detached run) and done', () => {
    const st = stateOf(sess('a', { status: 'running' }), sess('b', { status: 'waiting' }), sess('c', { detached: ['r1'] }), sess('d', { status: 'closed' }), sess('e'));
    expect(taskState(st.sessions.c!)).toBe('paused');
    expect(taskState(st.sessions.e!)).toBe('done');
    const r = run({ tasks: ['a', 'b', 'c', 'd', 'e'].map((n) => ({ name: n, sessionId: n })) });
    expect(parallelGroups(st, [r])[0]!.counts).toEqual({ running: 1, waiting: 1, paused: 1, done: 2 });
  });

  it('keeps task order, skips a missing session, lists newest run first', () => {
    const st = stateOf(sess('a'), sess('c'));
    const r1 = run({ tasks: [{ name: 'c', sessionId: 'c' }, { name: 'x', sessionId: 'x' }, { name: 'a', sessionId: 'a' }] });
    const r2 = run({ id: 'p2', createdAt: 9, tasks: [] });
    const gs = parallelGroups(st, [r1, r2]);
    expect(gs.map((g) => g.run.id)).toEqual(['p2', 'p1']);
    expect(gs[1]!.sessions.map((s) => s.id)).toEqual(['c', 'a']);
  });

  it('railGroups leaves grouped sessions out of folder groups and keeps a waiting one waiting', () => {
    const st = stateOf(sess('a', { cwd: '/w' }), sess('b', { cwd: '/w', status: 'waiting' }), sess('z', { cwd: '/w' }));
    const grouped = groupedIds([run({ tasks: [{ name: 'a', sessionId: 'a' }, { name: 'b', sessionId: 'b' }] })]);
    const r = railGroups(st, grouped);
    expect(r.groups.flatMap((g) => g.sessions.map((s) => s.id))).toEqual(['z']);
    expect(r.waiting.map((s) => s.id)).toEqual(['b']);
    expect(railGroups(st).groups[0]!.sessions).toHaveLength(2);
  });
});
