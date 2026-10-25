// M3 Task 4: what is new now that `gate`, `if`, `recall` and `store` are mods of the default pack (the output of the four is pinned in m3-task-4-pin).
import { describe, expect, it } from 'vitest';
import { FakeEngine, NODES, Run, parseWorkflow, register, viewShapeProblem, type CommandOutcome, type ScriptedTurn } from '@reins/core';
import { usePack } from './pack-helper.js';

usePack();

const head = (name: string) => `---\nreins: 1\nname: ${name}\nbudget: { turns: 20, minutes: 9 }\nalways: []\n---\n\n`;
const turn = (text: string): ScriptedTurn => ({ text, cost: 0.01 });

async function runIt(body: string, turns: ScriptedTurn[], exitCode: number) {
  const w = parseWorkflow(head('t4') + body).workflow!;
  const cmds: string[] = [];
  let t = 0;
  const run = new Run({
    workflow: w, engine: new FakeEngine(turns), now: () => (t += 1000),
    commandRunner: async (cmd): Promise<CommandOutcome> => { cmds.push(cmd); return { exitCode, stdout: '', stderr: '' }; },
  });
  for (let i = 0; i < 40 && run.status === 'running'; i++) await run.step();
  const snap = run.snapshot();
  return { status: run.status, cmds, events: snap.events.map((e) => e.type), pauses: run.pauses() };
}

describe('M3 Task 4: the four blocks are the pack\'s and are guarded like any mod\'s block', () => {
  it('they are in core with a mod mark, the events they declared, and the pack mark', () => {
    for (const [kind, events] of [['gate', ['gate_paused']], ['if', []], ['recall', ['recall']], ['store', ['store']]] as const) {
      const n = NODES.get(kind)!;
      expect(n.mod?.id, kind).toBe(kind);
      expect([...n.mod!.events], kind).toEqual(events);
      expect(n.mod!.pack, kind).toBe(true);
    }
  });

  it('each block\'s attribute list and shape, kind by kind (the union of all lists hides a missing one)', () => {
    expect(NODES.get('gate')).toMatchObject({ attrs: [], tag: { place: 'after', lines: ['until: you approve'] } });
    expect(NODES.get('if')).toMatchObject({ attrs: [], container: 'kids+else' });
    expect(NODES.get('recall')!.attrs).toEqual(['knowl']);
    expect(NODES.get('store')!.attrs).toEqual(['knowl']);
    expect(Object.keys(NODES.get('gate')!.ops!)).toEqual(['GATE']);
    expect(Object.keys(NODES.get('if')!.ops!)).toEqual(['IF']);
    expect(Object.keys(NODES.get('recall')!.ops!)).toEqual(['RECALL']);
    expect(Object.keys(NODES.get('store')!.ops!)).toEqual(['STORE']);
  });

  it('a gate and an if judge the command condition of their own instruction without listing it (the trust hash already counts it)', async () => {
    const gate = await runIt('## gate\nuntil: tests pass\n\n## phase after\n> go\n', [turn('ok\nREINS: done')], 0);
    expect(gate.status).toBe('done');
    expect(gate.cmds).toEqual(['npm test']);
    const yes = await runIt('## if tests pass\n### phase yes\n> yes\n\n### else\n\n### phase no\n> no\n', [turn('yes\nREINS: done')], 0);
    expect(yes.status).toBe('done');
    expect(yes.cmds).toEqual(['npm test']);
    const no = await runIt('## if tests pass\n### phase yes\n> yes\n\n### else\n\n### phase no\n> no\n', [turn('no\nREINS: done')], 1);
    expect(no.status).toBe('done');
    expect(no.cmds).toEqual(['npm test']);
  });

  it('a copy of the gate (a mod, not the pack) is fenced: it judges the command condition of its own instruction, and no other command', async () => {
    const copy = (judged: unknown) => ({
      kind: 'gatecopy', attrs: [] as string[], mod: { id: 'gatecopy', events: [] as string[] },
      compile(step: { id: string; cond?: unknown }, ctx: { push(i: never): unknown }) { ctx.push({ op: 'GATECOPY', step: step.id, cond: step.cond } as never); },
      ops: { GATECOPY: { async exec(i: { cond: unknown }, vm: { judge(c: never): Promise<boolean>; next(): void }) { await vm.judge((judged ?? i.cond) as never); vm.next(); } } },
    });
    const body = '## gatecopy\nuntil: tests pass\n\n## phase after\n> go\n';
    const own = register(copy(undefined) as never, 900);
    try {
      const ok = await runIt(body, [turn('ok\nREINS: done')], 0);
      expect(ok.status).toBe('done');
      expect(ok.cmds).toEqual(['npm test']);
    } finally { own(); }
    const other = register(copy({ t: 'cmd', cmd: 'rm -rf x' }) as never, 900);
    try {
      const bad = await runIt(body, [turn('ok\nREINS: done')], 0);
      expect(bad.status).toBe('paused');
      expect(bad.cmds).toEqual([]);
    } finally { other(); }
  });

  it('a gate whose command fails holds the run and logs gate_paused once', async () => {
    const r = await runIt('## gate\nuntil: tests pass\n', [], 1);
    expect(r.status).toBe('paused');
    expect(r.events.filter((e) => e === 'gate_paused')).toHaveLength(1);
    expect(r.pauses).toMatchObject([{ type: 'gate', stepId: 'gate-1' }]);
  });

  it('only a view of the pack (or a copy of one) may start with a condition', () => {
    const view = { kind: 'x', fields: [], line: ['x'], fresh: { cond: { t: 'approve' } } };
    const scope = { attrs: [], events: [] };
    expect(viewShapeProblem(view, { mod: scope })).toContain('a new block may start with a title, a prompt and attributes only');
    expect(viewShapeProblem(view, { mod: { ...scope, pack: true } })).toBeUndefined();
    expect(viewShapeProblem({ ...view, fresh: { cond: 3 } }, { mod: { ...scope, pack: true } })).toContain('view.fresh.cond');
    expect(viewShapeProblem({ ...view, fresh: { other: 1 } }, { mod: { ...scope, pack: true } })).toContain('view.fresh');
  });
});
