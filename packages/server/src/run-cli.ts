import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import {
  Run, NODES, parseWorkflow, showText, validate, receipt, UNKNOWN_MARK, unpricedWords,
  type Decision, type Diagnostic, type Engine, type EngineEvent, type Receipt,
  type RunEventRecord, type RunStatus, type SubagentOpen, type SubagentOpened, type ToolRequest, type Workflow,
} from '@reins/core';
import { askTool, driveRun, indent, runOptions, type DriveIo } from './drive.js';
import { shownStep } from './trackKey.js';
import { StreamRedactor, type Redactor } from './secrets.js';
import type { Store } from './store.js';

export interface RunCliOptions {
  /** The workflow file; not needed with resumeId. */
  file?: string;
  resumeId?: string;
  cwd: string;
  input: Readable;
  output: Writable;
  store: Store;
  makeEngine: (io: { onApprove: (r: ToolRequest) => Promise<Decision>; onLive: (e: EngineEvent) => void }) => Engine;
  /** The run-start checks (spec 10.2) for the loaded workflow: the words of the first that fails, or none. Nothing is created or spent before it. */
  refuse?: (w: Workflow, resolveBlock: (name: string) => Workflow | undefined) => string | undefined;
  /** A subagent's own engine on the provider its step names (spec 10.3), or the words it cannot start with. None: the run's own engine opens it. */
  subagentEngine?: (s: SubagentOpen, io: { onApprove: (r: ToolRequest) => Promise<Decision>; onLive: (e: EngineEvent) => void }) =>
    { engine: Engine; model?: string; /** Same meaning as `fullDetail`, for this subagent's provider. */ fullDetail?: boolean } | { error: string };
  /** Approve gates and terminal judge questions without asking. Never touches guards or tool approvals. */
  yes?: boolean;
  /** Everything written to `output` passes through this (the secrets redactor). None = written as given. */
  redactor?: Pick<Redactor, 'redact' | 'safeLength'>;
  /**
   * The engine is one Reins runs itself (the API agent loop): every tool approval prints its COMPLETE detail under the question, even a short path
   * (its content is in the detail). The CLI provider's approvals keep the recorded transcript (the detail only when the line was cut or escaped).
   */
  fullDetail?: boolean;
  /** What workflow commands run with (`shellEnvFrom(...)`), worked out when each starts; none = this process's. */
  env?: () => NodeJS.ProcessEnv;
  /** `kindVersions(mods)`: saved with the run and compared on `--resume`. None = no check. */
  kinds?: Record<string, string>;
}

// A partial line that has not seen its newline is written once it is this long. It is already redacted by then, so the cut is safe.
const LINE_MAX = 64 * 1024;

export interface RunCliResult {
  runId: string;
  status: RunStatus | 'invalid';
  exitCode: number;
  receipt?: Receipt;
}

