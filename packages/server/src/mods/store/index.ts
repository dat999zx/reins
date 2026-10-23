// The `store` block of the default pack: has the agent sum up a decision and hands it to the host to keep in Knowl. Its `store` event is counted into the receipt's Knowl fields.
import type { Instr, NodeType, OpType, Step } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface NodeKinds { store: true }
  interface ModInstrs { STORE: { step: string; what: string } }
  interface ModEvents { store: unknown }
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

export default function activate(api: Pick<ModApi, 'registerBlock'>): void {
  const store: NodeType = {
    kind: 'store',
    attrs: ['knowl'],
    compile(step, ctx) { ctx.push({ op: 'STORE', step: step.id, what: step.attrs.knowl || 'decisions' }); },
    ops: { STORE },
    count: { store: (d) => (d?.skipped ? 'knowlSkipped' : 'knowlStores') },
    print: { store: (d) => (d.skipped ? '· store skipped: Knowl is not wired up until Phase 6' : undefined) },
  };
  api.registerBlock(store);
}
