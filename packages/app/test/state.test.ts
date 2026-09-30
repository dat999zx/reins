import { describe, it, expect } from 'vitest';
import type { LogRow } from '@reins/server/store.js';
import {
  afterOf, initial, loadSessions, mergeOutput, openQuestions, railGroups, reduce, takeRefill, title, type State,
} from '../src/state.js';

const S = 's1';
let seq = 0;
const row = (type: string, data: unknown = {}, o: { runId?: string; ts?: number; sessionId?: string; seq?: number } = {}): LogRow => ({
  sessionId: o.sessionId ?? S, seq: o.seq ?? ++seq, ts: o.ts ?? 1000 + seq, type, data, ...(o.runId ? { runId: o.runId } : {}),
});
const fold = (rows: LogRow[], loadedAt = 0, from: State = initial()) => rows.reduce((st, r) => reduce(st, r, loadedAt), from);
const eng = (data: object, o = {}) => row('engine', data, o);
const created = (extra: object = {}) => row('session_created', { id: S, cwd: 'D:\\p\\one', engine: 'claude', autoApprove: false, ...extra });

describe('reduce', () => {
  it('creates a session from its session_created row', () => {
    seq = 0;
    const s = fold([created()]).sessions[S]!;
    expect(s.cwd).toBe('D:\\p\\one');
    expect(s.status).toBe('idle');
    expect(s.rows).toHaveLength(1);
  });

  it('dedupes by (sessionId, seq) and keeps rows in seq order', () => {
    seq = 0;
    const a = row('message', { text: 'a' });
    const b = row('message', { text: 'b' });
    const s = fold([a, b, a, b, a]).sessions[S]!;
    expect(s.rows.map((r) => r.seq)).toEqual([1, 2]);
    const other = row('message', { text: 'x' }, { sessionId: 's2', seq: 1 });
    expect(fold([a, other]).sessions.s2!.rows).toHaveLength(1);
  });

  it('takes the status from the last status row, else from /api/state', () => {
    seq = 0;
    const st = loadSessions(initial(), [{ id: S, cwd: 'c', autoApprove: false, status: 'running' }]);
    expect(st.sessions[S]!.status).toBe('running');
    const s = fold([row('status', { status: 'waiting' }), row('status', { status: 'idle' })], 0, st).sessions[S]!;
    expect(s.status).toBe('idle');
  });

  it('tracks open questions across question, answer and question_closed', () => {
    seq = 0;
    const q = (id: string) => row('question', { id, kind: 'gate', prompt: 'p' });
    const s = fold([q('a'), q('b'), q('c'), row('answer', { questionId: 'a', answer: 'approve' }), row('question_closed', { questionId: 'b', why: 'the turn ended' })]).sessions[S]!;
    expect(openQuestions(s).map((r) => (r.data as { id: string }).id)).toEqual(['c']);
    expect(s.answers.a).toBe('approve');
    expect(s.closed.b).toBe('the turn ended');
  });

  it('marks a run detached until any later row carries its run_id', () => {
    seq = 0;
    const run = (rows: LogRow[]) => fold(rows).sessions[S]!.detached;
    expect(run([row('run_started', {}, { runId: 'r1' }), row('run_detached', {}, { runId: 'r1' })])).toEqual(['r1']);
    expect(run([row('run_started', {}, { runId: 'r1' }), row('run_detached', {}, { runId: 'r1' }), row('note', { text: 'Resumed' }, { runId: 'r1' })])).toEqual([]);
    expect(run([row('run_started', {}, { runId: 'r1' }), row('run_finished', {}, { runId: 'r1' })])).toEqual([]);
    expect(run([row('run_detached', {}, { runId: 'r1' }), row('run_detached', {}, { runId: 'r2' }), row('note', {}, { runId: 'r1' })])).toEqual(['r2']);
    expect(run([row('run_detached', {}, { runId: 'r1' }), row('message', { text: 'no run id' })])).toEqual(['r1']);
  });

  it('titles a session: explicit, else the first message cut to 60, else New chat', () => {
    seq = 0;
    expect(title(fold([created()]).sessions[S]!)).toBe('New chat');
    const long = 'x'.repeat(80);
    const withMsg = fold([created(), row('message', { text: long }), row('message', { text: 'second' })]).sessions[S]!;
    expect(title(withMsg)).toBe('x'.repeat(60));
    expect(title(fold([created({ title: 'named' }), row('message', { text: 'hi' })]).sessions[S]!)).toBe('named');
    expect(title(reduce({ sessions: { [S]: withMsg } }, row('settings', { title: 'renamed' }), 0).sessions[S]!)).toBe('renamed');
  });

  it('settings rows update autoApprove', () => {
    seq = 0;
    expect(fold([created(), row('settings', { autoApprove: true })]).sessions[S]!.autoApprove).toBe(true);
  });

  it('keeps lastTs and sums the cost of turn_ended rows, plain and run', () => {
    seq = 0;
    const s = fold([
      row('turn_ended', { text: 'a', cost: 0.25 }, { ts: 5 }), row('turn_ended', { step: 'x', cost: 0.5 }, { ts: 9, runId: 'r' }), row('turn_ended', { text: 'no cost' }, { ts: 7 }),
    ]).sessions[S]!;
    expect(s.cost).toBeCloseTo(0.75);
    expect(s.lastTs).toBe(7);
  });

  it('sets refill only for a cards_unsent at or after the load time', () => {
    seq = 0;
    const old = fold([row('cards_unsent', { cards: ['a'] }, { ts: 99 })], 100).sessions[S]!;
    expect(old.refill).toBeUndefined();
    const fresh = fold([row('cards_unsent', { cards: ['a', 'b'] }, { ts: 100 })], 100).sessions[S]!;
    expect(fresh.refill).toBe('a\n\nb');
  });

  it('takeRefill hands the refill to an empty box only', () => {
    seq = 0;
    const st = fold([row('cards_unsent', { cards: ['a'] }, { ts: 5 })], 0);
    expect(takeRefill(st, S, 'typed')).toEqual({ state: st, text: 'typed' });
    const r = takeRefill(st, S, '');
    expect(r.text).toBe('a');
    expect(r.state.sessions[S]!.refill).toBeUndefined();
  });
});

