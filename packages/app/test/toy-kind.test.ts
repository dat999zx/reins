// M1 acceptance, app half: the toy block's view needs one registerView call and no edit under packages/*/src.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Step, Workflow, Receipt } from '@reins/core';
import type { LogRow } from '@reins/server/store.js';
import { BlocksPane } from '../src/BlocksPane.js';
import { KINDS, registerView } from '../src/canvasKinds.js';
import { applyField } from '../src/panelEdit.js';
import { receiptFields } from '../src/rows/receipt.js';
import { renderRow, rowTypes } from '../src/rows.js';
import { initial, reduce } from '../src/state.js';
import { beepView } from '../../core/test/fixtures/beep.js';

const disposers: Array<() => void> = [];
afterEach(() => { for (const d of disposers.splice(0).reverse()) d(); });

const step = { id: 'beep-1', kind: 'beep', attrs: { times: '2' }, cards: [], links: [] } as unknown as Step;
const face = () => renderToStaticMarkup(createElement(BlocksPane, {
  w: { name: 't', budget: { turns: 10, minutes: 30 }, always: [], steps: [step] } as unknown as Workflow, steps: [{ id: step.id }], diags: [], text: '',
  sel: new Set<string>(), rev: 0, at: { x: 0, y: 0 }, models: [], sessionModel: { id: 'm', label: 'M' }, efforts: [], sessionEffort: { id: 'e', label: 'E' },
  onEdit: () => true, onSelect: () => {},
} as never));
const row = (type: string, data: unknown = {}) => ({ sessionId: 's', seq: 1, ts: 1, type, data }) as LogRow;

describe('a toy block view: one registerView call', () => {
  beforeEach(() => { disposers.push(registerView(beepView)); });

  it('KINDS lists it after the built-ins', () => {
    const keys = Object.keys(KINDS);
    // a real kind added later may sit after the toy (order 150 vs 140), so look at the kinds up to the toy's order
    expect(keys.filter((k) => KINDS[k as keyof typeof KINDS].order! <= beepView.order).at(-1)).toBe('beep');
    expect(KINDS.beep!.order).toBe(beepView.order);
    expect(keys.indexOf('beep')).toBeGreaterThan(keys.indexOf('use'));
  });

  it('the face draws its tokens', () => {
    const html = face();
    expect(html).toContain('data-kind="beep"');
    expect(html).toContain('beep');
    expect(html).toContain('2');
  });

  it('the field is checked', () => {
    const s = { ...step, attrs: {} } as unknown as Step;
    expect(applyField(s, 'times', 'x')).toBe(false);
    expect(applyField(s, 'times', '3')).toBe(true);
    expect(s.attrs.times).toBe('3');
  });

  it('the receipt shows the count last', () => {
    const base = {
      workflow: 'w', status: 'done', totalTurns: 3, totalTimeMs: 12_400, totalCostUsd: 0.5, gatesHeld: 0, guardRefusals: 0, readOnlyRefusals: 0,
      totalRefusals: 0, loopAttempts: 0, autoCardsFired: 0, liveCardsDelivered: 0, verifyResults: { passed: 0, failed: 0 },
      knowlRecalls: 0, knowlStores: 0, knowlSkipped: 0,
    } satisfies Receipt;
    expect(receiptFields({ ...base, counts: { beeps: 1 } }).at(-1)).toEqual(['beeps', '1']);
  });

  it('the feed row draws through BlockRow', () => {
    expect(rowTypes()).toContain('beeped');
    const ctx = { sess: reduce(initial(), row('note'), 0).sessions.s!, act: { answer: async () => {}, resume: () => {} } };
    expect(renderToStaticMarkup(renderRow(row('beeped', { step: 'beep-1', times: 2 }), ctx) as never)).toContain('beeped x2');
  });

  it('after the disposer every surface forgets it', () => {
    disposers.pop()!();
    expect('beep' in KINDS).toBe(false);
    expect(rowTypes()).not.toContain('beeped');
  });
});
