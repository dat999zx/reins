import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  Run, receipt,
  type Decision, type Diagnostic, type Engine, type EngineEvent, type EngineSession, type Policy,
  type RunEventRecord, type RunOptions, type SwitchOutcome, type ToolRequest, type TurnResult, type Workflow,
} from '@reins/core';
import { askTool, driveRun, questionId, runOptions, type DriveIo, type Question } from './drive.js';
import { contextSize, contextWindow, detachedRuns, readSetting, stillOverAfterCompaction, switchCheck, type SwitchCheck } from './settings.js';
import type { LogRow, SessionRow, Store } from './store.js';
import { taggedWorkflow, type Tag, type Tagged } from './tags.js';
import { loadWorkflow } from './run-cli.js';
import { FOLDER_PATH, commandsOf, folderHash, hashCommands, modelsOf } from './trust.js';

export type MakeEngine = (o: {
  model?: string; effort?: string;
  onApprove: (r: ToolRequest) => Promise<Decision>;
  onLive: (e: EngineEvent) => void;
}) => Engine;
/** The provider's view of a model, for a switch: whether its list has it, its label, and the cost estimate of switching to it at `used` tokens. */
export type DescribeModel = (engine: string, model: string, used: number | undefined) =>
  { listed: boolean; label: string; estimate?: number | undefined; source?: 'table' | 'catalog' };
export interface SessionDeps { store: Store; makeEngine: MakeEngine; dir: string; onRow?: (row: LogRow) => void; describeModel?: DescribeModel }
export type Ack = { ok: true } | { ok: false; code: 400 | 409; error: string; text?: string; diagnostics?: Diagnostic[] };
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'closed';
export type Session = ReturnType<typeof openSession>;

const PLAIN: Policy = { mode: 'write', guards: [], allowShell: true };
const OK: Ack = { ok: true };
const conflict = (error: string): Ack => ({ ok: false, code: 409, error });
const bad = (error: string, diagnostics?: Diagnostic[]): Ack => ({ ok: false, code: 400, error, ...(diagnostics ? { diagnostics } : {}) });
const IGNORED = 'This workflow sets model: or engine:. A session ignores them; pick the model in the session header.';
export const under = (file: string, root: string) => {
  const rel = path.relative(root, file);
  return rel !== '' && rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel); // a folder named "..foo" is fine
};
const real = (p: string) => {
  try { return fs.realpathSync(p); } catch { return undefined; }
};
const msg = (e: unknown) => String((e as Error)?.message ?? e);
// Already in session_log as engine rows, or (cost) in turn_ended (plan 15d 3b.3, line 1405).
const SKIPPED = new Set(['tool_call', 'refusal', 'hook', 'engine_cost']);

