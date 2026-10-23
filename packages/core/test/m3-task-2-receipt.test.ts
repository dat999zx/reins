// M3 Task 2: the receipt's fixed fields for the kinds' events, recorded at HEAD before `receipt()` stopped naming those events
// (a kind's `count` hook now returns the fixed field's name). The same events must give the same numbers.
import { describe, it, expect } from 'vitest';
import { receipt, register, type NodeType, type RunEventRecord } from '../src/index.js';

declare module '../src/model.js' {
  interface NodeKinds { tally: true }
}
declare module '../src/compile.js' {
  interface Instrs { TALLY: { step: string } }
}
declare module '../src/run.js' {
  interface RunEvents { tallied: unknown; tallied_more: unknown }
}

let n = 0;
const ev = (type: string, data?: unknown): RunEventRecord => ({ id: String(++n), timestamp: 1000 + n, type: type as RunEventRecord['type'], data: data as never });

const KIND_EVENTS = [
  ev('run_started', { workflow: 'w' }),
  ev('gate_paused', { step: 'g' }), ev('gate_paused'), ev('gate_paused', { step: 'g2' }),
  ev('loop_iteration', { step: 'r', attempts: 1 }), ev('loop_iteration'),
  ev('verify_result', { pass: true }), ev('verify_result', { pass: false }), ev('verify_result', {}), ev('verify_result'), ev('verify_result', { pass: 'yes' }), ev('verify_result', { pass: 0 }),
  ev('recall', { topics: ['a'], context: [] }), ev('recall', { skipped: 'no recall function' }), ev('recall'), ev('recall', { skipped: '' }), ev('recall', { skipped: 1 }),
  ev('store', { what: 'x', summary: 's' }), ev('store', { what: 'x', skipped: 'no store function' }), ev('store'), ev('store', { skipped: 0 }),
  ev('loop_budget_exceeded', { step: 'r' }), ev('model_switched', { step: 'm', how: 'switched' }),
  ev('run_finished'),
];

describe('M3 Task 2: the receipt\'s fixed fields from the kinds\' events', () => {
  it('counts every variant of the moved events as before', () => {
    const r = receipt(KIND_EVENTS);
    expect({ g: r.gatesHeld, l: r.loopAttempts, v: r.verifyResults, kr: r.knowlRecalls, ks: r.knowlStores, sk: r.knowlSkipped, c: r.counts, status: r.status }).toEqual({
      g: 3, l: 2, v: { passed: 2, failed: 4 }, kr: 3, ks: 3, sk: 3, c: undefined, status: 'done',
    });
  });

  it('the whole receipt of those events is unchanged', () => {
    expect(receipt(KIND_EVENTS)).toMatchInlineSnapshot(`
      {
        "autoCardsFired": 0,
        "gatesHeld": 3,
        "guardRefusals": 0,
        "knowlRecalls": 3,
        "knowlSkipped": 3,
        "knowlStores": 3,
        "liveCardsDelivered": 0,
        "loopAttempts": 2,
        "readOnlyRefusals": 0,
        "status": "done",
        "totalCostUsd": 0,
        "totalRefusals": 0,
        "totalTimeMs": 23,
        "totalTurns": 0,
        "verifyResults": {
          "failed": 4,
          "passed": 2,
        },
        "workflow": "w",
      }
    `);
  });
});

// A block that is not built in counts into the fixed fields by returning their names, and into `counts` by any other name.
describe('M3 Task 2: a kind\'s count hook may name a fixed field', () => {
  const tally: NodeType = {
    kind: 'tally', attrs: [],
    compile(step, ctx) { ctx.push({ op: 'TALLY', step: step.id }); },
    ops: { TALLY: { async exec(_i, vm) { vm.next(); } } },
    count: {
      tallied: (d) => (d?.fixed ? d.fixed : 'tallies'),
      tallied_more: () => 'more',
    },
  };
  it('a fixed name feeds its field; any other name goes to counts', () => {
    const off = register(tally);
    try {
      const r = receipt([
        ev('tallied', { fixed: 'gatesHeld' }), ev('tallied', { fixed: 'loopAttempts' }), ev('tallied', { fixed: 'verifyResults.passed' }), ev('tallied', { fixed: 'verifyResults.failed' }),
        ev('tallied', { fixed: 'knowlRecalls' }), ev('tallied', { fixed: 'knowlStores' }), ev('tallied', { fixed: 'knowlSkipped' }), ev('tallied', { fixed: 'knowlSkipped' }),
        ev('tallied', {}), ev('tallied_more', {}), ev('tallied', { fixed: 'totalTurns' }), ev('tallied', { fixed: 'constructor' }),
      ]);
      expect({ g: r.gatesHeld, l: r.loopAttempts, v: r.verifyResults, kr: r.knowlRecalls, ks: r.knowlStores, sk: r.knowlSkipped, turns: r.totalTurns, c: r.counts }).toEqual({
        g: 1, l: 1, v: { passed: 1, failed: 1 }, kr: 1, ks: 1, sk: 2, turns: 0, c: { tallies: 1, more: 1, totalTurns: 1, constructor: 1 },
      });
    } finally {
      off();
    }
  });
});
