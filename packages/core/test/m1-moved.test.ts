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
  ['store', 'STORE'],
  ['verify', 'VERIFY'],
  ['run', 'RUN'],
  ['repeat', 'LOOP_IN'],
  ['repeat', 'LOOP_BK'],
];

describe('moved ops', () => {
  for (const [kind, op] of moved) {
    it(`${op} is brought by ${kind}, not run.ts`, () => {
      expect(NODES.get(kind)?.ops).toHaveProperty(op);
      expect(runTs).not.toContain(`case '${op}'`);
    });
  }
});

describe('a LOOP_BK whose LOOP_IN is gone', () => {
  it('falls back to a max of 5: attempt 5 pauses with limit 5', async () => {
    const w = parseWorkflow(['---', 'reins: 1', 'name: t', 'budget: { turns: 40, minutes: 60 }', 'always: []', '---', '', '## repeat', 'until: llm says "ok"', 'max: 9', '', '### phase work', '> work', ''].join('\n')).workflow!;
    const h = harness('nomax', []);
    // the 5th judge is held; the edit swaps the repeat for a phase of the same id, so the live program has no LOOP_IN for it
    let calls = 0;
    const judge = async (c: Parameters<typeof h.judge>[0], e: Parameters<typeof h.judge>[1]) => (++calls === 5 ? h.judge(c, e) : false);
    const run = new Run({ workflow: w, engine: h.engine, now: h.now, judge, commandRunner: h.commandRunner });
    const hold = h.hold('judge');
    for (let k = 0; k < 60 && run.status === 'running'; k++) {
      const p = run.step();
      if ((await Promise.race([p.then(() => false), hold.started.then(() => true)]))) {
        const first = w.steps[0]!;
        run.edit({ ...w, steps: [{ ...first, kind: 'phase', kids: undefined, cond: undefined, attrs: {} }] });
        hold.release(false);
        await p;
        break;
      }
    }
    expect(run.pauseReason).toMatchObject({ type: 'budget-used', limit: 5 });
  });
});

describe('RECALL calls the host function with the Run as its receiver', () => {
  it('a function that reads `this` still gets the Run', async () => {
    const w = parseWorkflow(['---', 'reins: 1', 'name: t', 'budget: { turns: 5, minutes: 5 }', 'always: []', '---', '', '## recall', 'knowl: upload', ''].join('\n')).workflow!;
    const h = harness('recv', []);
    const seen: unknown[] = [];
    const run = new Run({ workflow: w, engine: h.engine, now: h.now, recall: async function (this: unknown) { seen.push(this); return ['ctx']; } });
    await run.step();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(run);
  });
});

describe('a STORE turn does not take the queued cards', () => {
  it('a steer card queued before a store step is still queued after it', async () => {
    const w = parseWorkflow(['---', 'reins: 1', 'name: t', 'budget: { turns: 5, minutes: 5 }', 'always: []', '---', '', '## store', 'knowl: decisions', ''].join('\n')).workflow!;
    const h = harness('cards', []);
    const run = new Run({ workflow: w, engine: h.engine, now: h.now });
    run.queueCard('keep me', 'steer');
    await run.step();
    expect(run.takeCards()).toEqual(['keep me']);
  });
});

describe('a VERIFY turn does not take the queued cards', () => {
  it('a steer card queued before a verify step is still queued after it', async () => {
    const w = parseWorkflow(['---', 'reins: 1', 'name: t', 'budget: { turns: 5, minutes: 5 }', 'always: []', '---', '', '## verify', ''].join('\n')).workflow!;
    const h = harness('cards', []);
    const run = new Run({ workflow: w, engine: h.engine, now: h.now });
    run.queueCard('keep me', 'steer');
    await run.step();
    expect(run.takeCards()).toEqual(['keep me']);
  });
});
