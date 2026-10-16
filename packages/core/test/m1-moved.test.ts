import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { NODES, Run, parseWorkflow } from '../src/index.js';
import { harness } from './m1-harness.js';

// Each moved op lives on its kind's node and has no `case` left in run.ts. Tasks 12 to 15 add rows.
const runTs = readFileSync(new URL('../src/run.ts', import.meta.url), 'utf8');
const moved: Array<[kind: string, op: string]> = [
  ['recall', 'RECALL'],
  ['if', 'IF'],
  ['gate', 'GATE'],
];

describe('moved ops', () => {
  for (const [kind, op] of moved) {
    it(`${op} is brought by ${kind}, not run.ts`, () => {
      expect(NODES.get(kind)?.ops).toHaveProperty(op);
      expect(runTs).not.toContain(`case '${op}'`);
    });
  }
});

describe('RECALL calls the host function with the Run as its receiver', () => {
  it('a function that reads `this` still gets the Run', async () => {
    const w = parseWorkflow(['---', 'reins: 1', 'name: t', 'budget: { turns: 5, minutes: 5 }', 'always: []', '---', '', '## recall', 'knowl: upload', ''].join('\n')).workflow!;
    const h = harness('recv', []);
    let seen: unknown;
    const run = new Run({ workflow: w, engine: h.engine, now: h.now, recall: async function (this: unknown) { seen = this; return ['ctx']; } });
    await run.step();
    expect(seen).toBe(run);
  });
});
