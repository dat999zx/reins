// The toy block: a `beep` kind as a code mod. A step like `## beep` with `times: 2` compiles to BEEP, which logs `beeped`;
// the receipt counts it as `beeps` and `reins run` prints `  beeped x2`. Everything it registers is listed in mod.json `provides`.
import fs from 'node:fs';
import process from 'node:process';

// The test sets TOY_MARKER; the file shows the code ran, and how many times.
const marker = process.env.TOY_MARKER;
if (marker) fs.appendFileSync(marker, 'toy-beep loaded\n');

const beep = {
  kind: 'beep',
  attrs: ['times'],
  compile(step, ctx) {
    ctx.push({ op: 'BEEP', step: step.id, times: parseInt(step.attrs.times || '1', 10) });
  },
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

// A code mod default-exports this; it is called once with the api built for this mod.
export default function activate(api) {
  api.registerBlock(beep);
}
