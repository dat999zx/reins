import { describe, it, expect } from 'vitest';
import type { LogRow } from '@reins/server/store.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { drawable, hidden, renderRow, rowTypes } from '../src/rows.js';
import { engineEvents } from '../src/rows/engine.js';
import { initial, reduce } from '../src/state.js';

const row = (type: string, data: unknown = {}): LogRow => ({ sessionId: 's', seq: 1, ts: 1, type, data });
const sess = reduce(initial(), row('note'), 0).sessions.s!;
const ctx = { sess, act: { answer: async () => {}, resume: () => {} } };
const text = (n: unknown) => renderToStaticMarkup(n as never).replace(/<[^>]+>/g, '');

describe('row registry', () => {
  it('collects one renderer per file in rows/', () => {
    for (const t of ['message', 'engine', 'question', 'receipt', 'run_started', 'say', 'step_started']) expect(rowTypes()).toContain(t);
  });

  it('draws a step start as a divider and hides command_result', () => {
    expect(JSON.stringify(renderRow(row('step_started', { step: 'plan', parents: [] }), ctx))).toMatch(/sx-stepdiv.*"step ","plan"/);
    expect(hidden.has('command_result')).toBe(true);
    expect(renderRow(row('command_result', { step: 'run-1', exitCode: 1 }), ctx)).toBeNull();
  });

  it('draws a type with no file through the generic renderer, naming the type', () => {
    const el = renderRow(row('some_new_run_event', { a: 1 }), ctx) as { props: { children: unknown } };
    expect(el).not.toBeNull();
    expect(JSON.stringify(el.props)).toContain('some new run event');
  });

  it('draws nothing for hidden types', () => {
    for (const t of ['status', 'settings', 'session_created', 'answer', 'question_closed']) {
      expect(hidden.has(t)).toBe(true);
      expect(renderRow(row(t), ctx)).toBeNull();
    }
  });

  it('never lists a hidden type as a renderer file', () => {
    for (const t of hidden) expect(rowTypes()).not.toContain(t);
  });

  it('keeps hook and cost engine events hidden, and draws an unknown engine event generically', () => {
    expect(renderRow(row('engine', { type: 'hook', event: 'x', decision: 'allow' }), ctx)).toBeNull();
    expect(renderRow(row('engine', { type: 'cost', usd: 1 }), ctx)).toBeNull();
    expect(engineEvents.has('text')).toBe(true);
    expect(renderRow(row('engine', { type: 'brand_new' }), ctx)).not.toBeNull();
  });
});
describe('drawable and card words', () => {
  it('drawable is false for every hidden type and the silent engine events, true for engine text', () => {
    for (const t of hidden) expect(drawable(row(t))).toBe(false);
    for (const t of ['tool_result', 'hook', 'cost']) expect(drawable(row('engine', { type: t }))).toBe(false);
    expect(drawable(row('engine', { type: 'text', text: 'x' }))).toBe(true);
    expect(drawable(row('note', { text: 'x' }))).toBe(true);
  });

  it('renderRow returns null exactly when drawable is false', () => {
    const rows = [row('status'), row('command_result'), row('engine', { type: 'tool_result' }), row('engine', { type: 'hook' }), row('engine', { type: 'cost' }),
      row('engine', { type: 'text', text: 'x' }), row('note', { text: 'x' }), row('some_new_run_event', {}), row('engine', { type: 'brand_new' })];
    for (const r of rows) expect(renderRow(r, ctx) === null).toBe(!drawable(r));
  });

  it('a queued card says what happened to it, and only its text without a state', () => {
    const q = row('card_queued', { card: 'x', kind: 'steer' });
    expect(text(renderRow(q, { ...ctx, card: new Map([[q.seq, { state: 'mid-turn' as const }]]) }))).toBe('steer card x · card delivered (mid-turn)');
    expect(text(renderRow(q, { ...ctx, card: new Map([[q.seq, { state: 'mid-turn' as const, landed: 'build' }]]) }))).toBe('steer card x · card delivered (mid-turn) · in build');
    expect(text(renderRow(q, ctx))).toBe('steer card x');
    expect(text(renderRow(q, { ...ctx, card: new Map([[q.seq, { state: 'bogus' as never }]]) }))).toBe('steer card x');
  });
});