import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import {
  Run, parseWorkflow, validate, printCond, receipt,
  type Cond, type Decision, type Diagnostic, type Engine, type EngineEvent, type Receipt,
  type RunEventRecord, type RunOptions, type RunStatus, type ToolRequest, type Workflow,
} from '@reins/core';
import { runCommand } from './commands.js';
import type { Store } from './store.js';

export interface RunCliOptions {
  /** The workflow file; not needed with resumeId. */
  file?: string;
  resumeId?: string;
  cwd: string;
  input: Readable;
  output: Writable;
  store: Store;
  makeEngine: (io: { onApprove: (r: ToolRequest) => Promise<Decision>; onLive: (e: EngineEvent) => void; workflow: Workflow }) => Engine;
  /** Approve gates and terminal judge questions without asking. Never touches guards or tool approvals. */
  yes?: boolean;
}

export interface RunCliResult {
  runId: string;
  status: RunStatus | 'invalid';
  exitCode: number;
  receipt?: Receipt;
}

/** `reins run` in the terminal (plan 15b 2.6). */
export function startRunCli(o: RunCliOptions): { done: Promise<RunCliResult>; sigint: () => void } {
  const say = (s: string) => o.output.write(s + '\n');

  // One reader for the terminal: a line answers the oldest open question, else it is a card.
  const asks: Array<(line: string | null) => void> = [];
  let eof = false;
  let onCardLine: (line: string) => void = () => {};
  const rl = readline.createInterface({ input: o.input, terminal: false });
  rl.on('line', (line) => {
    const a = asks.shift();
    if (a) a(line.trim());
    else onCardLine(line.trim());
  });
  rl.on('close', () => {
    eof = true;
    for (const a of asks.splice(0)) a(null);
  });
  const ask = (q: string): Promise<string | null> => {
    if (eof) {
      say(q);
      return Promise.resolve(null);
    }
    // Wait for the answer before printing the question: piped input can answer within the write.
    const answer = new Promise<string | null>((resolve) => asks.push(resolve));
    say(q);
    return answer;
  };

  let sigints = 0;
  let run: Run | undefined;
  const sigint = () => {
    sigints++;
    if (sigints === 1) {
      say('^C  stop card sent. Press Ctrl-C again to kill the run.');
      const a = asks.shift();
      if (a) a('stop');
      else run?.queueCard('Stop. The user pressed Ctrl-C.', 'stop');
    } else {
      say('^C  killing the run.');
      for (const a of asks.splice(0)) a('stop');
      if (run && run.status !== 'stopped' && run.status !== 'done') void run.stop();
    }
  };

  const done = (async (): Promise<RunCliResult> => {
    try {
      return await main();
    } finally {
      rl.close();
    }
  })();

  async function main(): Promise<RunCliResult> {
    // ---- load the workflow, or the saved run
    let runId: string;
    let file: string;
    let snapshot: ReturnType<Run['snapshot']> | undefined;
    if (o.resumeId) {
      const saved = o.store.loadRun(o.resumeId);
      if (!saved) {
        say(`No saved run ${o.resumeId}.`);
        return { runId: o.resumeId, status: 'invalid', exitCode: 1 };
      }
      runId = o.resumeId;
      file = saved.workflowPath;
      snapshot = saved.snapshot;
      if (path.resolve(saved.cwd) !== path.resolve(o.cwd)) say(`· resuming in the run's own folder ${saved.cwd}`);
      o.cwd = saved.cwd;
    } else {
      runId = randomBytes(4).toString('hex');
      file = path.resolve(o.file ?? '');
    }
    const loaded = loadWorkflow(file);
    for (const d of loaded.diagnostics) say(formatDiagnostic(file, d));
    if (!loaded.workflow) return { runId, status: 'invalid', exitCode: 1 };
    const workflow = loaded.workflow;

    const cwd = o.cwd;
    const startCommit = git(cwd, ['rev-parse', 'HEAD']).trim();
    const engine = o.makeEngine({ onApprove: askApproval, onLive: printLive, workflow });
    const runOpts: RunOptions = {
      workflow,
      engine,
      cwd,
      resolveBlock: loaded.resolveBlock,
      commandRunner: async (cmd) => {
        say(`$ ${cmd}`);
        const r = await runCommand(cmd, { cwd, onOutput: (s) => o.output.write(indent(s)) });
        say(r.exitCode === 0 ? '✓ passed' : `✗ failed (exit ${r.exitCode})`);
        return r;
      },
      judge: askJudge,
      diffLines: async () => (startCommit ? diffLines(cwd, startCommit) : 0),
      onEvent: (ev) => {
        o.store.appendEvent(runId, ev);
        if (run) o.store.saveSnapshot(runId, run.snapshot());
        printEvent(ev);
      },
    };

    if (snapshot) {
      run = Run.restore(snapshot, runOpts);
      say(`Reins · resuming run ${runId} · workflow "${workflow.name}" · ${cwd}`);
    } else {
      o.store.createRun({ id: runId, workflowPath: file, cwd });
      say(`Reins · run ${runId} · workflow "${workflow.name}" · ${cwd}`);
      run = new Run(runOpts);
    }
    say('Type a line to send a card (steer). /now <text> interrupts and sends it. /stop halts the run.');
    onCardLine = (line) => {
      if (!line || !run) return;
      if (line === '/stop') run.queueCard('Stop. The user halted the run from the terminal.', 'stop');
      else if (line.startsWith('/now ')) run.queueCard(line.slice(5).trim(), 'now');
      else run.queueCard(line, 'steer');
    };

    let detached = false;
    try {
      while (!detached) {
        if (run.status === 'running') {
          await run.step();
          o.store.saveSnapshot(runId, run.snapshot());
          // Let typed lines land between steps.
          await new Promise((r) => setImmediate(r));
        } else if (run.status === 'paused') {
          detached = !(await onPause(run));
        } else {
          break;
        }
      }
    } catch (err: any) {
      say(`✗ ${err?.message ?? err}`);
      detached = true;
    } finally {
      await run.close().catch(() => {});
    }
    o.store.saveSnapshot(runId, run.snapshot());

    if (detached && run.status !== 'done' && run.status !== 'stopped') {
      say(`The run is saved. Resume it with: reins run --resume ${runId}`);
      return { runId, status: run.status, exitCode: 1 };
    }
    const r = receipt(run.getEvents());
    printReceipt(r, runId);
    return { runId, status: run.status, exitCode: run.status === 'done' ? 0 : 1, receipt: r };
  }

  /** Answer a pause. Returns false when the terminal went away (the run stays saved). */
  async function onPause(run: Run): Promise<boolean> {
    const p = run.pauseReason!;
    if (p.type === 'gate') {
      say(`⏸ gate ${p.stepId}: until ${p.cond ? printCond(p.cond) : 'you approve'}`);
      const last = lastTurnText(run.getEvents());
      if (last) say(indent(last.split('\n').slice(-15).join('\n')) + '\n');
      if (o.yes) {
        say('  approved (--yes)');
        run.approve();
        return true;
      }
      const a = await ask('approve / changes <note> / stop');
      if (a === null) return false;
      if (/^(approve|a|y|yes)$/i.test(a)) run.approve();
      else if (/^changes\s+\S/i.test(a)) await run.requestChanges(a.replace(/^changes\s+/i, ''));
      else if (a === 'stop') await run.stop();
      else say('Type approve, changes <note>, or stop.');
      return true;
    }
    if (p.type === 'budget-used' || p.type === 'link-budget-used') {
      say(p.type === 'budget-used'
        ? `⏸ loop ${p.stepId} used its ${p.limit} attempts`
        : `⏸ link used its budget (max ${p.limit})`);
      const a = await ask('allow <n> more / stop');
      if (a === null) return false;
      const n = /^allow\s+(\d+)/i.exec(a);
      if (n) run.allowMore(Number(n[1]));
      else if (a === 'stop') await run.stop();
      else say('Type allow <n> more, or stop.');
      return true;
    }
    if (p.type === 'agent-blocked' || p.type === 'stop') {
      say(p.type === 'stop' ? `⏹ stopped by a card: ${p.text}` : `⏸ the agent is blocked: ${p.reason}`);
      const a = await ask('resume [note] / stop');
      if (a === null) return false;
      if (/^resume\b/i.test(a)) {
        const note = a.replace(/^resume\s*/i, '');
        if (note) run.queueCard(note, 'steer');
        run.resume();
      } else if (a === 'stop') await run.stop();
      else say('Type resume [note], or stop.');
      return true;
    }
    // ponytail: the turn budget and a deleted step (live edit) can only be stopped from the terminal.
    say(`⏸ ${p.type === 'run-turn-budget-used' ? `the run used its ${run.workflow.budget.turns} turns` : p.type}; stopping.`);
    await run.stop();
    return true;
  }

  async function askApproval(req: ToolRequest): Promise<Decision> {
    const i = req.input ?? {};
    const what = String(i.command ?? i.file_path ?? i.path ?? JSON.stringify(i)).slice(0, 200);
    const a = await ask(`? Allow ${req.tool}: ${what}  [y / n <reason>]`);
    if (a !== null && /^(y|yes)$/i.test(a)) return { behavior: 'allow' };
    const reason = a?.replace(/^(n|no)\b\s*/i, '').trim();
    return { behavior: 'deny', message: reason ? `The user said no: ${reason}` : 'The user said no.' };
  }

  async function askJudge(cond: Cond, ev: { lastText: string }): Promise<boolean> {
    // Phase 2: llm and reviewer conditions are judged by you (the real judges are Phase 6).
    say(`? You judge: ${printCond(cond)}`);
    if (ev.lastText) say(indent(ev.lastText.split('\n').slice(-15).join('\n')));
    if (o.yes) {
      say('  yes (--yes)');
      return true;
    }
    const a = await ask('y / n');
    return a !== null && /^(y|yes)$/i.test(a);
  }

  function printLive(e: EngineEvent) {
    if (e.type === 'text') say(indent(e.text));
    else if (e.type === 'tool_call') say(`  → ${e.tool} ${summary(e.input)}`);
    else if (e.type === 'refusal') say(`  ⛔ ${e.reason}`);
    else if (e.type === 'card_delivered') say(`  ▶ card delivered mid-turn: ${e.card}`);
    else if (e.type === 'error') say(`  ✗ ${e.message}`);
  }

  function printEvent(ev: RunEventRecord) {
    const d = ev.data ?? {};
    if (ev.type === 'turn_started') say(`\n── ${d.step} ──`);
    else if (ev.type === 'card_queued') say(`▶ ${d.source === 'auto' ? 'auto ' : ''}${d.kind} card queued: ${d.card}`);
    else if (ev.type === 'card_delivered' && d.channel !== 'mid-turn') say(`▶ card delivered (${d.channel}): ${d.card}`);
    else if (ev.type === 'recall' && d.skipped) say('· recall skipped: Knowl is not wired up until Phase 6');
    else if (ev.type === 'store' && d.skipped) say('· store skipped: Knowl is not wired up until Phase 6');
    else if (ev.type === 'verify_result') say(d.pass ? '✓ verify: pass' : '✗ verify: fail');
    else if (ev.type === 'loop_iteration') say(`↻ ${d.step}: attempt ${d.attempts}`);
    else if (ev.type === 'handoff') say(`· handoff to ${d.to}: summary recorded`);
    else if (ev.type === 'run_stopped') say('⏹ run stopped');
  }

  function printReceipt(r: Receipt, runId: string) {
    say('\n── Receipt ──');
    say(`workflow ${r.workflow} · ${r.status} · ${r.totalTurns} turns · ${Math.round(r.totalTimeMs / 1000)} s · $${r.totalCostUsd.toFixed(4)}`);
    say(`gates held ${r.gatesHeld} · refusals ${r.totalRefusals} (guard ${r.guardRefusals}, read-only ${r.readOnlyRefusals}) · loop attempts ${r.loopAttempts}`);
    say(`cards: live delivered ${r.liveCardsDelivered}, auto fired ${r.autoCardsFired} · verify ${r.verifyResults.passed} pass / ${r.verifyResults.failed} fail · Knowl ${r.knowlRecalls} recalls, ${r.knowlStores} stores`);
    say(`run id ${runId}`);
  }

  return { done, sigint };
}

