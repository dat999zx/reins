import { describe, it, expect } from 'vitest';
import type { LogRow } from '@reins/server/store.js';
import { hidden, renderRow, rowTypes } from '../src/rows.js';
import { engineEvents } from '../src/rows/engine.js';
import { initial, reduce } from '../src/state.js';

const row = (type: string, data: unknown = {}): LogRow => ({ sessionId: 's', seq: 1, ts: 1, type, data });
const sess = reduce(initial(), row('note'), 0).sessions.s!;
const ctx = { sess, act: { answer: async () => {}, resume: () => {} } };

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
