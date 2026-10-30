import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import type { LogRow } from '@reins/server/store.js';
import { Rail } from '../src/Rail.js';
import type { ParallelView } from '../src/parallel.js';
import { initial, reduceAll, type Sess, type State } from '../src/state.js';

const sess = (id: string, o: Partial<Sess> = {}): Sess => ({
  id, cwd: '/w', autoApprove: false, status: 'idle', rows: [], lastSeq: 1, lastTs: 1, cost: 0,
  open: [], answers: {}, closed: {}, detached: [], calls: {}, queue: [], explicitTitle: `title-${id}`, ...o,
});
const state: State = { sessions: { a: sess('a', { status: 'running' }) } };
const run = (o: Partial<ParallelView> = {}): ParallelView[] => [{ id: 'p1', title: 'Big run', createdAt: 1, tasks: [{ name: 'a', sessionId: 'a' }], ...o }];
const props = { state, selected: null, onSelect: () => {}, onNew: () => {}, onPlus: () => {}, onRename: () => {}, onSettings: () => {}, pathBox: null };

describe('auto-approve badge', () => {
  it('shows the line for a fence run and not otherwise', () => {
    expect(renderToStaticMarkup(createElement(Rail, { ...props, parallel: run({ approve: 'fence' }) }))).toContain('auto-approve: fence');
    expect(renderToStaticMarkup(createElement(Rail, { ...props, parallel: run() }))).not.toContain('auto-approve');
  });
});

describe('answered card', () => {
  const row = (seq: number, type: string, data: unknown): LogRow => ({ sessionId: 's1', seq, ts: seq, type, data });
  const answer = (extra: object) => reduceAll(initial(), [row(1, 'question', { id: 'q1' }), row(2, 'answer', { questionId: 'q1', answer: 'y', ...extra })], 0).sessions.s1!.answers.q1;
  it('marks an automatic answer', () => {
    expect(answer({ by: 'fence' })).toBe('y (auto: fence)');
    expect(answer({})).toBe('y');
  });
});