export function loadWorkflow(file: string): { workflow?: Workflow; diagnostics: Diagnostic[]; resolveBlock: (n: string) => Workflow | undefined } {
  const blocks = new Map<string, Workflow | undefined>();
  const resolveBlock = (name: string) => {
    if (!blocks.has(name)) {
      const p = path.join(path.dirname(file), 'blocks', `${name}.reins.md`);
      blocks.set(name, fs.existsSync(p) ? parseWorkflow(fs.readFileSync(p, 'utf8')).workflow : undefined);
    }
    return blocks.get(name);
  };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e: any) {
    return { diagnostics: [{ severity: 'error', message: `cannot read the file: ${e.message}`, pos: { line: 1, col: 1 } }], resolveBlock };
  }
  const parsed = parseWorkflow(text);
  const diagnostics = [...parsed.diagnostics, ...(parsed.workflow ? validate(parsed.workflow, resolveBlock) : [])];
  const ok = parsed.workflow && !diagnostics.some((d) => d.severity === 'error');
  return { ...(ok ? { workflow: parsed.workflow } : {}), diagnostics, resolveBlock };
}

export function formatDiagnostic(file: string, d: Diagnostic): string {
  return `${file}:${d.pos.line}:${d.pos.col}: ${d.severity}: ${d.message}`;
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

function summary(input: any): string {
  if (!input || typeof input !== 'object') return '';
  return String(input.command ?? input.file_path ?? input.path ?? input.pattern ?? JSON.stringify(input)).slice(0, 160);
}

function indent(s: string): string {
  return s.replace(/\r?\n$/, '').split(/\r?\n/).map((l) => `    ${l}`).join('\n') + (s.endsWith('\n') ? '\n' : '');
}