describe('tool pairing', () => {
  const call = (tool: string, o = {}) => eng({ type: 'tool_call', tool, input: { f: 1 } }, o);
  const result = (tool: string, output: unknown = 'ok') => eng({ type: 'tool_result', tool, output });
  const refusal = (reason: string) => eng({ type: 'refusal', reason });

  it('lands a result on the second Edit after a refusal took the first', () => {
    seq = 0;
    const c1 = call('Edit');
    const r1 = refusal('read-only');
    const c2 = call('Edit');
    const s = fold([c1, r1, c2, result('Edit', 'done')]).sessions[S]!;
    expect(s.calls[c1.seq]).toEqual({ refused: 'read-only' });
    expect(s.calls[c2.seq]).toEqual({ result: 'done' });
  });

  it('matches a result by tool, so a sub-agent result stays off the parent Task', () => {
    seq = 0;
    const task = call('Task');
    const read = call('Read');
    const s = fold([task, read, result('Read', 'file'), result('Task', 'summary')]).sessions[S]!;
    expect(s.calls[read.seq]).toEqual({ result: 'file' });
    expect(s.calls[task.seq]).toEqual({ result: 'summary' });
  });

  it('gives a result to the oldest open call with that tool', () => {
    seq = 0;
    const a = call('Read');
    const b = call('Read');
    const s = fold([a, b, result('Read', 'first')]).sessions[S]!;
    expect(s.calls[a.seq]).toEqual({ result: 'first' });
    expect(s.calls[b.seq]).toBeUndefined();
  });

  it('drops a result with no open call, and open calls at turn_ended or turn_failed', () => {
    seq = 0;
    const orphan = result('Read', 'orphan');
    const a = call('Read');
    const s = fold([orphan, a, row('turn_ended', {}), result('Read', 'late')]).sessions[S]!;
    expect(s.rows).toHaveLength(4);
    expect(s.calls).toEqual({});
    const b = call('Bash');
    expect(fold([b, row('turn_failed', { error: 'x' }), result('Bash')]).sessions[S]!.calls).toEqual({});
  });
});

describe('selectors', () => {
  it('afterOf lists the last seq of every session', () => {
    seq = 0;
    const st = fold([row('message', {}), row('message', {}, { sessionId: 's2', seq: 7 })]);
    expect(afterOf(st)).toBe('s1:1,s2:7');
    expect(afterOf(initial())).toBe('');
  });

  it('mergeOutput joins consecutive command_output rows of one run', () => {
    seq = 0;
    const rows = [
      row('command_output', { chunk: 'a' }, { runId: 'r' }), row('command_output', { chunk: 'b' }, { runId: 'r' }),
      row('say', { text: 's' }, { runId: 'r' }), row('command_output', { chunk: 'c' }, { runId: 'r' }), row('command_output', { chunk: 'd' }, { runId: 'q' }),
    ];
    const out = mergeOutput(rows);
    expect(out.map((r) => r.type)).toEqual(['command_output', 'say', 'command_output', 'command_output']);
    expect((out[0]!.data as { chunk: string }).chunk).toBe('ab');
    expect(rows[0]!.data).toEqual({ chunk: 'a' });
  });

  it('groups the rail by folder: waiting first, groups and sessions newest first', () => {
    seq = 0;
    const mk = (id: string, cwd: string, ts: number, status?: string) => [
      row('session_created', { id, cwd, engine: 'claude', autoApprove: false }, { sessionId: id, seq: 1, ts }),
      ...(status ? [row('status', { status }, { sessionId: id, seq: 2, ts })] : []),
    ];
    const st = fold([...mk('a', 'D:\\p\\one', 10), ...mk('b', 'D:\\p\\two', 30), ...mk('c', '/x/one', 20), ...mk('d', 'D:\\p\\one', 40, 'waiting')]);
    const g = railGroups(st);
    expect(g.waiting.map((s) => s.id)).toEqual(['d']);
    expect(g.groups.map((x) => x.name)).toEqual(['two', 'one', 'one']);
    expect(g.groups.map((x) => x.cwd)).toEqual(['D:\\p\\two', '/x/one', 'D:\\p\\one']);
    expect(g.groups[2]!.sessions.map((s) => s.id)).toEqual(['a']);
  });
});
