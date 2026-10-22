// A toy `split` block, only to prove the compile and validate contract of tracks (M2 Tasks 7 and 8): it takes several
// `next` links, compiles them into one SPLIT, and says where tracks start. The test registers it; no src file knows it.
import type { NodeType } from '../../src/nodes/index.js';

declare module '../../src/model.js' {
  interface NodeKinds { split: true }
}
declare module '../../src/run.js' {
  interface RunEvents { split_started: unknown; split_done: unknown }
}
declare module '../../src/compile.js' {
  interface Instrs { SPLIT: { step: string; targets: number[] } }
}

/** What `validate.program` saw, per split, so a test can read `members` and `trackOf` through the real hook. */
export const seen: Array<{ step: string; members: Record<string, string[]>; nested: Record<string, string[]>; trackOf: Record<string, string | undefined> }> = [];

export const split: NodeType = {
  kind: 'split',
  attrs: [],
  manyNext: true,
  validate: {
    program(step, ctx) {
      const next = step.links.filter((l) => l.kind === 'next').map((l) => l.to);
      const row: (typeof seen)[number] = { step: step.id, members: {}, nested: {}, trackOf: {} };
      for (const t of next) {
        row.members[t] = ctx.members(t);
        row.nested[t] = ctx.members(t, true);
        for (const m of row.nested[t]!) row.trackOf[m] = ctx.trackOf(m);
      }
      row.trackOf[step.id] = ctx.trackOf(step.id);
      seen.push(row);
    },
  },
  compile(step, ctx) {
    const split = ctx.push({ op: 'SPLIT', step: step.id, targets: [] as number[] });
    for (const l of step.links) if (l.kind === 'next') ctx.linkTo(l.to, (t) => { split.targets.push(t); });
  },
  ops: {
    SPLIT: {
      // Starts a track at each target (keyed by the step there) and parks; when every one ended it runs again, hands each result to the next turn and moves on.
      async exec(i, vm) {
        const results = vm.tracks.take(i.step);
        if (!results) {
          vm.tracks.start(i.step, (i.targets as number[]).map((at) => ({ key: (vm.program[at] as { step?: string }).step ?? `${i.step}@${at}`, at, title: `Split ${i.step}` })));
          vm.log('split_started', { step: i.step });
          return;
        }
        for (const r of results) vm.handBack(`Result of ${r.key}: ${r.text}`);
        vm.log('split_done', { step: i.step });
        vm.next();
      },
      next: (i, at) => [at + 1, ...i.targets],
      starts: (i) => i.targets,
    },
  },
};
