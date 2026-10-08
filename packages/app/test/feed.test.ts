import { describe, it, expect } from 'vitest';
import type { LogRow } from '@reins/server/store.js';
import { initial, mergeOutput, reduceAll } from '../src/state.js';
import { runView } from '../src/runState.js';
import { feed, isOpen, knotLine, knotName, KNOT, ordinal, type Feed, type Knot, type Piece } from '../src/feed.js';
import { STATE_WORDS } from '../src/stepStatus.js';
import { hidden } from '../src/rows/hidden.js';

let seq = 0;
const row = (type: string, data?: unknown, runId = 'r1'): LogRow => ({
  sessionId: 's1', seq: ++seq, ts: 1000 * seq, type, data, ...(runId ? { runId } : {}),
});
const plain = (type: string, data?: unknown): LogRow => row(type, data, '');
const eng = (data: object, runId = '') => row('engine', data, runId);
const started = (steps: object[] = [{ id: 'plan', kind: 'phase', title: 'plan' }, { id: 'gate-1', kind: 'gate' }], runId = 'r1') =>
  row('run_started', { workflow: 'wf', steps }, runId);
const ss = (step: string, parents: string[] = [], runId = 'r1') => row('step_started', { step, parents }, runId);
const reset = () => { seq = 0; };

const run = (rows: LogRow[]): Feed => {
  const s = reduceAll(initial(), rows, 0).sessions.s1!;
  return feed(mergeOutput(s.rows), runView(s), new Set(s.open));
};
const strands = (f: Feed) => f.pieces.filter((p): p is Extract<Piece, { type: 'run' }> => p.type === 'run');
const knots = (p: Extract<Piece, { type: 'run' }>) => p.items.flatMap((i) => ('knot' in i ? [i.knot] : []));
const lone = (f: Feed) => { const s = strands(f); expect(s).toHaveLength(1); return s[0]!; };
const knot = (o: Partial<Knot> = {}): Knot => ({
  key: 'r1:1', type: 'step', title: 'plan', step: 'plan', depth: 0, pass: 1, state: 'done', asking: false, running: false,
  start: 0, end: 12_000, cost: 0.0641, tools: { count: 1, one: 'Read' }, beads: [], first: 1, ...o,
});

describe('feed: plain thread', () => {
  it('a message, text and a turn end make a note and a done turn with its cost', () => {
    reset();
    const f = run([plain('message', { role: 'user', text: 'hi' }), eng({ type: 'text', text: 'yo' }), plain('turn_ended', { cost: 0.0641 })]);
    expect(f.pieces.map((p) => p.type)).toEqual(['note', 'turn']);
    const t = f.pieces[1] as Extract<Piece, { type: 'turn' }>;
    expect(t.knot).toMatchObject({ type: 'turn', title: 'Turn 1', state: 'done', cost: 0.0641 });
    expect(t.knot.beads.map((r) => r.type)).toEqual(['engine']);
  });

  it('counts turns, and an engine row with no message before it opens one', () => {
    reset();
    const f = run([eng({ type: 'text', text: 'a' }), plain('turn_ended', {}), plain('message', { text: 'again' }), eng({ type: 'text', text: 'b' }), plain('turn_ended', {})]);
    expect(f.pieces.map((p) => p.type)).toEqual(['turn', 'note', 'turn']);
    expect(f.pieces.flatMap((p) => (p.type === 'turn' ? [p.knot.title] : []))).toEqual(['Turn 1', 'Turn 2']);
  });

  it('turn_failed closes the turn as failed with its reason, and is not a bead', () => {
    reset();
    const f = run([plain('message', { text: 'x' }), eng({ type: 'text', text: 'a' }), plain('turn_failed', { error: 'x' })]);
    const k = (f.pieces[1] as Extract<Piece, { type: 'turn' }>).knot;
    expect(k).toMatchObject({ state: 'failed', why: 'x' });
    expect(k.beads.map((r) => r.type)).toEqual(['engine']);
    expect(knotLine(k)).toBe('Turn 1 · failed (x)');
  });

  it('a question never opens a turn: loose with no open turn, a bead of the open turn otherwise', () => {
    reset();
    const lonely = run([plain('question', { id: 'q1', kind: 'trust', prompt: 'p' })]);
    expect(lonely.pieces.map((p) => p.type)).toEqual(['bead']);
    const inside = run([eng({ type: 'text', text: 'a' }), plain('question', { id: 'q2', kind: 'tool', prompt: 'p' }), plain('turn_ended', {})]);
    expect(inside.pieces.map((p) => p.type)).toEqual(['turn']);
    expect((inside.pieces[0] as Extract<Piece, { type: 'turn' }>).knot.beads.map((r) => r.type)).toEqual(['engine', 'question']);
  });

  it('a turn that never ended is closed when the next message or an idle status arrives', () => {
    reset();
    const f = run([eng({ type: 'text', text: 'a' }), plain('message', { text: 'later' })]);
    expect((f.pieces[0] as Extract<Piece, { type: 'turn' }>).knot.state).toBe('stopped');
    reset();
    const g = run([eng({ type: 'text', text: 'a' }), plain('status', { status: 'idle' })]);
    expect((g.pieces[0] as Extract<Piece, { type: 'turn' }>).knot.state).toBe('stopped');
    reset();
    const h = run([eng({ type: 'text', text: 'a' })]);
    expect((h.pieces[0] as Extract<Piece, { type: 'turn' }>).knot).toMatchObject({ state: 'running' });
    expect(h.now?.type).toBe('turn');
  });

  it('a tagged message, the workflow trust question, then run_started make [note, bead, run]', () => {
    reset();
    const f = run([plain('message', { text: 'go', tags: [{ tag: 'gate' }] }), plain('question', { id: 'q1', kind: 'trust', prompt: 'p' }), started(), ss('plan')]);
    expect(f.pieces.map((p) => p.type)).toEqual(['note', 'bead', 'run']);
  });
});