export function openSession(deps: SessionDeps, row: SessionRow, fresh = false) {
  const { store, dir } = deps;
  const { id, cwd } = row;

  let engine: Engine | undefined;
  let live: EngineSession | undefined;
  let opening: Promise<EngineSession | undefined> | undefined;
  let cancelOpen = false;
  let turnOpen = false;
  let notSent = false;
  let busy = false;
  let closed = false;
  let stopping = false;
  let plainActive = false;
  let closingP: Promise<void> | undefined;
  // Processes being closed: a new one is opened, or the server stops, only after these are gone (close() can take 5 s).
  let retiring: Promise<unknown> = Promise.resolve();
  // The open that is live had no stored cost total to count from, so its first reply's cost is unknown.
  let baseUnknown = false;
  // A model switch no reply has proved yet: where to go back to if the first reply fails.
  let pendingSwitch: { from: string | undefined; to: string } | undefined;
  let run: Run | undefined;
  let runId: string | undefined;
  let worker: Promise<void> = Promise.resolve();
  const queue: string[] = [];
  let intent: { kind: 'now'; text: string } | { kind: 'stop' } | undefined;
  const pending = new Map<string, { q: Question; rid?: string; resolve: (a: string | null) => void }>();
  let status: SessionStatus = (store.readLog(id).reverse().find((r) => r.type === 'status')?.data as { status: SessionStatus } | undefined)?.status ?? 'idle';

  const log = (type: string, data?: unknown, rid?: string) => {
    const r = store.appendLog(id, { type, ...(rid ? { runId: rid } : {}), ...(data !== undefined ? { data } : {}) });
    deps.onRow?.(r);
  };
  if (fresh) log('session_created', row);

  const refresh = () => {
    const next: SessionStatus = closed ? 'closed' : pending.size ? 'waiting' : busy ? 'running' : 'idle';
    if (next === status) return;
    status = next;
    log('status', { status });
  };

  const settle = (qid: string, a: string | null, why = '') => {
    const p = pending.get(qid)!;
    pending.delete(qid);
    if (a === null) log('question_closed', { questionId: qid, why }, p.rid);
    else log('answer', { questionId: qid, answer: a }, p.rid);
    p.resolve(a);
    refresh();
  };
  const closeQuestions = (why: string, kind?: Question['kind']) => {
    for (const [qid, p] of [...pending]) if (!kind || p.q.kind === kind) settle(qid, null, why);
  };

  const ask = (q: Question): Promise<string | null> => {
    if (stopping) return Promise.resolve(null);
    if (q.kind === 'tool' && !turnOpen) return Promise.resolve(null); // a late approval after its turn ended: deny, never leave it open
    log('question', q, runId);
    if (q.kind === 'tool' && store.getSession(id)!.autoApprove) {
      log('answer', { questionId: q.id, answer: 'y' }, runId);
      return Promise.resolve('y');
    }
    return new Promise((resolve) => {
      pending.set(q.id, { q, rid: runId, resolve });
      refresh();
    });
  };
  const io: DriveIo = {
    ask,
    say: (text) => log('say', { text }, runId),
    write: (chunk) => log('command_output', { chunk }, runId),
  };

  const getEngine = () => {
    if (engine) return engine;
    const cur = store.getSession(id)!; // the model can change after the session was opened
    return (engine = deps.makeEngine({
      ...(cur.model ? { model: cur.model } : {}),
      ...(cur.effort ? { effort: cur.effort } : {}),
      onApprove: (r) => askTool(io, r),
      onLive: (e) => log('engine', e, runId),
    }));
  };

  function retire(s: EngineSession) {
    const closing = s.close().catch(() => {});
    retiring = Promise.all([retiring, closing]);
  }

  function markDead(why: string) {
    const s = live;
    if (!s) return;
    live = undefined;
    log('note', { text: `Claude's session was dropped (${why}); the next message starts it again.` });
    retire(s);
  }

  /** The first reply after a switch failed: the stored model goes back, the provider's session id stays. */
  function undoSwitch(why: string) {
    const p = pendingSwitch;
    if (!p) return;
    pendingSwitch = undefined;
    store.updateSession(id, { model: p.from ?? null });
    log('settings', { model: p.from ?? '' });
    log('note', { text: `${p.to} did not answer (${why}). The model is back to ${p.from ?? 'the default'}.` });
    engine = undefined;
    if (live) {
      const s = live;
      live = undefined;
      retire(s);
    }
  }

  const describe: DescribeModel = deps.describeModel ?? ((_e, m) => ({ listed: false, label: m }));
  const limits = () => ({ tokens: readSetting(store, 'switchApprovalTokens'), usd: readSetting(store, 'switchApprovalUsd') });

  /** The one place a model switch lands (the header and a run's model step): the stored model, its row and note, and the process retired. */
  function applySwitch(from: string | undefined, to: string, label: string | undefined) {
    store.updateSession(id, { model: to || null });
    log('settings', { model: to });
    log('note', { text: `Model set to ${to ? label ?? to : 'the default'} from the next reply. The whole conversation goes to it as input.` }, runId);
    const was = pendingSwitch ? pendingSwitch.from : from;
    pendingSwitch = (to || undefined) === was ? undefined : { from: was, to };
    engine = undefined;
    if (live) {
      const s = live;
      live = undefined;
      retire(s);
    }
  }

  // ponytail: a run's model step is never refused as busy or because another run is left detached; a detached run resumed later goes on with the model stored then.
  /** A run's model step: the same rules and card as the header's switch, asked inside the run (which waits on it). */
  async function runSwitch(model: string, step: string): Promise<SwitchOutcome> {
    const cur = store.getSession(id)!;
    const used = contextSize(store.readLog(id));
    const d = describe(cur.engine, model, used);
    if ((cur.model ?? '') === model) return { to: 'same', label: d.label };
    const c = switchCheck({
      busy: false, detached: false, hasSession: !!cur.engineSessionId, used, target: model, label: d.label,
      estimate: d.estimate, ...(d.source ? { source: d.source } : {}), limits: limits(),
    });
    if (c && 'ask' in c) {
      const a = await ask({ id: questionId(), kind: 'switch', prompt: c.ask.prompt, detail: `${c.ask.detail}\nAsked by the workflow's model block \`${step}\`.` });
      if (a === null) return { to: 'closed' };
      if (a === 'stop') return { to: 'stop' };
      if (a !== 'switch') {
        const label = cur.model ? describe(cur.engine, cur.model, used).label : 'the default model';
        log('note', { text: `Kept ${label}: the steps after \`${step}\` run on it.` }, runId);
        return { to: 'kept', label };
      }
    }
    applySwitch(cur.model, model, d.label);
    return { to: 'switched', label: d.label };
  }

  /** A run start refuses a model the session's provider does not list (the session's own model excepted). */
  function unknownModel(w: Workflow, resolveBlock: (name: string) => Workflow | undefined): Ack | undefined {
    if (!deps.describeModel) return undefined;
    const cur = store.getSession(id)!;
    const m = modelsOf(w, resolveBlock).find((x) => !describe(cur.engine, x.model, undefined).listed && x.model !== cur.model);
    return m ? bad(`Unknown model ${m.model} in step \`${m.step}\`: it is not in this session's provider list.`) : undefined;
  }

  async function openEngine(): Promise<EngineSession | undefined> {
    cancelOpen = false;
    const f = folderHash(cwd);
    if (f && !store.isTrusted(cwd, FOLDER_PATH, f.hash)) {
      const a = await ask({
        id: questionId(), kind: 'trust', detail: f.detail,
        prompt: 'This folder has Claude settings that run without asking (hooks, MCP servers, allowed tools). Trust them? [y / n]',
      });
      if (a === null || !/^(y|yes)$/i.test(a)) {
        const error = stopping ? 'The session was stopped before claude started.' : "The folder's Claude settings are not trusted, so claude was not started.";
        log('note', { text: error });
        throw new Error(error);
      }
      store.trust(cwd, FOLDER_PATH, f.hash);
    }
    await retiring;
    if (cancelOpen || stopping) return undefined;
    const sid = store.getSession(id)!.engineSessionId;
    // A new session counts from 0; a resumed one from the total stored for its id, and without one (a session
    // from before the cost table) its first reply's cost is unknown.
    const base = sid ? store.getEngineTotal(sid) : 0;
    baseUnknown = base === undefined;
    const s = await getEngine().open({
      cwd, ...(sid ? { sessionId: sid } : {}),
      ...(base !== undefined ? { costBase: base } : {}),
      policy: () => run?.policy() ?? PLAIN,
      pendingCards: () => (run ? run.takeCards() : queue.splice(0)),
    });
    live = s;
    return cancelOpen || stopping ? undefined : s;
  }
  const ensureEngine = (): Promise<EngineSession | undefined> =>
    live ? Promise.resolve(live) : (opening ??= openEngine().finally(() => { opening = undefined; }));

  /** One engine call (a reply or a compaction): the process, the cost total, the unknown-cost note, a failed switch. */
  async function call(f: (s: EngineSession) => Promise<TurnResult>): Promise<TurnResult> {
    notSent = false;
    const s = await ensureEngine();
    if (!s) { notSent = true; return { text: '', events: [] }; }
    let res: TurnResult;
    turnOpen = true;
    try {
      res = await f(s);
    } catch (e) {
      markDead(msg(e));
      undoSwitch(msg(e));
      throw e;
    } finally {
      turnOpen = false;
      closeQuestions('the turn ended', 'tool');
    }
    if (res.total !== undefined) store.putEngineTotal(s.sessionId, res.total);
    // ponytail: a session from before the cost table shows its first reply's cost as unknown; a switch to Default has no price, so with a context it asks with the switch card.
    if (baseUnknown && res.total !== undefined) {
      baseUnknown = false;
      if (res.cost === undefined) log('note', { text: "This reply's cost is not known: the session began before Reins kept the provider's running total. Later replies are counted." });
    }
    const err = res.events?.find((e) => e.type === 'error');
    if (err && err.type === 'error') markDead(err.message);
    else if (!store.getSession(id)!.engineSessionId) store.updateSession(id, { engineSessionId: s.sessionId });
    if (pendingSwitch) {
      if (res.isError) undoSwitch(res.text || err?.message || 'the reply was an error');
      else if (!err) pendingSwitch = undefined;
    }
    return res;
  }

  const compactCall = (s: EngineSession) => s.compact!();

  /** Compresses first when the known context is at or over autoCompressAt of the window; the reply's cost then includes the compaction's. */
  // ponytail: the window is the stream's (the usage row's); a model whose window is only in the catalog never auto-compresses; the compaction's cost is added to the reply it preceded.
  async function turnWithAutoCompress(text: string): Promise<TurnResult> {
    const s = await ensureEngine(); // the check needs s.compact
    if (!s) { notSent = true; return { text: '', events: [] }; } // a Stop landed while the engine opened
    let pre: TurnResult | undefined;
    if (s.compact) {
      const rows = store.readLog(id);
      const used = contextSize(rows);
      const w = contextWindow(rows);
      const at = readSetting(store, 'autoCompressAt');
      if (at < 1 && used !== undefined && w !== undefined && used >= w * at) {
        const pct = Math.round(at * 100);
        if (stillOverAfterCompaction(rows, w * at)) {
          log('note', { text: `The context is still at or over ${pct}% of the window after compressing, so Reins does not compress again before this reply.` }, runId);
        } else {
          log('note', { text: `The context, ${used.toLocaleString('en-US')} tokens, is at or over ${pct}% of the ${w.toLocaleString('en-US')}-token window: compressing before the next reply.` }, runId);
          pre = await call(compactCall);
          // A Stop during the compaction interrupted it: do not send the reply. A now card still gets its turn.
          if (stopping || intent?.kind === 'stop' || run?.stopHeld) {
            return { text: '', events: [], ...(pre.cost !== undefined ? { cost: pre.cost } : {}), ...(pre.total !== undefined ? { total: pre.total } : {}) };
          }
        }
      }
    }
    // The compaction's cost reaches the log even when the reply does not: its own row has no runId, so it is no turn of a run.
    const lost = () => { if (pre?.cost !== undefined) log('turn_ended', { text: '', cost: pre.cost }); };
    let res: TurnResult;
    try {
      res = await call((x) => x.turn(text));
    } catch (e) {
      lost();
      throw e;
    }
    if (notSent && pre) { lost(); return res; }
    const cost = pre?.cost === undefined ? res.cost : (res.cost ?? 0) + pre.cost;
    return cost === undefined || cost === res.cost ? res : { ...res, cost };
  }

  const lent: EngineSession = {
    get sessionId() { return live?.sessionId ?? store.getSession(id)?.engineSessionId ?? ''; },
    turn: turnWithAutoCompress,
    async compact() {
      const s = await ensureEngine();
      if (s && !s.compact) throw new Error('This provider cannot compress.'); // a healthy process: no markDead, no undoSwitch
      return call(compactCall);
    },
    async interrupt() {
      if (turnOpen && live) await live.interrupt();
    },
    events: { async *[Symbol.asyncIterator]() {} },
    async close() {},
  };

  const unsent = () => {
    const cards = queue.splice(0);
    if (cards.length) log('cards_unsent', { cards });
  };

  // A stop replaces a pending now, and that now goes to the queue (plan 15d 1293-1297). Returns the interrupt in flight, if this call sent it.
  // Only a stop cancels an engine that is still opening; a now card waits for the turn, so the text it interrupts is never dropped.
  const stopOpening = () => { if (opening) cancelOpen = true; };

  function applyStop(): Promise<void> | undefined {
    stopOpening();
    if (intent?.kind === 'stop') return undefined;
    const had = intent;
    if (had) queue.push(had.text);
    intent = { kind: 'stop' };
    return had ? undefined : lent.interrupt().catch(() => {});
  }

  function route(text: string, kind: 'steer' | 'now' | 'stop') {
    if (kind === 'stop') stopOpening();
    if (run) {
      run.queueCard(text, kind);
      // The run logs card_queued before it stores the card, so its own snapshot save misses it (spec 1322).
      store.saveSnapshot(runId!, run.snapshot());
      return;
    }
    log('card_queued', { card: text, kind });
    // No plain turn is open (a file-trust question, say): nothing to interrupt, so a now card waits like a steer card and moves into the run.
    if (!plainActive) { if (kind !== 'stop') queue.push(text); }
    else if (kind === 'steer') queue.push(text);
    else if (kind === 'stop') void applyStop();
    else if (intent) queue.push(text);
    else {
      intent = { kind: 'now', text };
      void lent.interrupt().catch(() => {});
    }
  }

  async function plainTurn(text: string, compact = false): Promise<boolean> {
    let res: TurnResult;
    try {
      res = await (compact ? lent.compact!() : lent.turn(text));
    } catch (e) {
      log('turn_failed', { error: msg(e) });
      return false;
    }
    if (!notSent) log('turn_ended', { text: res.text, cost: res.cost });
    return true;
  }

  /** `compress`: the first turn is a compaction instead of a reply to `first`; cards queued meanwhile follow as usual. */
  async function plainLoop(first: string, carried = false, compress = false) {
    plainActive = true;
    try {
      let text = first;
      let compact = compress;
      if (carried) log('message', { role: 'user', text, fromCards: true });
      for (;;) {
        const ok = await plainTurn(text, compact);
        compact = false;
        const it = intent;
        intent = undefined;
        if (!ok || stopping || it?.kind === 'stop') {
          if (it?.kind === 'now') queue.unshift(it.text);
          return unsent();
        }
        let next: string | undefined;
        if (it) {
          log('card_delivered', { card: it.text, channel: 'interrupt' });
          next = [it.text, ...queue.splice(0)].join('\n\n');
        } else if (queue.length) {
          next = queue.splice(0).join('\n\n');
        }
        if (next === undefined) return;
        log('message', { role: 'user', text: next, fromCards: true });
        text = next;
      }
    } finally {
      plainActive = false;
    }
  }

  const logRunEvent = (ev: RunEventRecord, rid: string) => {
    if (SKIPPED.has(ev.type) || (ev.type === 'card_delivered' && ev.data?.channel === 'mid-turn')) return;
    log(ev.type, ev.data, rid);
  };

  /** Runs `make` to its end. Returns the text of the next plain turn (leftover cards of a run that ended `done`), if any. */
  async function execute(
    rid: string, wf: Workflow, resolveBlock: (name: string) => Workflow | undefined, make: (o: RunOptions) => Run,
  ): Promise<string | undefined> {
    runId = rid;
    const opts = runOptions(io, {
      workflow: wf, engine: getEngine(), cwd, resolveBlock, session: lent, switchModel: runSwitch,
      onEvent: (ev) => {
        store.appendEvent(rid, ev);
        if (run) store.saveSnapshot(rid, run.snapshot());
        logRunEvent(ev, rid);
      },
    });
    const r = make(opts);
    run = r;
    for (const c of queue.splice(0)) r.queueCard(c, 'steer');
    const save = () => store.saveSnapshot(rid, r.snapshot());
    save();
    const out = await driveRun(r, io, save);
    if (out.error) markDead(out.error);
    closeQuestions('the run ended');
    const cards = out.result === 'detached' ? [] : r.takeCards();
    run = undefined;
    runId = undefined;
    if (out.result === 'detached') {
      log('run_detached', out.error ? { error: out.error } : {}, rid);
      unsent();
      return undefined;
    }
    log('receipt', receipt(r.getEvents()), rid);
    const all = [...cards, ...queue.splice(0)];
    if (r.status === 'done' && !stopping && all.length) return all.join('\n\n');
    if (all.length) log('cards_unsent', { cards: all });
    return undefined;
  }

  async function taggedRun(t: Extract<Tagged, { ok: true }>) {
    const rid = randomBytes(4).toString('hex');
    const file = path.join(dir, 'runs', `${rid}.reins.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, t.text);
    store.createRun({ id: rid, workflowPath: file, cwd });
    return execute(rid, t.workflow, () => undefined, (o) => {
      const r = new Run(o);
      for (const w of t.warnings) log('note', { text: w.message }, rid); // spec 1480: warnings go to the log, only errors refuse
      return r;
    });
  }

  async function trustedCommands(file: string, w: Workflow, resolveBlock: (n: string) => Workflow | undefined) {
    const cmds = commandsOf(w, resolveBlock);
    const hash = hashCommands(cmds);
    if (store.isTrusted(cwd, file, hash)) return true;
    const a = await ask({
      id: questionId(), kind: 'trust', detail: cmds.join('\n'),
      prompt: 'This workflow runs the commands below on your machine. Trust it? [y / n]',
    });
    if (a === null || !/^(y|yes)$/i.test(a)) {
      log('note', { text: stopping ? 'The session was stopped before the workflow started.' : 'The workflow is not trusted, so it did not run.' });
      unsent();
      return false;
    }
    store.trust(cwd, file, hash);
    return true;
  }

  function runFile(p: string): Ack {
    if (closingP) return closingAck();
    if (busy) return conflict('The session is busy.');
    const file = real(path.resolve(cwd, p)); // a relative path is relative to the session folder
    if (!file) return bad(`Cannot read ${p}.`);
    const roots = [cwd, path.join(dir, 'workflows')].map(real);
    if (!roots.some((r) => r && under(file, r))) return bad('The workflow must be under the session folder or ~/.reins/workflows.');
    const runs = real(path.join(dir, 'runs'));
    if (runs && under(file, runs)) return bad('~/.reins/runs holds generated files; run a workflow from your folder or ~/.reins/workflows.'); // /resume skips trust for these
    const loaded = loadWorkflow(file);
    const w = loaded.workflow;
    if (!w) return bad(loaded.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message).join('; ') || 'Invalid workflow.', loaded.diagnostics);
    const unknown = unknownModel(w, loaded.resolveBlock);
    if (unknown) return unknown;
    begin();
    start(async () => {
      if (!(await trustedCommands(file, w, loaded.resolveBlock))) return;
      const rid = randomBytes(4).toString('hex');
      store.createRun({ id: rid, workflowPath: file, cwd });
      const carry = await execute(rid, w, loaded.resolveBlock, (o) => {
        const r = new Run(o);
        if (w.model || w.engine) log('note', { text: IGNORED }, rid);
        return r;
      });
      if (carry) await plainLoop(carry, true);
    });
    return OK;
  }

  const ended = (rid: string) => store.readLog(id).some((r) => r.runId === rid && (r.type === 'run_finished' || r.type === 'run_stopped'));

  function resume(rid: string): Ack {
    if (closingP) return closingAck();
    if (busy) return conflict('The session is busy.');
    if (store.sessionOfRun(rid) !== id) return conflict(`Run ${rid} does not belong to this session.`);
    if (ended(rid)) return conflict(`Run ${rid} has already ended.`);
    const saved = store.loadRun(rid);
    if (!saved?.snapshot) return conflict(`Run ${rid} has no saved state.`);
    const snapshot = saved.snapshot;
    const w = snapshot.workflow;
    const tagged = path.resolve(saved.workflowPath) === path.resolve(dir, 'runs', `${rid}.reins.md`); // exactly the file taggedRun wrote
    const { resolveBlock } = loadWorkflow(saved.workflowPath);
    const unknown = unknownModel(w, resolveBlock);
    if (unknown) return unknown;
    begin();
    start(async () => {
      if (!tagged && !(await trustedCommands(saved.workflowPath, w, resolveBlock))) return;
      const carry = await execute(rid, w, resolveBlock, (o) => {
        const r = Run.restore(snapshot, o);
        log('note', { text: `Resumed run ${rid}.${w.model || w.engine ? ` ${IGNORED}` : ''}` }, rid);
        // The session's model may have changed since the run's last model step (another run, a detached header switch).
        const chose = [...snapshot.events].reverse().find((e) => e.type === 'model_switched' && (e.data?.how === 'switched' || e.data?.how === 'same'));
        const cur = store.getSession(id)!;
        if (chose && chose.data.model !== (cur.model ?? '')) {
          const now = cur.model ? describe(cur.engine, cur.model, undefined).label : 'the default model';
          log('note', { text: `This run's model block chose ${chose.data.label ?? chose.data.model}; the session is on ${now}, so the next steps run on it.` }, rid);
        }
        return r;
      });
      if (carry) await plainLoop(carry, true);
    });
    return OK;
  }

  function begin() {
    busy = true;
    closed = false;
    stopping = false;
    intent = undefined;
    closeQuestions('work started before it was answered', 'switch'); // after busy: closing it earlier would log an idle between waiting and running
    refresh();
  }
  function start(work: () => Promise<void>) {
    worker = work()
      .catch((e) => { log('note', { text: `Internal error: ${msg(e)}` }); unsent(); })
      .finally(() => {
        busy = false;
        run = undefined;
        runId = undefined;
        closeQuestions('the work ended');
        refresh();
      });
  }

  const closingAck = () => conflict('The session is closing.');

  // A plain turn from the input box (fromCards false) or from a card typed while idle (true; spec 1557).
  function startPlain(text: string, fromCards: boolean): Ack {
    begin();
    log('message', { role: 'user', text, ...(fromCards ? { fromCards: true } : {}) });
    start(() => plainLoop(text));
    return OK;
  }

  // The word /compress is Reins' command; what the provider is sent is its own engine's business.
  function compress(): Ack {
    if (closingP) return closingAck();
    if (busy) return conflict('Compress when the session is idle.');
    if (detachedRuns(store.readLog(id)).length > 0) return conflict('A run is left paused in this session. Resume or stop it before compressing.');
    if (!store.getSession(id)!.engineSessionId) return conflict('Nothing to compress yet: send a message first.');
    begin();
    log('message', { role: 'user', text: '/compress' });
    start(() => plainLoop('', false, true));
    return OK;
  }

  function message(text: string, tags: Tag[] = []): Ack {
    if (closingP) return closingAck();
    if (tags.length) {
      if (busy) return conflict('The session is busy; tags start a new run, so wait until it is idle.');
      const t = taggedWorkflow(text, tags);
      if (!t.ok) {
        return { ok: false, code: 400, error: t.error, ...(t.text ? { text: t.text } : {}), ...(t.diagnostics ? { diagnostics: t.diagnostics } : {}) };
      }
      begin();
      log('message', { role: 'user', text, tags });
      start(async () => {
        const carry = await taggedRun(t);
        if (carry) await plainLoop(carry, true);
      });
      return OK;
    }
    if (busy) { route(text, 'steer'); return OK; }
    return startPlain(text, false);
  }

  function card(text: string, kind: 'steer' | 'now' | 'stop'): Ack {
    if (closingP) return closingAck();
    if (!busy) {
      if (kind !== 'stop') return startPlain(text, true);
      const sq = [...pending].find(([, p]) => p.q.kind === 'switch');
      if (!sq) return conflict('Nothing is running, so there is nothing to stop.');
      settle(sq[0], 'keep'); // the Composer shows Stop while the session waits
      return OK;
    }
    const oldest = [...pending.values()][0];
    if (kind === 'stop' && oldest) {
      const k = oldest.q.kind;
      if (k === 'tool' || k === 'judge') route(text, 'stop');
      else if (k === 'trust' && run) void run.stop();
      settle(oldest.q.id, 'stop');
      return OK;
    }
    route(text, kind);
    return OK;
  }

  function answer(qid: string, a: string): Ack {
    if (!pending.has(qid)) return conflict(`Question ${qid} is not open.`);
    settle(qid, a);
    return OK;
  }

  /**
   * `estimate` and `label` describe the target model (the server knows the provider's prices; the session does not).
   * A model switch retires the process; the next reply opens `--resume <same id>` on the new model (F1).
   */
  function settings(p: { autoApprove?: boolean; title?: string; model?: string; estimate?: number | undefined; label?: string; source?: 'table' | 'catalog' }): Ack {
    const from = store.getSession(id)!.model;
    const switching = p.model !== undefined && p.model !== (from ?? '');
    let check: SwitchCheck;
    if (switching) {
      if (closingP) return closingAck();
      if ([...pending.values()].some((x) => x.q.kind === 'switch')) return conflict('Answer the switch question first.');
      check = switchCheck({
        busy, detached: detachedRuns(store.readLog(id)).length > 0, hasSession: !!store.getSession(id)!.engineSessionId,
        used: contextSize(store.readLog(id)), target: p.model!, ...(p.label !== undefined ? { label: p.label } : {}),
        estimate: p.estimate, ...(p.source !== undefined ? { source: p.source } : {}),
        limits: limits(),
      });
      if (check && 'refuse' in check) return conflict(check.refuse);
    }
    const patch = { ...(p.autoApprove !== undefined ? { autoApprove: p.autoApprove } : {}), ...(p.title !== undefined ? { title: p.title } : {}) };
    if (Object.keys(patch).length) {
      store.updateSession(id, patch);
      log('settings', patch);
    }
    if (switching) {
      const to = p.model!;
      // ponytail: a switch card waits with no timeout; any new work closes it without switching; a server stop leaves it to recover.ts.
      if (check && 'ask' in check) void ask({ id: questionId(), kind: 'switch', ...check.ask }).then((a) => { if (a === 'switch') applySwitch(from, to, p.label); });
      else applySwitch(from, to, p.label);
    }
    return OK;
  }

  // While it runs, message, card, /run and /resume are 409, so no turn can start between the stop and the engine closing.
  async function endSession() {
    closeQuestions('the session was closed', 'switch');
    if (busy) {
      stopping = true;
      const stopped = run ? run.stop() : applyStop();
      closeQuestions('the session was closed');
      await stopped;
      await worker;
    }
    await live?.close().catch(() => {});
    live = undefined;
    await retiring;
    if (status === 'closed') return;
    closed = true;
    log('closed', {});
    refresh();
  }
  const close = () => (closingP ??= endSession().finally(() => { closingP = undefined; }));

  // Server stop. Only a gate, budget, usd, switch or resume question detaches a run (driveRun returns on its null answer;
  // a run's switch closed this way pauses it at its model step). Anything else, a tool or judge question or a turn in
  // flight, is stopped first, or the run would go on with the next step.
  // ponytail: a RUN command in flight is waited for, as in /close; there is no cancel.
  async function shutdown() {
    if (busy) {
      stopping = true;
      const detaches = [...pending.values()].some((p) => ['gate', 'budget', 'resume', 'switch', 'usd'].includes(p.q.kind));
      const stopped = detaches ? undefined : run ? run.stop() : applyStop();
      closeQuestions('the server stopped');
      await stopped;
      await worker;
    }
    await live?.close().catch(() => {});
    live = undefined;
    await retiring;
  }

  return {
    id,
    info: () => store.getSession(id)!,
    status: () => status,
    message, card, answer, settings, compress, runFile, resume, close, shutdown,
    idle: () => worker,
  };
}
