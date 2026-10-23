import { describe, it, expect } from 'vitest';
import { NODES, CONDS, CARDS } from '../src/index.js';

// Recorded from HEAD 3cca0c1 before the registries got an order: the built-ins keep exactly this order.
// (m2-pins.test.ts Q14 pins the same lists and the ops of each kind in golden-m2/pin-q14-registry.json.)
describe('the built-in order is today\'s order', () => {
  it('kinds', () => {
    expect([...NODES.keys()]).toEqual(['phase', 'say', 'run', 'gate', 'repeat', 'if', 'verify', 'recall', 'store', 'model', 'subagent', 'end', 'fork', 'playbook']);
  });

  it('conditions', () => {
    expect([...CONDS.keys()]).toEqual(['approve', 'tests', 'cmd', 'llm', 'review', 'done', 'diff', 'touches', 'attempts', 'same', 'drift']);
  });

  it('cards', () => {
    expect([...CARDS.keys()]).toEqual(['guard', 'now', 'stop']);
  });

  it('a map key and the type it holds agree', () => {
    for (const [k, n] of NODES) expect(n.kind).toBe(k);
    for (const [k, c] of CONDS) expect(c.t).toBe(k);
    for (const [k, c] of CARDS) expect(c.kind).toBe(k);
  });
});