/** `reins run` in the terminal (plan 15b 2.6). */
export function startRunCli(o: RunCliOptions): { done: Promise<RunCliResult>; sigint: () => void } {
  // The one place output leaves `reins run`: `say` and command output both end here, so both are redacted.
  const hide = (s: string) => (o.redactor ? o.redactor.redact(s) : s);
  const sink = (s: string) => { o.output.write(hide(s)); };
  // Command output comes in chunks that can cut a key in two. The stream redactor holds back only the end of a chunk that could be the
  // start of a key; what it lets through is redacted BEFORE `indent` (which would put spaces inside a multi-line key) and is
  // written in whole lines.
  const stream = o.redactor ? new StreamRedactor(o.redactor) : undefined;
  let line = '';
  const flushLine = () => {
    if (!line) return;
    sink(indent(line));
    line = '';
  };
  // ponytail: a held key start is written after a `say` that came in between, and a physical line over 64 KB gets a second indent for its
  // continuation (cosmetic); the sink redacts already-redacted output again (a key whose value looks like a `[key NAME]` marker would be wrapped twice).
  // Everything that is SAID (diagnostics, the agent's events, errors, questions) shows control, direction and zero-width characters as <U+XXXX>;
  // a command's own output (`writeOutput`) is the user's program talking and is written as it is.
  const say = (s: string) => {
    flushLine();               // a partial line only; what the stream redactor holds (a possible key start) stays held
    sink(showText(hide(s), { lines: true }) + '\n');   // keys are hidden on the original text, then it is escaped
  };
  const writeOutput = (s: string) => {
    line += stream ? stream.push(s) : s;
    const nl = line.lastIndexOf('\n');
    if (nl >= 0) {
      sink(indent(line.slice(0, nl + 1)));
      line = line.slice(nl + 1);
    }
    if (line.length > LINE_MAX) flushLine();
  };
  /** The output is over (a command ended, or the run did): everything held goes out. */
  const endOutput = () => {
    if (stream) line += stream.end();
    flushLine();
  };

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
  // `below`: the whole of what the question is about, under it (a command the prompt line had to cut or escape).
  const ask = (q: string, below?: string): Promise<string | null> => {
    if (eof) {
      say(q);
      if (below !== undefined) say(indent(below));
      return Promise.resolve(null);
    }
    // Wait for the answer before printing the question: piped input can answer within the write.
    const answer = new Promise<string | null>((resolve) => asks.push(resolve));
    say(q);
    if (below !== undefined) say(indent(below));
    return answer;
  };

  const io: DriveIo = {
    ask: (q) => {
      if (o.yes && q.kind === 'gate') { say('  approved (--yes)'); return Promise.resolve('approve'); }
      if (o.yes && q.kind === 'judge') { say('  yes (--yes)'); return Promise.resolve('y'); }
      // A branch's pause says whose it is, so two at once can be told apart; a tool question keeps its old words.
      return ask(q.title && q.kind !== 'tool' ? `[${q.title}] ${q.prompt}` : q.prompt, q.kind === 'tool' && q.long && q.detail !== undefined ? q.detail : undefined);
    },
    say,
    redact: hide,
    write: writeOutput,
    endOutput,
    cancel: (why) => {
      const waiting = asks.splice(0);
      if (!waiting.length) return;   // nothing waiting: nothing printed, so a run without branches ends with the same bytes as before
      say(`${waiting.length} waiting question${waiting.length === 1 ? '' : 's'} cancelled: ${why}`);
      for (const a of waiting) a(null);
    },
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
      endOutput();
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
    const refused = o.refuse?.(workflow, loaded.resolveBlock);
    if (refused) {
      say(refused);
      return { runId, status: 'invalid', exitCode: 1 };
    }

    const cwd = o.cwd;
    const engine = o.makeEngine({ onApprove: (r) => askTool(io, r, undefined, o.fullDetail), onLive: printLive });
    const openSubagent = o.subagentEngine && (async (s: SubagentOpen): Promise<SubagentOpened> => {
      let subFull: boolean | undefined; // known once the subagent's engine is made, before it can ask anything
      const made = o.subagentEngine!(s, { onApprove: (r) => askTool(io, r, s.asks ?? `Subagent ${s.title} (\`${s.step}\`)`, subFull), onLive: printLive });
      if (!('error' in made)) subFull = made.fullDetail;
      if ('error' in made) throw new Error(made.error);
      const { step: _s, title: _t, asks: _a, reasoning, model: _m, ...open } = s;
      const session = await made.engine.open({ ...open, ...(made.model && s.model ? { model: made.model } : {}), ...(reasoning ? { effort: reasoning } : {}), pendingCards: () => [] });
      return { session, ...(made.model ? { model: made.model, label: made.model } : {}) };
    });
    const runOpts = runOptions(io, {
      workflow, engine, cwd, resolveBlock: loaded.resolveBlock,
      ...(openSubagent ? { openSubagent } : {}),
      ...(o.env ? { env: o.env } : {}),
      ...(o.kinds ? { kinds: o.kinds } : {}),
      onEvent: (ev) => {
        o.store.appendEvent(runId, ev);
        if (run) o.store.saveSnapshot(runId, run.snapshot());
        printEvent(ev);
      },
    });

    if (snapshot) {
      run = Run.restore(snapshot, runOpts);
      say(`Reins · resuming run ${runId} · playbook "${workflow.name}" · ${cwd}`);
    } else {
      o.store.createRun({ id: runId, workflowPath: file, cwd });
      say(`Reins · run ${runId} · playbook "${workflow.name}" · ${cwd}`);
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
    for (const n of NODES.values()) {
      const line = n.print && Object.hasOwn(n.print, ev.type) ? n.print[ev.type]?.(d) : undefined;
      if (line !== undefined) { say(line); return; }
    }
    if (ev.type === 'turn_started') say(`\n── ${d.step} ──`);
    else if (ev.type === 'card_queued') say(`▶ ${d.source === 'auto' ? 'auto ' : ''}${d.kind} card queued: ${d.card}`);
    else if (ev.type === 'card_delivered' && d.channel !== 'mid-turn') say(`▶ card delivered (${d.channel}): ${d.card}`);
    else if (ev.type === 'subagent_started') say(`· ${d.step}: subagent ${d.title} ${d.resumed ? 'resumed' : 'started'} on ${d.label ?? d.model ?? "the CLI's model"}`);
    else if (ev.type === 'subagent_result') say(`· ${d.step}: handed back its result ($${Number(d.cost ?? 0).toFixed(4)}${d.unknown === true ? UNKNOWN_MARK : ''})`);
    else if (ev.type === 'budget_warning') say(`· ${d.text}`);
    else if (ev.type === 'track_started') say(`track ${shownStep(String(d.track))} started (${d.title})`);
    else if (ev.type === 'track_ended') say(`track ${shownStep(String(d.track))} ended (${d.title}) $${Number(d.cost ?? 0).toFixed(4)}`);
    else if (ev.type === 'run_stopped') say('⏹ run stopped');
  }

  function printReceipt(r: Receipt, runId: string) {
    say('\n── Receipt ──');
    say(`playbook ${r.workflow} · ${r.status} · ${r.totalTurns} turns · ${Math.round(r.totalTimeMs / 1000)} s · $${r.totalCostUsd.toFixed(4)}${r.unpricedTurns ? UNKNOWN_MARK : ''}`);
    if (r.unpricedTurns) say(unpricedWords(r.unpricedTurns));
    if (r.models) {
      const split = r.models.map((m) => `${m.model} $${m.usd.toFixed(4)}${m.unknown ? UNKNOWN_MARK : ''} (${m.turns} turn${m.turns === 1 ? '' : 's'})`).join(' · ');
      say(`models ${split}${r.unsplitUsd ? ` · not split by model $${r.unsplitUsd.toFixed(4)}` : ''}`);
    }
    if (r.subagents) say(`subagents ${r.subagents.map((s) => `${s.title} $${s.usd.toFixed(4)}${s.unknown ? UNKNOWN_MARK : ''} (${s.turns} turn${s.turns === 1 ? '' : 's'})`).join(' · ')}`);
    say(`gates held ${r.gatesHeld} · refusals ${r.totalRefusals} (guard ${r.guardRefusals}, read-only ${r.readOnlyRefusals}) · loop attempts ${r.loopAttempts}`);
    say(`cards: live delivered ${r.liveCardsDelivered}, auto fired ${r.autoCardsFired} · verify ${r.verifyResults.passed} pass / ${r.verifyResults.failed} fail · Knowl ${r.knowlRecalls} recalls, ${r.knowlStores} stores${r.knowlSkipped ? `, ${r.knowlSkipped} skipped` : ''}`);
    if (r.counts) say(Object.entries(r.counts).map(([k, n]) => `${k} ${n}`).join(' · '));
    say(`run id ${runId}`);
  }

  return { done, sigint };
}

type Loaded = { workflow?: Workflow; diagnostics: Diagnostic[]; resolveBlock: (n: string) => Workflow | undefined };

export function loadWorkflow(file: string): Loaded {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e: any) {
    return { diagnostics: [{ severity: 'error', message: `cannot read the file: ${e.message}`, pos: { line: 1, col: 1 } }], resolveBlock: blockResolver(file) };
  }
  return loadWorkflowText(text, file);
}