describe('feed: strands and knots', () => {
  it('opens knots in seq order; a failed command, a second pass and nesting', () => {
    reset();
    const f = run([
      started([{ id: 'plan', kind: 'phase', title: 'plan' }, { id: 'run-1', kind: 'run' }, { id: 'repeat-1', kind: 'repeat' }, { id: 'fix', kind: 'phase', title: 'fix' }]),
      ss('plan'), eng({ type: 'text', text: 'a' }, 'r1'),
      ss('run-1'), row('command_result', { step: 'run-1', exitCode: 1 }), row('say', { text: 's' }),
      ss('fix', ['repeat-1']), ss('run-1'),
    ]);
    const ks = knots(lone(f));
    expect(ks.map((k) => [k.step, k.pass, k.depth])).toEqual([['plan', 1, 0], ['run-1', 1, 0], ['fix', 1, 1], ['run-1', 2, 0]]);
    expect(ks[1]).toMatchObject({ state: 'failed', why: 'exit 1', title: 'run command' });
    expect(ks[1]!.beads.map((r) => r.type)).toEqual(['say']);
    expect(ks[3]!.state).toBe('running');
    expect(ks[0]!.beads.map((r) => r.type)).toEqual(['engine']);
  });

  it('an older log without step_started opens knots on turn_started and gate_paused', () => {
    reset();
    const f = run([row('run_started', { workflow: 'wf' }), row('turn_started', { step: 'a' }), row('turn_ended', { step: 'a', cost: 0.5 }), row('gate_paused', { step: 'g' }), row('gate_approved', {}), row('run_finished', {})]);
    const ks = knots(lone(f));
    expect(ks.map((k) => [k.step, k.state, k.cost])).toEqual([['a', 'done', 0.5], ['g', 'done', 0]]);
  });

  it('ROLE runs before drawable: a hidden command_result still fails its knot, in an older run too', () => {
    reset();
    expect(hidden.has('command_result')).toBe(true);
    const f = run([
      started([{ id: 'run-1', kind: 'run' }]), ss('run-1'), row('command_result', { step: 'run-1', exitCode: 2 }), row('run_finished', {}), row('receipt', { workflow: 'wf' }),
      started([{ id: 'plan', kind: 'phase' }], 'r2'), ss('plan', [], 'r2'),
    ]);
    const [older, newer] = strands(f);
    expect(knots(older!)[0]).toMatchObject({ state: 'failed', why: 'exit 2' });
    expect(older!.items.some((i) => 'row' in i && i.row.type === 'command_result')).toBe(false);
    expect(newer!.newest).toBe(true);
    expect(older!.newest).toBe(false);
  });

  it('resume: one strand for one run id, the detach is a bead in the middle, the knot counter continues', () => {
    reset();
    const f = run([
      started([{ id: 'a', kind: 'phase' }, { id: 'b', kind: 'phase' }]), ss('a'), row('run_detached', {}),
      row('note', { text: 'Resumed run r1.' }), ss('b'), row('run_finished', {}), row('receipt', { workflow: 'wf' }),
    ]);
    const s = lone(f);
    expect(s.items.map((i) => ('knot' in i ? `knot:${i.knot.key}:${i.knot.state}` : `row:${i.row.type}`))).toEqual(['knot:r1:1:done', 'row:run_detached', 'row:note', 'knot:r1:2:done']);
    expect(s.state).toBe('done');
    expect(s.end.map((r) => r.type)).toEqual(['receipt']);
  });

  it('resume, before the next event: the strand is live again and its last knot reads running, not left paused', () => {
    reset();
    const f = run([started([{ id: 'a', kind: 'phase' }]), ss('a'), row('run_detached', {}), row('note', { text: 'Resumed run r1.' })]);
    const s = lone(f);
    expect(s.state).toBe('live');
    expect(knots(s)[0]!.state).toBe('running');
    const parked = lone(run([started([{ id: 'a', kind: 'phase' }]), ss('a'), row('run_detached', {})]));
    expect(parked.state).toBe('paused');
    expect(knots(parked)[0]!.state).toBe('paused');
  });

  it('history: a stopped run keeps its open knot stopped after a newer run; a detach with an error keeps failed; a normal finish is done', () => {
    reset();
    const f = run([
      started([{ id: 'build', kind: 'phase' }]), ss('build'), row('run_stopped', {}), row('receipt', { workflow: 'wf' }),
      started([{ id: 'x', kind: 'phase' }], 'r2'), ss('x', [], 'r2'), row('run_detached', { error: 'boom' }, 'r2'),
      started([{ id: 'y', kind: 'phase' }], 'r3'), ss('y', [], 'r3'), row('run_finished', {}, 'r3'), row('receipt', { workflow: 'wf' }, 'r3'),
      started([{ id: 'z', kind: 'phase' }], 'r4'), ss('z', [], 'r4'),
    ]);
    const [r1, r2, r3, r4] = strands(f);
    expect(knots(r1!)[0]!.state).toBe('stopped');
    expect(r1!.state).toBe('stopped');
    expect(knots(r2!)[0]).toMatchObject({ state: 'failed', why: 'boom' });
    expect(knots(r3!)[0]!.state).toBe('done');
    expect(r4!.state).toBe('live');
  });

  it('loop_budget_exceeded marks the latest knot of the repeat, not the child', () => {
    reset();
    const f = run([
      started([{ id: 'repeat-1', kind: 'repeat' }, { id: 'fix', kind: 'phase' }]), ss('repeat-1'), ss('fix', ['repeat-1']),
      row('loop_budget_exceeded', { step: 'repeat-1', attempts: 3, max: 3 }), row('run_detached', {}),
    ]);
    const ks = knots(lone(f));
    expect(ks.find((k) => k.step === 'repeat-1')!.state).toBe('stuck');
    expect(ks.find((k) => k.step === 'fix')!.state).not.toBe('stuck');
  });

  it('only the innermost current step is running; containers read running without being the running knot', () => {
    reset();
    const f = run([
      started([{ id: 'repeat-1', kind: 'repeat' }, { id: 'fix', kind: 'phase' }]), ss('repeat-1'), ss('fix', ['repeat-1']), plain('status', { status: 'running' }),
    ]);
    const ks = knots(lone(f));
    expect(ks.map((k) => [k.step, k.state, k.running])).toEqual([['repeat-1', 'running', false], ['fix', 'running', true]]);
    expect(f.now).toBe(ks[1]);
  });

  it('questions land under the knot that asked; asking follows sess.open; isOpen obeys it', () => {
    reset();
    const asked = [started(), ss('plan'), ss('gate-1'), row('gate_paused', { step: 'gate-1' }), row('question', { id: 'q1', kind: 'gate', prompt: 'ok?' })];
    const f = run(asked);
    const ks = knots(lone(f));
    expect(ks[1]!.beads.map((r) => r.type)).toEqual(['question']);
    expect(ks[1]).toMatchObject({ asking: true, state: 'waiting' });
    expect(ks[0]!.asking).toBe(false);
    expect(isOpen(ks[1]!, false)).toBe(true);
    const answered = run([...asked, row('answer', { questionId: 'q1', answer: 'Approve' }), row('gate_approved', {})]);
    const k2 = knots(lone(answered))[1]!;
    expect(k2.asking).toBe(false);
    expect(isOpen(k2, false)).toBe(false);
    expect(isOpen(knots(lone(answered))[0]!, undefined)).toBe(false);
    expect(isOpen(knot({ type: 'turn', state: 'done' }), false)).toBe(true);
    expect(isOpen(knot({ state: 'failed' }), undefined)).toBe(true);
    expect(isOpen(knot({ state: 'done' }), true)).toBe(true);
  });
});

