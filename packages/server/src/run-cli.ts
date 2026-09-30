import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import {
  Run, parseWorkflow, validate, receipt,
  type Decision, type Diagnostic, type Engine, type EngineEvent, type Receipt,
  type RunEventRecord, type RunStatus, type ToolRequest, type Workflow,
} from '@reins/core';
import { askTool, driveRun, indent, runOptions, type DriveIo } from './drive.js';
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

  const io: DriveIo = {
    ask: (q) => {
      if (o.yes && q.kind === 'gate') { say('  approved (--yes)'); return Promise.resolve('approve'); }
      if (o.yes && q.kind === 'judge') { say('  yes (--yes)'); return Promise.resolve('y'); }
      return ask(q.prompt);
    },
    say,
    write: (s) => o.output.write(indent(s)),
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
      const sid = o.store.sessionOfRun(o.resumeId);
      if (sid) {
        say(`run ${o.resumeId} belongs to chat session ${sid}; resume it from the app`);
        return { runId: o.resumeId, status: 'invalid', exitCode: 1 };
      }
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
    const engine = o.makeEngine({ onApprove: (r) => askTool(io, r), onLive: printLive, workflow });
    const runOpts = runOptions(io, {
      workflow, engine, cwd, resolveBlock: loaded.resolveBlock,
      onEvent: (ev) => {
        o.store.appendEvent(runId, ev);
        if (run) o.store.saveSnapshot(runId, run.snapshot());
        printEvent(ev);
      },
    });

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

    const active = run;
    const { result } = await driveRun(active, io, () => o.store.saveSnapshot(runId, active.snapshot()));
    if (result === 'detached') {
      say(`The run is saved. Resume it with: reins run --resume ${runId}`);
      return { runId, status: active.status, exitCode: 1 };
    }
    const r = receipt(active.getEvents());
    printReceipt(r, runId);
    return { runId, status: active.status, exitCode: active.status === 'done' ? 0 : 1, receipt: r };
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
    say(`cards: live delivered ${r.liveCardsDelivered}, auto fired ${r.autoCardsFired} · verify ${r.verifyResults.passed} pass / ${r.verifyResults.failed} fail · Knowl ${r.knowlRecalls} recalls, ${r.knowlStores} stores${r.knowlSkipped ? `, ${r.knowlSkipped} skipped` : ''}`);
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

function summary(input: any): string {
  if (!input || typeof input !== 'object') return '';
  return String(input.command ?? input.file_path ?? input.path ?? input.pattern ?? JSON.stringify(input)).slice(0, 160);
}
