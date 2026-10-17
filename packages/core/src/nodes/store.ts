import type { NodeType, OpType } from './index.js';
import type { Instr } from '../compile.js';
import type { Step } from '../model.js';

declare module '../model.js' {
  interface NodeKinds { store: true }
}

const STORE: OpType<Extract<Instr, { op: 'STORE' }>> = {
  async exec(i, vm) {
    const session = await vm.ensureSession();
    const storeStep: Step = {
      id: i.step,
      kind: 'store',
      title: 'store',
      attrs: { what: i.what },
      cards: [],
      links: [],
      prompt: `Provide a one-paragraph decision summary for "${i.what}".`,
    };

    const result = await vm.turn(session, i.step, (handed) => vm.turnText(storeStep, handed, i.top ?? 0));
    if (!result) return;

    const summary = result.text
      .split(/\r?\n/)
      .filter((line) => !/^\s*REINS:\s*/.test(line))
      .join('\n')
      .trim();

    if (vm.services.store) {
      await vm.services.store(i.what, summary);
      vm.log('store', { what: i.what, summary });
    } else {
      vm.log('store', { what: i.what, skipped: 'no store function' });
    }

    vm.next();
  },
};

const store: NodeType = {
  kind: 'store',
  attrs: ['knowl'],
  compile(step, ctx) { ctx.push({ op: 'STORE', step: step.id, what: step.attrs.knowl || 'decisions' }); },
  ops: { STORE },
};
export default store;