describe('feed: cards', () => {
  const card = 'End your answer with PINEAPPLE.';
  const queuedAt = (rows: LogRow[]) => rows.find((r) => r.type === 'card_queued')!.seq;

  it('a plain steer card delivered mid-turn: the delivery row is not a bead, the queued bead is in the turn', () => {
    reset();
    const rows = [
      plain('message', { text: 'read three files' }), eng({ type: 'tool_call', tool: 'Read', input: {} }),
      plain('card_queued', { card, kind: 'steer' }), eng({ type: 'card_delivered', card, channel: 'mid-turn' }),
      eng({ type: 'text', text: 'done' }), plain('turn_ended', { cost: 0.01 }),
    ];
    const f = run(rows);
    expect(f.cards.get(queuedAt(rows))).toEqual({ state: 'mid-turn' });
    const t = (f.pieces[1] as Extract<Piece, { type: 'turn' }>).knot;
    expect(t.beads.map((r) => r.type === 'engine' ? (r.data as { type: string }).type : r.type)).toEqual(['tool_call', 'card_queued', 'text']);
  });

  it('a card queued then a turn end then a message from your cards is "next-turn"; an interrupt row; cards_unsent', () => {
    reset();
    const a = [eng({ type: 'text', text: 'a' }), plain('card_queued', { card, kind: 'steer' }), plain('turn_ended', {}), plain('message', { text: `${card}\n\nother`, fromCards: true })];
    expect(run(a).cards.get(queuedAt(a))).toEqual({ state: 'next-turn' });
    reset();
    const b = [eng({ type: 'text', text: 'a' }), plain('card_queued', { card, kind: 'now' }), plain('card_delivered', { card, kind: 'now', channel: 'interrupt' })];
    expect(run(b).cards.get(queuedAt(b))).toEqual({ state: 'interrupt' });
    reset();
    const c = [eng({ type: 'text', text: 'a' }), plain('card_queued', { card, kind: 'steer' }), plain('turn_failed', { error: 'x' }), plain('cards_unsent', { cards: [card] })];
    expect(run(c).cards.get(queuedAt(c))).toEqual({ state: 'unsent' });
  });

  it('a run card delivered by an engine row while build is current lands in build; stop and auto cards get no state', () => {
    reset();
    const rows = [
      started([{ id: 'build', kind: 'phase' }]), ss('build'),
      row('card_queued', { card, kind: 'steer' }), row('card_queued', { card: 'halt', kind: 'stop' }), row('card_queued', { card: 'auto one', kind: 'steer', source: 'auto' }),
      row('engine', { type: 'card_delivered', card, channel: 'mid-turn' }),
    ];
    const f = run(rows);
    const [q, stop, auto] = rows.filter((r) => r.type === 'card_queued').map((r) => r.seq);
    expect(f.cards.get(q!)).toEqual({ state: 'mid-turn', landed: 'build' });
    expect(f.cards.has(stop!)).toBe(false);
    expect(f.cards.has(auto!)).toBe(false);
  });
});

