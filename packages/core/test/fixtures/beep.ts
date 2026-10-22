// The toy block of the guide (packages/core/src/nodes/README.md): a `beep` kind in one file, core half and view.
// Every import is `import type`, so the view needs no runtime import; the app test and the server test both load this file.
import type { NodeType } from '../../src/nodes/index.js';
import type { KindView } from '../../src/nodes/fields.js';

declare module '../../src/model.js' {
  interface NodeKinds { beep: true }
}
declare module '../../src/compile.js' {
  interface Instrs { BEEP: { step: string; times: number } }
}
declare module '../../src/run.js' {
  interface RunEvents { beeped: { step: string; times: number } }
}

// The core half: parse a `times:` line, compile it to a BEEP instruction, run it, count it, print it.
export const beep: NodeType = {
  kind: 'beep',
  attrs: ['times'],
  compile(step, ctx) { ctx.push({ op: 'BEEP', step: step.id, times: parseInt(step.attrs.times || '1', 10) }); },
  ops: {
    BEEP: {
      async exec(i, vm) {
        vm.log('beeped', { step: i.step, times: i.times });
        vm.next();
      },
    },
  },
  count: { beeped: () => 'beeps' },
  print: { beeped: (d) => `  beeped x${d.times}` },
};

// The view half: how the block looks and edits in the app.
export const beepView = {
  kind: 'beep', order: 140, colour: 'soft',
  fields: [{ key: 'times', label: 'Times', input: 'number', check: 'count' }],
  line: ['beep', { field: 'times' }],
  card: { label: 'beep', section: 'Flow' }, fresh: { attrs: { times: '1' } },
  rows: { beeped: { text: 'beeped x{times}', className: 'sx-sub' } },
} satisfies KindView;
