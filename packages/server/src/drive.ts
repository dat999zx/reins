import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  printCond,
  type Cond, type Decision, type Engine, type EngineSession, type Run, type RunEventRecord,
  type RunOptions, type ToolRequest, type Workflow,
} from '@reins/core';
import { runCommand } from './commands.js';

export interface Question { id: string; kind: 'gate' | 'budget' | 'resume' | 'tool' | 'judge' | 'trust'; prompt: string; detail?: string }
export interface DriveIo { ask(q: Question): Promise<string | null>; say(line: string): void; write(chunk: string): void }

export type Answer =
  | { t: 'approve' }
  | { t: 'changes'; note: string }
  | { t: 'stop' }
  | { t: 'allow'; n: number }
  | { t: 'resume'; note: string }
  | { t: 'invalid'; hint: string };

export const questionId = () => randomBytes(6).toString('hex');

/** The terminal's answer words (run-cli.ts:195-224 at 33ba873). The UI's buttons send these same strings. */
export function parseAnswer(kind: 'gate' | 'budget' | 'resume', a: string): Answer {
  if (kind === 'gate') {
    if (/^(approve|a|y|yes)$/i.test(a)) return { t: 'approve' };
    if (/^changes\s+\S/i.test(a)) return { t: 'changes', note: a.replace(/^changes\s+/i, '') };
    if (a === 'stop') return { t: 'stop' };
    return { t: 'invalid', hint: 'Type approve, changes <note>, or stop.' };
  }
  if (kind === 'budget') {
    const n = /^allow\s+(\d+)/i.exec(a);
    if (n) return { t: 'allow', n: Number(n[1]) };
    if (a === 'stop') return { t: 'stop' };
    return { t: 'invalid', hint: 'Type allow <n> more, or stop.' };
  }
  if (/^resume\b/i.test(a)) return { t: 'resume', note: a.replace(/^resume\s*/i, '') };
  if (a === 'stop') return { t: 'stop' };
  return { t: 'invalid', hint: 'Type resume [note], or stop.' };
}

/** Steps the run and answers its pauses through `io`. Returns 'detached' when the asker went away or the engine failed. */
export async function driveRun(run: Run, io: DriveIo, save: () => void): Promise<{ result: 'finished' | 'detached'; error?: string }> {
  let detached = false;
  let error: string | undefined;
  try {
    while (!detached) {
      if (run.status === 'running') {
        await run.step();
        save();
        // Let typed lines land between steps.
        await new Promise((r) => setImmediate(r));
      } else if (run.status === 'paused') {
        detached = !(await onPause(run, io));
      } else {
        break;
      }
    }
  } catch (err: any) {
    error = String(err?.message ?? err);
    io.say(`✗ ${error}`);
    detached = true;
  } finally {
    await run.close().catch(() => {});
  }
  save();
  const result = detached && run.status !== 'done' && run.status !== 'stopped' ? 'detached' : 'finished';
  return { result, ...(error !== undefined ? { error } : {}) };
}

/** Answer a pause. Returns false when the asker went away (the run stays saved). */
async function onPause(run: Run, io: DriveIo): Promise<boolean> {
  const p = run.pauseReason!;
  if (p.type === 'gate') {
    io.say(`⏸ gate ${p.stepId}: until ${p.cond ? printCond(p.cond) : 'you approve'}`);
    const last = lastTurnText(run.getEvents());
    if (last) io.say(indent(last.split('\n').slice(-15).join('\n')) + '\n');
    const a = await io.ask({ id: questionId(), kind: 'gate', prompt: 'approve / changes <note> / stop' });
    if (a === null) return false;
    const ans = parseAnswer('gate', a);
    if (ans.t === 'approve') run.approve();
    else if (ans.t === 'changes') await run.requestChanges(ans.note);
    else if (ans.t === 'stop') await run.stop();
    else if (ans.t === 'invalid') io.say(ans.hint);
    return true;
  }
  if (p.type === 'budget-used' || p.type === 'link-budget-used') {
    io.say(p.type === 'budget-used'
      ? `⏸ loop ${p.stepId} used its ${p.limit} attempts`
      : `⏸ link used its budget (max ${p.limit})`);
    const a = await io.ask({ id: questionId(), kind: 'budget', prompt: 'allow <n> more / stop' });
    if (a === null) return false;
    const ans = parseAnswer('budget', a);
    if (ans.t === 'allow') run.allowMore(ans.n);
    else if (ans.t === 'stop') await run.stop();
    else if (ans.t === 'invalid') io.say(ans.hint);
    return true;
  }
  if (p.type === 'agent-blocked' || p.type === 'stop') {
    io.say(p.type === 'stop' ? `⏹ stopped by a card: ${p.text}` : `⏸ the agent is blocked: ${p.reason}`);
    const a = await io.ask({ id: questionId(), kind: 'resume', prompt: 'resume [note] / stop' });
    if (a === null) return false;
    const ans = parseAnswer('resume', a);
    if (ans.t === 'resume') {
      if (ans.note) run.queueCard(ans.note, 'steer');
      run.resume();
    } else if (ans.t === 'stop') await run.stop();
    else if (ans.t === 'invalid') io.say(ans.hint);
    return true;
  }
  // ponytail: the turn budget and a deleted step (live edit) can only be stopped from the terminal.
  io.say(`⏸ ${p.type === 'run-turn-budget-used' ? `the run used its ${run.workflow.budget.turns} turns` : p.type}; stopping.`);
  await run.stop();
  return true;
}

