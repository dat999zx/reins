// A toy `ssplit` block: `split` whose tracks share the USD room (`share: true`), only to test M2 Task 12. The test registers it; no src file knows it.
import type { NodeType } from '../../src/nodes/index.js';

declare module '../../src/model.js' {
  interface NodeKinds { ssplit: true }
}
declare module '../../src/run.js' {
  interface RunEvents { ssplit_started: unknown; ssplit_done: unknown }
}
declare module '../../src/compile.js' {
  interface Instrs { SSPLIT: { step: string; targets: number[] } }
}

export const ssplit: NodeType = {
  kind: 'ssplit',
  attrs: [],
  manyNext: true,
  compile(step, ctx) {
    const op = ctx.push({ op: 'SSPLIT', step: step.id, targets: [] as number[] });
    for (const l of step.links) if (l.kind === 'next') ctx.linkTo(l.to, (t) => { op.targets.push(t); });
  },
  ops: {
    SSPLIT: {
      async exec(i, vm) {
        const results = vm.tracks.take(i.step);
        if (!results) {
          vm.tracks.start(i.step, (i.targets as number[]).map((at) => ({ key: (vm.program[at] as { step?: string }).step ?? `${i.step}@${at}`, at, title: `Branch ${i.step}`, share: true as const })));
          vm.log('ssplit_started', { step: i.step });
          return;
        }
        for (const r of results) vm.handBack(`Result of ${r.key}: ${r.text}`);
        vm.log('ssplit_done', { step: i.step });
        vm.next();
      },
      next: (i, at) => [at + 1, ...i.targets],
      starts: (i) => i.targets,
    },
  },
};