export function loadWorkflowText(text: string, file: string): Loaded {
  const resolveBlock = blockResolver(file);
  const parsed = parseWorkflow(text);
  const diagnostics = [...parsed.diagnostics, ...(parsed.workflow ? validate(parsed.workflow, resolveBlock) : [])];
  const ok = parsed.workflow && !diagnostics.some((d) => d.severity === 'error');
  return { ...(ok ? { workflow: parsed.workflow } : {}), diagnostics, resolveBlock };
}

/** The longest block file Reins reads (bytes), and what a block's name may be: one plain file name, no path. */
const BLOCK_MAX = 100_000;
const BLOCK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;   // Windows opens these as devices, whatever the extension

/**
 * The file `<name>.reins.md` in the `blocks/` folder next to the workflow. Undefined: no such file. Throws, with the reason in plain words, for a name that is not a plain
 * file name, a file that is not a plain file inside the folder (a link out of it, a folder), one over `BLOCK_MAX`, or text that is not a workflow. What the parser said
 * about the file goes on the result as `problems`, so a playbook can show it.
 */
function readBlock(dir: string, name: string): Workflow | undefined {
  if (typeof name !== 'string' || !BLOCK_NAME.test(name) || DEVICE_NAME.test(name)) throw new Error('its name must be one plain file name (letters, digits, - _ and . only), not a path');
  const p = path.join(dir, `${name}.reins.md`);
  if (!fs.existsSync(p)) return undefined;
  const real = fs.realpathSync(p);
  const inside = path.join(fs.realpathSync(dir), path.sep);
  if (!real.startsWith(inside) || path.dirname(real) !== inside.slice(0, -1)) throw new Error('the file is a link to somewhere outside the blocks folder');
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error('it is not a file');
  if (st.size > BLOCK_MAX) throw new Error(`the file is larger than ${BLOCK_MAX / 1000} KB`);
  const parsed = parseWorkflow(fs.readFileSync(real, 'utf8'));
  if (!parsed.workflow) throw new Error(`the file is not a playbook${parsed.diagnostics[0] ? `: ${parsed.diagnostics[0].message}` : ''}`);
  return parsed.diagnostics.length ? { ...parsed.workflow, problems: parsed.diagnostics } : parsed.workflow;
}

function blockResolver(file: string) {
  const blocks = new Map<string, Workflow | undefined>();
  const dir = path.join(path.dirname(file), 'blocks');
  const resolveBlock = (name: string) => {
    if (!blocks.has(name)) blocks.set(name, readBlock(dir, name));   // a throw is not remembered: the next call reads again
    return blocks.get(name);
  };
  return resolveBlock;
}

export function formatDiagnostic(file: string, d: Diagnostic): string {
  return `${file}:${d.pos.line}:${d.pos.col}: ${d.severity}: ${d.message}`;
}

function summary(input: any): string {
  if (!input || typeof input !== 'object') return '';
  return String(input.command ?? input.file_path ?? input.path ?? input.pattern ?? JSON.stringify(input)).slice(0, 160);
}