describe('feed: words', () => {
  it('knotLine', () => {
    expect(knotLine(knot())).toBe('plan · done in 12 s · $0.0641 · used Read');
    expect(knotLine(knot({ tools: { count: 4 } }))).toBe('plan · done in 12 s · $0.0641 · used 4 tools');
    expect(knotLine(knot({ title: 'run command', step: 'run-1', state: 'failed', why: 'exit 1', end: 2000, cost: 0, tools: { count: 0 } }))).toBe('run command · failed (exit 1) · 2 s');
    expect(knotLine(knot({ end: 65_000, cost: 0, tools: { count: 0 }, state: 'failed' }))).toBe('plan · failed · 1m 05s');
    expect(knotLine(knot({ pass: 2 }))).toBe('plan · done in 12 s · $0.0641 · used Read · 2nd time');
    expect(knotLine(knot({ state: 'running', end: undefined, cost: 0, tools: { count: 0 } }))).toBe('plan · running');
    expect(knotLine(knot({ type: 'turn', title: 'Turn 1', step: undefined, cost: 0.0641 }))).toBe('Turn 1 · done · $0.0641');
  });

  it('knotName carries the id when the title differs, the earlier-run suffix, and is unique inside a strand', () => {
    expect(knotName(knot(), false)).toBe('Step plan · done in 12 s · $0.0641 · used Read');
    expect(knotName(knot({ title: 'wait until', step: 'gate-1', end: 2000, cost: 0, tools: { count: 0 } }), false)).toBe('Step wait until (gate-1) · done · 2 s');
    expect(knotName(knot(), true)).toBe('Step plan · done in 12 s · $0.0641 · used Read (earlier run)');
    reset();
    const f = run([
      started([{ id: 'gate-1', kind: 'gate' }, { id: 'gate-2', kind: 'gate' }, { id: 'run-1', kind: 'run' }]),
      ss('gate-1'), ss('gate-2'), ss('run-1'), ss('run-1'), row('run_finished', {}),
    ]);
    const names = knots(lone(f)).map((k) => knotName(k, false));
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toMatch(/^Step wait until \(gate-1\) · done/);
    expect(names[3]).toMatch(/2nd time$/);
  });

  it('ordinal', () => {
    expect([2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual(['2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th']);
  });

  it('title falls back to the kind label, then the id', () => {
    reset();
    const f = run([started([{ id: 'run-1', kind: 'run' }, { id: 'x', kind: 'nope' }]), ss('run-1'), ss('x'), ss('blk/y', ['use-1']), row('run_finished', {})]);
    expect(knots(lone(f)).map((k) => k.title)).toEqual(['run command', 'x', 'blk/y']);
    expect(knots(lone(f))[2]!.kind).toBeUndefined();
  });

  it('KNOT words come from STATE_WORDS, and only done starts closed', () => {
    expect(KNOT.running.words).toBe(STATE_WORDS.active);
    expect(KNOT.waiting.words).toBe('waiting for you');
    expect(KNOT.stuck.words).toBe('out of attempts');
    expect(Object.entries(KNOT).filter(([, v]) => !v.open).map(([k]) => k)).toEqual(['done']);
  });
});

describe('feed: 500 rows', () => {
  it('walks a 500-row log, keeps the last row, and reports the time', () => {
    reset();
    const rows: LogRow[] = [];
    for (let t = 0; t < 20; t++) {
      rows.push(plain('message', { text: `m${t}` }));
      for (let i = 0; i < 11; i++) rows.push(eng(i % 2 ? { type: 'tool_result', tool: 'Read', output: 'x' } : { type: 'tool_call', tool: 'Read', input: {} }));
      rows.push(eng({ type: 'text', text: t === 19 ? 'LAST-500' : 't' }), plain('turn_ended', { cost: 0.01 }));
    }
    rows.push(started(Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, kind: 'phase' }))));
    for (let i = 0; i < 6; i++) rows.push(ss(`s${i}`), eng({ type: 'text', text: `step ${i}` }, 'r1'), row('turn_ended', { step: `s${i}`, cost: 0.1 }));
    while (rows.length < 495) rows.push(row('say', { text: 'pad' }));
    rows.push(row('run_finished', {}), row('receipt', { workflow: 'wf' }));
    const t0 = performance.now();
    const f = run(rows);
    const ms = performance.now() - t0;
    console.info(`feed(${rows.length} rows) took ${ms.toFixed(1)} ms`);
    expect(f.pieces.filter((p) => p.type === 'turn')).toHaveLength(20);
    expect(knots(lone(f))).toHaveLength(6);
    const last = (f.pieces.filter((p) => p.type === 'turn').at(-1) as Extract<Piece, { type: 'turn' }>).knot.beads.at(-1)!;
    expect((last.data as { text: string }).text).toBe('LAST-500');
    expect(ms).toBeLessThan(2000);
  });
});