export async function askTool(io: DriveIo, req: ToolRequest): Promise<Decision> {
  const i = req.input ?? {};
  const what = String(i.command ?? i.file_path ?? i.path ?? JSON.stringify(i)).slice(0, 200);
  const a = await io.ask({ id: questionId(), kind: 'tool', prompt: `? Allow ${req.tool}: ${what}  [y / n <reason>]`, detail: JSON.stringify(req.input ?? {}) });
  if (a !== null && /^(y|yes)$/i.test(a)) return { behavior: 'allow' };
  const reason = a?.replace(/^(n|no)\b\s*/i, '').trim();
  return { behavior: 'deny', message: reason ? `The user said no: ${reason}` : 'The user said no.' };
}

export async function askJudge(io: DriveIo, cond: Cond, ev: { lastText: string }): Promise<boolean> {
  // Phase 2: llm and reviewer conditions are judged by you (the real judges are Phase 6).
  io.say(`? You judge: ${printCond(cond)}`);
  if (ev.lastText) io.say(indent(ev.lastText.split('\n').slice(-15).join('\n')));
  const a = await io.ask({ id: questionId(), kind: 'judge', prompt: 'y / n' });
  return a !== null && /^(y|yes)$/i.test(a);
}

export function runOptions(io: DriveIo, o: {
  workflow: Workflow; engine: Engine; cwd: string;
  resolveBlock: (name: string) => Workflow | undefined;
  onEvent: (ev: RunEventRecord) => void; session?: EngineSession;
}): RunOptions {
  const { cwd } = o;
  const startCommit = git(cwd, ['rev-parse', 'HEAD']).trim();
  return {
    workflow: o.workflow,
    engine: o.engine,
    cwd,
    resolveBlock: o.resolveBlock,
    ...(o.session ? { session: o.session } : {}),
    commandRunner: async (cmd) => {
      io.say(`$ ${cmd}`);
      const r = await runCommand(cmd, { cwd, onOutput: (s) => io.write(s) });
      io.say(r.exitCode === 0 ? '✓ passed' : `✗ failed (exit ${r.exitCode})`);
      return r;
    },
    judge: (c, ev) => askJudge(io, c, ev),
    diffLines: async () => (startCommit ? diffLines(cwd, startCommit) : 0),
    onEvent: o.onEvent,
  };
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout : '';
}

/** `git diff --numstat` against the run's start commit: added plus removed lines. */
function diffLines(cwd: string, base: string): number {
  // ponytail: untracked new files are not counted; add `git add -N` if that matters.
  return git(cwd, ['diff', '--numstat', base]).split('\n').reduce((n, l) => {
    const [a, r] = l.split('\t');
    return n + (Number(a) || 0) + (Number(r) || 0);
  }, 0);
}

function lastTurnText(evs: RunEventRecord[]): string {
  for (let i = evs.length - 1; i >= 0; i--) if (evs[i]!.type === 'turn_ended') return String(evs[i]!.data.text ?? '');
  return '';
}

export function indent(s: string): string {
  return s.replace(/\r?\n$/, '').split(/\r?\n/).map((l) => `    ${l}`).join('\n') + (s.endsWith('\n') ? '\n' : '');
}
