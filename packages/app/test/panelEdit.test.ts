import { describe, expect, it } from 'vitest';
import { parseWorkflow, printWorkflow } from '@reins/core';
import { editStep } from '../src/canvas.js';
import { applyField, applyLinkMax, BUDGET_ERRORS, budgetCount, budgetPatch, fieldValue, parseBudget } from '../src/panelEdit.js';

const TEXT = `---
reins: 1
name: demo
budget: { turns: 10, minutes: 30 }
always: []
---

## phase plan
mode: write
> Plan it.

## repeat
id: r
until: tests pass
max: 3

### run \`npm test\`
id: t
`;

const w = () => parseWorkflow(TEXT).workflow!;
const edit = (id: string, fn: Parameters<typeof editStep>[2]) => printWorkflow(editStep(w(), id, fn));

describe('panelEdit', () => {
  it('reads a field from the step or its attrs, empty when absent', () => {
    const plan = w().steps[0]!;
    expect(fieldValue(plan, 'title')).toBe('plan');
    expect(fieldValue(plan, 'prompt')).toBe('Plan it.');
    expect(fieldValue(plan, 'mode')).toBe('write');
    expect(fieldValue(plan, 'cmd')).toBe('');
  });

  it('writes title and prompt on the step; empty removes them', () => {
    expect(edit('plan', (s) => applyField(s, 'prompt', 'Do it.'))).toContain('> Do it.');
    expect(edit('plan', (s) => applyField(s, 'prompt', ''))).not.toContain('> Plan it.');
    expect(edit('plan', (s) => applyField(s, 'title', 'design'))).toContain('## phase design\nid: plan\n');
  });

  it('writes an attribute; empty removes it', () => {
    expect(edit('t', (s) => applyField(s, 'cmd', 'npm run lint'))).toContain('### run `npm run lint`');
    expect(edit('plan', (s) => applyField(s, 'mode', ''))).not.toContain('mode:');
  });

  it('writes max as a string; empty, zero, fractions and junk are not written', () => {
    const r = (v: string) => editStep(w(), 'r', (s) => applyField(s, 'max', v)).steps[1]!.attrs.max;
    expect(r('5')).toBe('5');
    for (const bad of ['', '0', '-2', '1.5', 'x', '99999999999999999999']) expect(r(bad)).toBe('3');
  });

  it('says whether a field value was taken; a refused one changes nothing', () => {
    const s = structuredClone(w().steps[1]!);
    expect(applyField(s, 'max', 'x')).toBe(false);
    expect(s).toEqual(w().steps[1]);
    expect(applyField(s, 'max', '5')).toBe(true);
    expect(applyField(s, 'title', 'x')).toBe(true);
  });

  it('editStep returns the same workflow when the edit is refused', () => {
    const m = w();
    expect(editStep(m, 'r', (s) => applyField(s, 'max', 'x'))).toBe(m);
    expect(editStep(m, 'r', () => false)).toBe(m);
    expect(editStep(m, 'r', () => undefined)).not.toBe(m);
  });

  it('sets a link max as a number; empty or below 1 removes it', () => {
    const l = { kind: 'next' as const, to: 'r', max: 3 };
    applyLinkMax(l, '4');
    expect(l.max).toBe(4);
    applyLinkMax(l, '');
    expect(l.max).toBeUndefined();
    const m = { kind: 'next' as const, to: 'r', max: 3 };
    applyLinkMax(m, '0');
    expect(m.max).toBeUndefined();
  });
});

describe('budgetPatch', () => {
  const none = { turns: '', minutes: '' };
  it('writes one field when the budget is already set', () => {
    expect(budgetPatch('usd', '3', { turns: 5, minutes: 20 }, none)).toEqual({ patch: { usd: 3 } });
    expect(budgetPatch('turns', '7', { turns: 5, minutes: 20 }, none)).toEqual({ patch: { turns: 7 } });
  });
  it('writes Turns and Minutes together while either is 0, once both are filled in', () => {
    expect(budgetPatch('turns', '5', { turns: 0, minutes: 0 }, { turns: '5', minutes: '20' })).toEqual({ patch: { turns: 5, minutes: 20 } });
    expect(budgetPatch('minutes', '20', { turns: 5, minutes: 0 }, { turns: '5', minutes: '20' })).toEqual({ patch: { minutes: 20, turns: 5 } });
  });
  it('asks for both, and writes nothing, while the other one is empty', () => {
    expect(budgetPatch('turns', '5', { turns: 0, minutes: 0 }, { turns: '5', minutes: '' })).toEqual({ error: 'Fill in both Turns and Minutes.' });
  });
  it('USD never waits for the pair', () => {
    expect(budgetPatch('usd', '3', { turns: 0, minutes: 0 }, none)).toEqual({ patch: { usd: 3 } });
  });
  it("judges the field's own text first", () => {
    expect(budgetPatch('turns', '0', { turns: 0, minutes: 0 }, { turns: '0', minutes: '20' })).toEqual({ error: 'Turns must be a whole number, 1 or more.' });
  });
  it('shows 0 as empty', () => {
    expect([budgetCount(0), budgetCount(12)]).toEqual(['', '12']);
  });
});

describe('parseBudget', () => {
  it('reads turns and minutes as whole numbers of 1 or more', () => {
    expect(parseBudget('turns', ' 12 ')).toEqual({ value: 12 });
    expect(parseBudget('minutes', '30')).toEqual({ value: 30 });
    for (const key of ['turns', 'minutes'] as const) {
      for (const raw of ['0', '1.5', '-1', '', 'x']) expect(parseBudget(key, raw)).toEqual({ error: BUDGET_ERRORS[key] });
    }
  });
  it('reads USD as an amount above 0 with up to two decimals, empty for none', () => {
    expect(parseBudget('usd', '')).toEqual({ value: undefined });
    expect(parseBudget('usd', '2.5')).toEqual({ value: 2.5 });
    expect(parseBudget('usd', '2.50')).toEqual({ value: 2.5 });
    expect(parseBudget('usd', '0.01')).toEqual({ value: 0.01 });
    for (const raw of ['0', '2.555', '-1', '1e3', '$2']) expect(parseBudget('usd', raw)).toEqual({ error: BUDGET_ERRORS.usd });
  });
  it('says it in plain words', () => {
    expect(BUDGET_ERRORS).toEqual({
      turns: 'Turns must be a whole number, 1 or more.',
      minutes: 'Minutes must be a whole number, 1 or more.',
      usd: 'USD must be an amount above 0, like 2.50. Leave it empty for no USD limit.',
    });
  });
});