import { describe, expect, it } from 'vitest';
import { parseWorkflow, type Workflow } from '@reins/core';
import { allKeys, boxSelect, neighbour, nestedKeys, readingOrder, stepIds, stepKey, toggle, withoutNested } from '../src/selection.js';

const TEXT = `---
reins: 1
name: demo
budget: { turns: 10, minutes: 30 }
always: []
---

## phase plan

## repeat
id: r
until: tests pass
max: 3

### phase fix

## phase ship
`;
const w: Workflow = parseWorkflow(TEXT).workflow!;

describe('keys', () => {
  it('a step key round trips, and other keys are not step ids', () => {
    expect(stepKey('plan')).toBe('s:plan');
    expect(stepIds(['s:plan', 'l:l1', 'k:plan/0', 's:r'])).toEqual(['plan', 'r']);
  });
});

describe('toggle', () => {
  it('adds a missing key and removes a present one, on a copy', () => {
    const a = new Set(['s:plan']);
    expect([...toggle(a, 's:ship')]).toEqual(['s:plan', 's:ship']);
    expect([...toggle(a, 's:plan')]).toEqual([]);
    expect([...a]).toEqual(['s:plan']);
  });
});

describe('boxSelect', () => {
  const rects = [
    { key: 's:a', r: { x: 10, y: 10, w: 50, h: 20 } },
    { key: 's:b', r: { x: 10, y: 40, w: 50, h: 20 } },
    { key: 's:c', r: { x: 10, y: 70, w: 50, h: 20 } },
  ];
  it('takes the blocks fully inside the box', () => {
    expect([...boxSelect(rects, { x: 0, y: 0, w: 100, h: 65 })]).toEqual(['s:a', 's:b']);
  });
  it('does not take a block the box only touches', () => {
    expect([...boxSelect(rects, { x: 0, y: 0, w: 100, h: 50 })]).toEqual(['s:a']);
    expect([...boxSelect(rects, { x: 200, y: 0, w: 10, h: 10 })]).toEqual([]);
  });
});

describe('withoutNested', () => {
  it('drops a step whose ancestor is selected too', () => {
    expect([...withoutNested(w, new Set(['s:r', 's:fix', 's:ship']))].sort()).toEqual(['s:r', 's:ship']);
  });
  it('keeps a lone child, and keys that are not steps', () => {
    expect([...withoutNested(w, new Set(['s:fix', 'l:l1']))].sort()).toEqual(['l:l1', 's:fix']);
  });
});

describe('allKeys', () => {
  it('is every top-level step, then the loose blocks; nested steps are not listed', () => {
    expect([...allKeys(w)]).toEqual(['s:plan', 's:r', 's:ship']);
    expect([...allKeys(w, ['l1', 'l2'])]).toEqual(['s:plan', 's:r', 's:ship', 'l:l1', 'l:l2']);
  });
});

const WITH_END = TEXT.replace('## phase ship\n', '## phase ship\n\n## end\n\n## phase fixup\n\n## phase later\n');
const e = parseWorkflow(WITH_END).workflow!;

describe('readingOrder', () => {
  it('is the stack top to bottom including nested steps, the cap, then the free blocks in list order', () => {
    expect(readingOrder(e)).toEqual(['s:plan', 's:r', 's:fix', 's:ship', 's:end-1', 's:fixup', 's:later']);
  });
  it('lists the loose blocks last, top-left first (by y, then x)', () => {
    const loose = [{ key: 'a', at: { x: 50, y: 10 } }, { key: 'b', at: { x: 5, y: 10 } }, { key: 'c', at: { x: 90, y: 0 } }];
    expect(readingOrder(w, loose)).toEqual(['s:plan', 's:r', 's:fix', 's:ship', 'l:c', 'l:b', 'l:a']);
  });
  it('is only the loose blocks for an empty script, and does not mutate its input', () => {
    const loose = [{ key: 'a', at: { x: 1, y: 1 } }, { key: 'b', at: { x: 0, y: 0 } }];
    expect(readingOrder({ ...w, steps: [] }, loose)).toEqual(['l:b', 'l:a']);
    expect(loose.map((l) => l.key)).toEqual(['a', 'b']);
  });
});

describe('nestedKeys', () => {
  it('is every step below a selected step', () => {
    expect([...nestedKeys(w, new Set(['s:r', 's:ship']))]).toEqual(['s:fix']);
  });
});

describe('neighbour', () => {
  const order = ['s:a', 's:b', 's:c', 'l:x'];
  it('is the next block after the deleted ones', () => {
    expect(neighbour(order, new Set(['s:b']))).toBe('s:c');
    expect(neighbour(order, new Set(['s:a', 's:b']))).toBe('s:c');
  });
  it('is the previous block when nothing follows', () => {
    expect(neighbour(order, new Set(['s:c', 'l:x']))).toBe('s:b');
  });
  it('is nothing when everything goes', () => {
    expect(neighbour(order, new Set(order))).toBeUndefined();
  });
});