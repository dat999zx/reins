// The `verify` block of the default pack: a turn that compares the work against an earlier step and answers `REINS: pass` or `REINS: fail: ...`.
// It needs nothing from `api.core`. The `VERIFY` instruction and the `verify_result` event are its own (merged into core's `Instrs` and `RunEvents` here).
import type { Instr, NodeType, OpType, Step } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface NodeKinds { verify: true }
  interface Instrs { VERIFY: { step: string; against: string; onFailJump?: number; linkMax?: number } }
  interface RunEvents { verify_result: unknown }
}

const VERIFY: OpType<Extract<Instr, { op: 'VERIFY' }>> = {
  async exec(i, vm) {
    const session = await vm.ensureSession();
    const againstOutput = vm.outputs.get(i.against);

    const verifyStep: Step = {
      id: i.step,
      kind: 'verify',
      title: 'verify',
      attrs: { against: i.against },
      cards: [],
      links: [],
      prompt: !i.against
        ? 'Compare what you built against the earlier steps.\nList anything missing or extra.'
        : againstOutput === undefined
        ? `Step "${i.against}" has not run, so there is no output of it to compare against. Compare against what the earlier steps produced.`
        : `Compare what you built against step "${i.against}":\n${againstOutput}\nList anything missing or extra.`,
    };

    const result = await vm.turn(session, i.step, (handed) => vm.turnText(verifyStep, handed, i.top ?? 0));
    if (!result) return;

    const isFail = result.text.includes('REINS: fail');
    vm.log('verify_result', { pass: !isFail });

    if (isFail && i.onFailJump !== undefined) {
      if (!vm.takeLink(`${i.step}->${i.onFailJump}`, i.onFailJump, i.linkMax)) {
        return;
      }
      vm.goto(i.onFailJump);
      return;
    }

    vm.next();
  },
  next: (i, at) => [at + 1, i.onFailJump],
};

export default function activate(api: Pick<ModApi, 'registerBlock'>): void {
  const verify: NodeType = {
    kind: 'verify',
    fails: true,
    attrs: ['against'],
    tag: { place: 'after', lines: ['against: prompt'] },
    validate: {
      links(step, ctx) {
        if (step.attrs.against && !ctx.allIds.has(step.attrs.against)) {
          ctx.push({ severity: 'error', message: `verify against target "${step.attrs.against}" not found`, pos: ctx.pos });
        }
      },
    },
    defaultPrompt(step) {
      const target = step.attrs.against || 'plan';
      return `Compare what you built against step "${target}".\nList anything missing or extra.`;
    },
    statusLine: 'REINS: pass | fail: <what is missing>',
    compile(step, ctx) {
      const onFail = step.links.find((l) => l.kind === 'on-fail');
      const v = ctx.push<Extract<Instr, { op: 'VERIFY' }>>({ op: 'VERIFY', step: step.id, against: step.attrs.against || '', linkMax: onFail?.max });
      if (onFail) ctx.linkLater(v, onFail.to);
    },
    ops: { VERIFY },
    count: { verify_result: (d) => (d?.pass ? 'verifyResults.passed' : 'verifyResults.failed') },
    print: { verify_result: (d) => (d.pass ? '✓ verify: pass' : '✗ verify: fail') },
  };
  api.registerBlock(verify);
}
