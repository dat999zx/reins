// The workflows and the drivers of group Y's tests (M3 Tasks 5 and 6): `m3-task-y-pin` runs them through the pack, `m3-task-y-moves` through Customize copies.
// A scripted engine and a scripted command runner, a fixed clock: the events are the same every time.
import { FakeEngine, Run, parseWorkflow, receipt, type CommandOutcome, type ScriptedTurn } from '@reins/core';

const head = (name: string) => `---\nreins: 1\nname: ${name}\nbudget: { turns: 40, minutes: 9 }\nalways: []\n---\n\n`;
export const WF: Record<string, string> = {
  // run: a failing command goes to the fix, which links back
  runFix: head('run-fix') + '## run `npm test`\non-fail: fix (max 2)\n\n## end\n\n## phase fix\n> fix it\nnext: run-1\n',
  // run: a step only the on-fail link reaches (no error in the file, so the "never reached" check runs)
  runFailTarget: head('run-fail-target') + '## run `npm test`\non-fail: fix\n\n## end\n\n## phase fix\n> fix it\n',
  // run: odd headings (no command, no backticks, a quoted command, inner backticks)
  runOdd: head('run-odd') + '## run\n\n## run echo hi\n\n## run `echo "a b"`\n\n## run `a`b``\n\n## say\n> done\n',
  // run with a next link and a pass: a run can also fall through on failure
  runNext: head('run-next') + '## run `make`\nnext: tail\n\n## phase skipped\n> skipped\n\n## phase tail\n> tail\n',
  repeatTests: head('repeat-tests') + '## repeat\nuntil: tests pass\nmax: 3\n\n### run `npm test`\n\n### phase fix\n> fix\n',
  repeatLint: head('repeat-lint') + '## repeat\nuntil: `npm run lint` passes\nmax: 3\n\n### run `npm run lint`\n\n### phase fix\n> fix\n',
  repeatOther: head('repeat-other') + '## repeat\nuntil: `npm run lint` passes\nmax: 3\n\n### run `npm test`\n\n### phase fix\n> fix\n',
  repeatLate: head('repeat-late') + '## repeat\nuntil: tests pass\nmax: 3\n\n### phase fix\n> fix\n\n### run `npm test`\n',
  repeatNoCmd: head('repeat-nocmd') + '## repeat\nuntil: tests pass\nmax: 2\n\n### run\n',
  repeatAgent: head('repeat-agent') + '## repeat\nuntil: agent says done\nmax: 3\n\n### phase work\n> work\n',
  repeatBudget: head('repeat-budget') + '## repeat\nuntil: tests pass\nmax: 2\n\n### run `npm test`\n\n### phase fix\n> fix\n\n## end\n',
  repeatNested: head('repeat-nested') + '## repeat\nuntil: tests pass\nmax: 2\n\n### repeat\nuntil: `npm run lint` passes\nmax: 2\n\n#### run `npm run lint`\n\n### run `npm test`\n\n### phase fix\n> fix\n',
  repeatNot: head('repeat-not') + '## repeat\nuntil: not tests pass\nmax: 2\n\n### run `npm test`\n',
  repeatBad: head('repeat-bad') + '## repeat\nuntil: tests pass\n\n### phase a\n> a\n\n## repeat\nuntil: tests pass\nmax: 0\n\n### phase b\n> b\n\n## repeat\nuntil: tests pass\nmax: abc\n\n### phase c\n> c\n\n## repeat\nmax: 2\n\n### phase d\n> d\n',
  repeatEmpty: head('repeat-empty') + '## repeat\nuntil: tests pass\nmax: 2\n',
  verify: head('verify') + '## phase plan\n> plan\n\n## verify\nagainst: plan\non-fail: plan (max 2)\n\n## verify\n\n## verify\nagainst: later\n> check this carefully\n\n## phase later\n> later\n',
  verifyFailTarget: head('verify-fail-target') + '## phase plan\n> plan\n\n## verify\nagainst: plan\non-fail: fixit\n\n## end\n\n## phase fixit\n> fix it\n',
  verifyBad: head('verify-bad') + '## verify\nagainst: ghost\n\n## verify\nagainst: plan\non-fail: nowhere\n\n## phase plan\n> plan\n',
  verifyDeep: head('verify-deep') + '## phase plan\n> plan\n\n## repeat\nuntil: agent says done\nmax: 2\n\n### verify\nagainst: plan\non-fail: plan\n',
};

const ok = (exitCode: number): CommandOutcome => ({ exitCode, stdout: exitCode ? 'bad' : 'good', stderr: '' });

export interface Opts { turns?: string[]; cmds?: number[]; allow?: number; steps?: number }
export async function drive(text: string, o: Opts = {}) {
  const w = parseWorkflow(text).workflow!;
  const turns = (o.turns ?? []).map((t): ScriptedTurn => ({ text: t, cost: 0.01 }));
  while (turns.length < 12) turns.push({ text: `reply ${turns.length + 1}\nREINS: done`, cost: 0.01 });
  const engine = new FakeEngine(turns);
  const cmds = o.cmds ?? [0];
  const seen: string[] = [];
  const commandRunner = async (cmd: string) => { const n = seen.length; seen.push(cmd); return ok(cmds[Math.min(n, cmds.length - 1)]!); };
  let t = 0;
  const run = new Run({ workflow: w, engine, now: () => (t += 1000), commandRunner });
  let allow = o.allow ?? 0;
  const pauses: unknown[] = [];
  for (let i = 0; i < (o.steps ?? 60); i++) {
    if (run.status === 'paused' && allow > 0 && run.pauses().some((p) => p.type === 'budget-used' || p.type === 'link-budget-used')) {
      pauses.push(run.pauses());
      run.allowMore(1);
      allow--;
      continue;
    }
    if (run.status !== 'running') break;
    await run.step();
  }
  const snap = run.snapshot();
  return { status: run.status, pauses: [...pauses, run.pauses()], commands: seen, texts: engine.receivedTexts, events: snap.events, receipt: receipt(snap.events), counter: snap.programCounter };
}

/** Stop while a command is in flight: the command settles right after Stop, or right before it. */
export async function stopDuring(text: string, settleFirst: boolean) {
  const w = parseWorkflow(text).workflow!;
  const engine = new FakeEngine([{ text: 'x\nREINS: done', cost: 0.01 }, { text: 'y\nREINS: done', cost: 0.01 }]);
  let release!: () => void;
  const seen: string[] = [];
  const commandRunner = (cmd: string) => { seen.push(cmd); return new Promise<CommandOutcome>((res) => { release = () => res(ok(0)); }); };
  let t = 0;
  const run = new Run({ workflow: w, engine, now: () => (t += 1000), commandRunner });
  const stepping = (async () => { for (let i = 0; i < 20 && run.status === 'running'; i++) await run.step(); })();
  while (!seen.length) await new Promise((r) => setTimeout(r, 1));
  if (settleFirst) { release(); await new Promise((r) => setTimeout(r, 5)); }
  const stopping = run.stop();
  if (!settleFirst) { release(); }
  await Promise.race([Promise.all([stepping, stopping]), new Promise((r) => setTimeout(r, 500))]);
  const snap = run.snapshot();
  return { status: run.status, commands: seen, events: snap.events.map((e) => ({ type: e.type, data: e.data })), counter: snap.programCounter };
}
