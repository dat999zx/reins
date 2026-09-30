import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  Run, receipt,
  type Decision, type Diagnostic, type Engine, type EngineEvent, type EngineSession, type Policy,
  type RunEventRecord, type RunOptions, type ToolRequest, type Workflow,
} from '@reins/core';
import { askTool, driveRun, questionId, runOptions, type DriveIo, type Question } from './drive.js';
import type { LogRow, SessionRow, Store } from './store.js';
import { taggedWorkflow, type Tag, type Tagged } from './tags.js';
import { loadWorkflow } from './run-cli.js';
import { FOLDER_PATH, commandsOf, folderHash, hashCommands } from './trust.js';

export type MakeEngine = (o: {
  model?: string; effort?: string;
  onApprove: (r: ToolRequest) => Promise<Decision>;
  onLive: (e: EngineEvent) => void;
}) => Engine;
export interface SessionDeps { store: Store; makeEngine: MakeEngine; dir: string; onRow?: (row: LogRow) => void }
export type Ack = { ok: true } | { ok: false; code: 400 | 409; error: string; text?: string; diagnostics?: Diagnostic[] };
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'closed';
export type Session = ReturnType<typeof openSession>;

const PLAIN: Policy = { mode: 'write', guards: [], allowShell: true };
const OK: Ack = { ok: true };
const conflict = (error: string): Ack => ({ ok: false, code: 409, error });
const bad = (error: string, diagnostics?: Diagnostic[]): Ack => ({ ok: false, code: 400, error, ...(diagnostics ? { diagnostics } : {}) });
const IGNORED = 'This workflow sets model: or engine:. A session ignores them and uses its own settings.';
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

  const getEngine = () => (engine ??= deps.makeEngine({
    ...(row.model ? { model: row.model } : {}),
    ...(row.effort ? { effort: row.effort } : {}),
    onApprove: (r) => askTool(io, r),
    onLive: (e) => log('engine', e, runId),
  }));

  function markDead(why: string) {
    const s = live;
    if (!s) return;
    live = undefined;
    log('note', { text: `Claude's session was dropped (${why}); the next message starts it again.` });
    void s.close().catch(() => {});
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
    if (cancelOpen || stopping) return undefined;
    const sid = store.getSession(id)!.engineSessionId;
    const s = await getEngine().open({
      cwd, ...(sid ? { sessionId: sid } : {}),
      policy: () => run?.policy() ?? PLAIN,
      pendingCards: () => (run ? run.takeCards() : queue.splice(0)),
    });
    live = s;
    return cancelOpen || stopping ? undefined : s;
  }
  const ensureEngine = (): Promise<EngineSession | undefined> =>
    live ? Promise.resolve(live) : (opening ??= openEngine().finally(() => { opening = undefined; }));

  const lent: EngineSession = {
    get sessionId() { return live?.sessionId ?? store.getSession(id)?.engineSessionId ?? ''; },
    async turn(text) {
      notSent = false;
      const s = await ensureEngine();
      if (!s) { notSent = true; return { text: '', events: [] }; }
      let res: Awaited<ReturnType<EngineSession['turn']>>;
      turnOpen = true;
      try {
        res = await s.turn(text);
      } catch (e) {
        markDead(msg(e));
        throw e;
      } finally {
        turnOpen = false;
        closeQuestions('the turn ended', 'tool');
      }
      const err = res.events?.find((e) => e.type === 'error');
      if (err && err.type === 'error') markDead(err.message);
      else if (!store.getSession(id)!.engineSessionId) store.updateSession(id, { engineSessionId: s.sessionId });
      return res;
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

  async function plainTurn(text: string): Promise<boolean> {
    let res: Awaited<ReturnType<EngineSession['turn']>>;
    try {
      res = await lent.turn(text);
    } catch (e) {
      log('turn_failed', { error: msg(e) });
      return false;
    }
    if (!notSent) log('turn_ended', { text: res.text, cost: res.cost });
    return true;
  }

  async function plainLoop(first: string, carried = false) {
    plainActive = true;
    try {
      let text = first;
      if (carried) log('message', { role: 'user', text, fromCards: true });
      for (;;) {
        const ok = await plainTurn(text);
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
      workflow: wf, engine: getEngine(), cwd, resolveBlock, session: lent,
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
    begin();
    start(async () => {
      if (!tagged && !(await trustedCommands(saved.workflowPath, w, resolveBlock))) return;
      const carry = await execute(rid, w, resolveBlock, (o) => {
        const r = Run.restore(snapshot, o);
        log('note', { text: `Resumed run ${rid}.${w.model || w.engine ? ` ${IGNORED}` : ''}` }, rid);
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
    if (!busy) return kind === 'stop' ? conflict('Nothing is running, so there is nothing to stop.') : startPlain(text, true);
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

  function settings(p: { autoApprove?: boolean; title?: string }) {
    const patch = { ...(p.autoApprove !== undefined ? { autoApprove: p.autoApprove } : {}), ...(p.title !== undefined ? { title: p.title } : {}) };
    if (!Object.keys(patch).length) return;
    store.updateSession(id, patch);
    log('settings', patch);
  }

  // While it runs, message, card, /run and /resume are 409, so no turn can start between the stop and the engine closing.
  async function endSession() {
    if (busy) {
      stopping = true;
      const stopped = run ? run.stop() : applyStop();
      closeQuestions('the session was closed');
      await stopped;
      await worker;
    }
    await live?.close().catch(() => {});
    live = undefined;
    if (status === 'closed') return;
    closed = true;
    log('closed', {});
    refresh();
  }
  const close = () => (closingP ??= endSession().finally(() => { closingP = undefined; }));

  // Server stop. Only a gate, budget or resume question detaches a run (driveRun returns on its null answer). Anything
  // else, a tool or judge question or a turn in flight, is stopped first, or the run would go on with the next step.
  // ponytail: a RUN command in flight is waited for, as in /close; there is no cancel.
  async function shutdown() {
    if (busy) {
      stopping = true;
      const detaches = [...pending.values()].some((p) => p.q.kind === 'gate' || p.q.kind === 'budget' || p.q.kind === 'resume');
      const stopped = detaches ? undefined : run ? run.stop() : applyStop();
      closeQuestions('the server stopped');
      await stopped;
      await worker;
    }
    await live?.close().catch(() => {});
    live = undefined;
  }

  return {
    id,
    info: () => store.getSession(id)!,
    status: () => status,
    message, card, answer, settings, runFile, resume, close, shutdown,
    idle: () => worker,
  };
}
