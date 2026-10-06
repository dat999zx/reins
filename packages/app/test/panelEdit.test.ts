import { describe, expect, it } from 'vitest';
import { parseWorkflow, printWorkflow } from '@reins/core';
import { editStep } from '../src/canvas.js';
import { applyField, applyLinkMax, fieldValue } from '../src/panelEdit.js';

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
    for (const bad of ['', '0', '-2', '1.5', 'x']) expect(r(bad)).toBe('3');
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
