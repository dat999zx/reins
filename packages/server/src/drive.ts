import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  printCond, showText, usdText,
  type Cond, type Decision, type Engine, type EngineSession, type Run, type RunEventRecord,
  type RunOptions, type ToolRequest, type Workflow,
} from '@reins/core';
import { runCommand } from './commands.js';

export interface Question { id: string; kind: 'gate' | 'budget' | 'resume' | 'tool' | 'judge' | 'trust' | 'switch' | 'usd'; prompt: string; detail?: string;
  /** Who asks, when not the run's own agent (a subagent, D); the card shows it. */
  title?: string;
  /** The prompt line is not the whole of what is asked (it was cut, or characters in it are shown as escapes): a terminal prints the whole detail under it. */
  long?: true }
export interface DriveIo {
  ask(q: Question): Promise<string | null>; say(line: string): void; write(chunk: string): void;
  /** A command's output is over: whatever `write` was holding back (the start of a possible key) can go out. */
  endOutput?(): void;
}

export type Answer =
  | { t: 'approve' }
  | { t: 'changes'; note: string }
  | { t: 'stop' }
  | { t: 'allow'; n: number }
  | { t: 'allowUsd'; usd: number }
  | { t: 'resume'; note: string }
  | { t: 'invalid'; hint: string };

export const questionId = () => randomBytes(6).toString('hex');

/** The terminal's answer words (run-cli.ts:195-224 at 33ba873). The UI's buttons send these same strings. */
export function parseAnswer(kind: 'gate' | 'budget' | 'resume' | 'usd', a: string): Answer {
  if (kind === 'usd') {
    const m = /^allow\s+\$?(\d+(?:\.\d{1,2})?)(\s+more)?$/i.exec(a);
    if (m && Number(m[1]) > 0) return { t: 'allowUsd', usd: Number(m[1]) };
    if (a === 'stop') return { t: 'stop' };
    return { t: 'invalid', hint: 'Type allow $<amount> more, like allow $0.50, or stop.' };
  }
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
  if (p.type === 'usd-budget-used') {
    // measured dollars (a float sum, a long tail) are rounded to 4 decimals before they are printed
    const r4 = (x: number) => usdText(Math.round(x * 1e4) / 1e4);
    const limit = r4(p.limit!), spent = r4(p.spent!);
    io.say(p.stepId ? `⏸ block ${p.stepId} used its $${limit} budget ($${spent} spent)` : `⏸ the run used its $${limit} USD budget ($${spent} spent)`);
    const left = run.usdLeft();
    const detail = p.stepId
      ? `Block \`${p.stepId}\` has used $${spent} of its $${limit}.${left === undefined ? '' : ` The workflow's USD budget has $${r4(Math.max(left, 0))} left.`}`
      : `The run has used $${spent} of its $${limit} USD budget.`;
    // The engine's own words when it stopped for a budget it cannot hold (an unknown spend, a missing price): the figures alone would not say why.
    const why = p.text ? ` ${p.text}` : '';
    const a = await io.ask({ id: questionId(), kind: 'usd', prompt: 'allow $<amount> more / stop', detail: detail + why });
    if (a === null) return false;
    const ans = parseAnswer('usd', a);
    if (ans.t === 'allowUsd') {
      const refused = run.allowUsd(ans.usd);
      if (refused) io.say(refused);
    } else if (ans.t === 'stop') await run.stop();
    else if (ans.t === 'invalid') io.say(ans.hint);
    return true;
  }
  if (p.type === 'agent-blocked' || p.type === 'stop') {
    io.say(p.type === 'stop' ? (p.stepId ? `⏸ ${p.stepId}: ${p.text}` : `⏹ stopped by a card: ${p.text}`) : `⏸ the agent is blocked: ${p.reason}`);
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

/** The most of a command the one-line question shows; the rest is in the detail, always in full. */
const PROMPT_CHARS = 200;

/** `full`: the terminal prints the whole detail under this question even when the line shows all of it (an engine Reins runs: a short path hides the content). */
export async function askTool(io: DriveIo, req: ToolRequest, title?: string, full?: boolean): Promise<Decision> {
  const i = req.input ?? {};
  const chars = [...String(i.command ?? i.file_path ?? i.path ?? JSON.stringify(i))];
  // What is shown is escaped (control, direction and zero-width characters become <U+XXXX>); what runs is `req.input`, untouched.
  const head = chars.slice(0, PROMPT_CHARS).join('');
  const what = showText(head);
  const long = full === true || chars.length > PROMPT_CHARS || what !== head;
  const more = chars.length > PROMPT_CHARS ? ` (${i.command !== undefined ? 'command' : 'text'} continues, ${chars.length - PROMPT_CHARS} more characters, all shown below)` : '';
  const a = await io.ask({ id: questionId(), kind: 'tool', prompt: `? Allow ${showText(req.tool)}${req.reason ? ` (${showText(req.reason)})` : ''}: ${what}${more}  [y / n <reason>]`, detail: JSON.stringify(req.input ?? {}), ...(title ? { title } : {}), ...(long ? { long: true as const } : {}) });
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
  switchModel?: RunOptions['switchModel'];
  setReasoning?: RunOptions['setReasoning'];
  openSubagent?: RunOptions['openSubagent'];
  /** What workflow commands and the git calls run with: the callers pass `shellEnvFrom(...)`, asked at each start, so no key and no REINS_* var reaches them. */
  env?: () => NodeJS.ProcessEnv;
}): RunOptions {
  const { cwd } = o;
  const startCommit = git(cwd, ['rev-parse', 'HEAD'], o.env).trim();
  return {
    workflow: o.workflow,
    engine: o.engine,
    cwd,
    resolveBlock: o.resolveBlock,
    ...(o.session ? { session: o.session } : {}),
    ...(o.switchModel ? { switchModel: o.switchModel } : {}),
    ...(o.setReasoning ? { setReasoning: o.setReasoning } : {}),
    ...(o.openSubagent ? { openSubagent: o.openSubagent } : {}),
    commandRunner: async (cmd) => {
      io.say(`$ ${cmd}`);
      let r: Awaited<ReturnType<typeof runCommand>>;
      try {
        r = await runCommand(cmd, { cwd, ...(o.env ? { env: o.env } : {}), onOutput: (s) => io.write(s) });
      } finally {
        io.endOutput?.();                  // even when the command fails: what was held back is written under this run
      }
      io.say(r.exitCode === 0 ? '✓ passed' : `✗ failed (exit ${r.exitCode})`);
      return r;
    },
    judge: (c, ev) => askJudge(io, c, ev),
    diffLines: async () => (startCommit ? diffLines(cwd, startCommit, o.env) : 0),
    onEvent: o.onEvent,
  };
}

function git(cwd: string, args: string[], env?: () => NodeJS.ProcessEnv): string {
  const e = env?.();
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, ...(e ? { env: e } : {}) });
  return r.status === 0 ? r.stdout : '';
}

/** `git diff --numstat` against the run's start commit: added plus removed lines. */
function diffLines(cwd: string, base: string, env?: () => NodeJS.ProcessEnv): number {
  // ponytail: untracked new files are not counted; add `git add -N` if that matters.
  return git(cwd, ['diff', '--numstat', base], env).split('\n').reduce((n, l) => {
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
