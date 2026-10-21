import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Run, receipt, showText,
  type Decision, type Diagnostic, type Engine, type EngineEvent, type EngineSession, type Policy,
  type Receipt, type RunEventRecord, type RunOptions, type SubagentOpen, type SubagentOpened, type SwitchOutcome, type ToolRequest, type TurnResult, type Workflow,
} from '@reins/core';
import { askTool, driveRun, questionId, runOptions, type DriveIo, type Question } from './drive.js';
import { contextSize, contextWindow, detachedRuns, modelWithoutWindow, readSetting, stillOverAfterCompaction, switchCheck, type SwitchCheck } from './settings.js';
import { KEY_IN_IDENTITY, KeyInIdentity, type LogRow, type SessionRow, type Store } from './store.js';
import { KEY_IN_WORKFLOW, StreamRedactor, type Redactor } from './secrets.js';
import { ProviderChanged } from './send.js';
import { taggedWorkflow, type Tag, type Tagged } from './tags.js';
import { loadWorkflow } from './run-cli.js';
import { isUnder } from './loop/paths.js';
import type { FolderTrust } from './mods/types.js';
import { parseModel } from './models.js';
import { crossWords, missingProviderWords, noKeyWords, providerStatus, resolveSubagent, runChecks, type CheckEnv } from './run-checks.js';
import { commandsOf, hashCommands } from './trust.js';

export type MakeEngine = (o: {
  /** The id of the provider whose engine this is. */
  provider: string;
  model?: string; effort?: string;
  onApprove: (r: ToolRequest) => Promise<Decision>;
  onLive: (e: EngineEvent) => void;
  /** The API agent loop's settings, read live (a getter); none = the defaults. */
  settings?: { maxCallsPerTurn: number };
}) => Engine;
/** The provider's view of a model, for a switch: whether its list has it, its label, and the cost estimate of switching to it at `used` tokens. */
export type DescribeModel = (engine: string, model: string, used: number | undefined) =>
  { listed: boolean; label: string; estimate?: number | undefined; source?: 'table' | 'catalog' };
/** The provider's view of a reasoning level: whether its list has it, and its label. */
export type DescribeEffort = (engine: string, id: string) => { listed: boolean; label: string };
export interface SessionDeps {
  store: Store; makeEngine: MakeEngine; dir: string; onRow?: (row: LogRow) => void; describeModel?: DescribeModel; describeEffort?: DescribeEffort;
  /** What workflow commands run with: `shellEnvFrom(...)`, worked out when each command starts; no key and no REINS_* var. None = this process's (tests). */
  env?: () => NodeJS.ProcessEnv;
  /** Hides secrets in streamed command output and refuses to save a workflow that holds one. None = nothing is hidden (tests). */
  redactor?: Redactor;
  /** The folder question of a provider's protocol, if it has one (spec S4: asked for the engine being opened). */
  folderTrust?: (provider: string, cwd: string) => FolderTrust | undefined;
  /** Which providers are installed and what they are (spec 10.2); none = only the session's own provider is known and the checks beyond the model list are skipped. */
  providers?: Pick<CheckEnv, 'installed' | 'facts'>;
  /** The question a provider wants answered before it is sent the user's prompts and key (spec 7.8), if it is not answered yet. */
  consent?: (provider: string) => Consent | undefined;
  /** The origin of the provider's address as installed NOW (undefined: gone, off, or Reins sends nothing to it). A running engine opened for another origin is dropped. */
  origin?: (provider: string) => string | undefined;
}
/** A provider's consent question: the words, and what a yes records. */
export interface Consent {
  prompt: string; detail: string; refused: string; stopped: string;
  /** Records the yes. `false` = it was not recorded (the provider's address is no longer the one the question showed), so the question is asked again. */
  grant(): boolean | void;
}
export type Ack = { ok: true } | { ok: false; code: 400 | 409; error: string; text?: string; diagnostics?: Diagnostic[] };
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'closed';
export type Session = ReturnType<typeof openSession>;

const PLAIN: Policy = { mode: 'write', guards: [], allowShell: true };
const OK: Ack = { ok: true };
const conflict = (error: string): Ack => ({ ok: false, code: 409, error });
const bad = (error: string, diagnostics?: Diagnostic[]): Ack => ({ ok: false, code: 400, error, ...(diagnostics ? { diagnostics } : {}) });
export const under = (file: string, root: string) => {
  const rel = path.relative(root, file);
  return rel !== '' && rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel); // a folder named "..foo" is fine
};
const real = (p: string) => {
  try { return fs.realpathSync(p); } catch { return undefined; }
};
export const TOO_WIDE_WORDS = 'Pick a project folder, not your whole home folder or a drive.';
/**
 * The words that refuse `cwd` as a session folder, or undefined. A folder that is, or holds, the user's home folder or the Reins folder (a drive
 * root holds both) would make everything in it "inside the project": no question before a read of `.ssh` or a write to a shell profile.
 */
export function projectFolderWords(cwd: string, reinsDir: string, userHome: string = os.homedir()): string | undefined {
  // A filesystem root is refused on its own, as text, before the filesystem is touched: `C:\`, any `X:\`, `/`, a share root such as `\\server\share`.
  // (Containment of the two homes below catches only the drive they are on.) A Windows-style path is judged by the Windows rules on any host.
  const win = /^([a-z]:|[\\/]{2})/i.test(cwd);
  const P = win ? path.win32 : path;
  const text = P.resolve(cwd);
  // `\\server` and `\\server\share` (either slash): a server or a share root, judged on the text as given (Node resolves a bare `\\server` as a local name).
  if (P.relative(P.parse(text).root, text) === '' || /^[\\/]{2}[^\\/]*([\\/][^\\/]*)?[\\/]?$/.test(cwd)) return TOO_WIDE_WORDS;
  const at = (p: string) => real(p) ?? path.resolve(p);
  const folder = at(cwd);
  return [userHome, reinsDir].some((h) => isUnder(at(h), folder)) ? TOO_WIDE_WORDS : undefined;
}
const msg = (e: unknown) => String((e as Error)?.message ?? e);
// Already in session_log as engine rows, or (cost) in turn_ended (plan 15d 3b.3, line 1405).
/** The engine events of a subagent that are kept in the log (with its step). */
const KEPT = new Set(['text', 'thinking', 'tool_call', 'tool_result', 'refusal', 'error']);
const SKIPPED = new Set(['tool_call', 'refusal', 'hook', 'engine_cost']);
/** Two replies' per-model dollars added; a side that is missing adds nothing, both missing stays missing. */
const sumModels = (a?: Record<string, number>, b?: Record<string, number>): Record<string, number> | undefined => {
  if (!a || !b) return a ?? b;
  const out = { ...a };
  for (const [m, c] of Object.entries(b)) out[m] = (out[m] ?? 0) + c;
  return out;
};

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
  // A model switch no reply has proved yet: where to go back to (model, provider, reasoning) if the first reply fails.
  let pendingSwitch: { from: string | undefined; to: string; fromEngine: string; fromEffort: string | undefined } | undefined;
  let run: Run | undefined;
  let runId: string | undefined;
  let worker: Promise<void> = Promise.resolve();
  const queue: string[] = [];
  let intent: { kind: 'now'; text: string } | { kind: 'stop' } | undefined;
  const pending = new Map<string, { q: Question; rid?: string; resolve: (a: string | null) => void }>();
  let status: SessionStatus = (store.readLog(id).reverse().find((r) => r.type === 'status')?.data as { status: SessionStatus } | undefined)?.status ?? 'idle';

  /** Whether any of these identity values (a path, a folder, an id) holds a key Reins knows. */
  const holdsKey = (...v: string[]) => !!deps.redactor && v.some((x) => deps.redactor!.has(x));
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
    // The one place a question reaches the app (and the stream): its words are shown with control, direction and zero-width characters as <U+XXXX>.
    // The detail of an approval is the whole input, never cut.
    log('question', { ...q, prompt: showText(q.prompt, { lines: true }), ...(q.detail !== undefined ? { detail: showText(q.detail, { lines: true }) } : {}), ...(q.title !== undefined ? { title: showText(q.title, { lines: true }) } : {}) }, runId);
    if (q.kind === 'tool' && store.getSession(id)!.autoApprove) {
      log('answer', { questionId: q.id, answer: 'y' }, runId);
      return Promise.resolve('y');
    }
    return new Promise((resolve) => {
      pending.set(q.id, { q, rid: runId, resolve });
      refresh();
    });
  };
  // A command's output arrives in chunks that can cut a key in two; each row must be clean by itself, so the end of a chunk that could
  // be the start of a key is held until the next one (or until the command ends).
  const cmdOut = deps.redactor ? new StreamRedactor(deps.redactor) : undefined;
  const outputRow = (chunk: string) => { if (chunk) log('command_output', { chunk }, runId); };
  const io: DriveIo = {
    ask,
    say: (text) => log('say', { text }, runId),
    write: (chunk) => outputRow(cmdOut ? cmdOut.push(chunk) : chunk),
    endOutput: () => { if (cmdOut) outputRow(cmdOut.end()); },
  };

  // The origin of the provider's address when `engine` was made. A reload that changes it (or removes the provider) retires the engine before its next use.
  let openedFor: string | undefined;
  const getEngine = () => {
    if (engine) return engine;
    const cur = store.getSession(id)!; // the model can change after the session was opened
    openedFor = deps.origin?.(cur.engine);
    return (engine = deps.makeEngine({
      provider: cur.engine,
      ...(cur.model ? { model: cur.model } : {}),
      ...(cur.effort ? { effort: cur.effort } : {}),
      // A request from the CLI's own task child is a card titled with the task, under the subagent approvals setting.
      onApprove: (r) => (r.via !== undefined ? subagentApprove(`Task ${r.via.slice(0, 80).trim()}`, r) : askTool(io, r)),
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
    log('note', { text: `The provider's session was dropped (${why}); the next message starts it again.` });
    retire(s);
  }

  /** The first reply after a switch failed: the stored model goes back, the provider's session id stays. */
  function undoSwitch(why: string) {
    const p = pendingSwitch;
    if (!p) return;
    pendingSwitch = undefined;
    const cur = store.getSession(id)!;
    const moved = p.fromEngine !== cur.engine;
    store.updateSession(id, { model: p.from ?? null, ...(moved ? { engine: p.fromEngine, effort: p.fromEffort ?? null } : {}) });
    log('settings', { model: p.from ?? '', ...(moved ? { engine: p.fromEngine } : {}) });
    log('note', { text: `${p.to} did not answer (${why}). The model is back to ${moved ? `${p.fromEngine}:` : ''}${p.from ?? 'the default'}.` });
    dropEngine();
  }

  /** The next reply opens a new process (with the stored model and reasoning); the live one is closed. */
  function dropEngine() {
    engine = undefined;
    if (live) {
      const s = live;
      live = undefined;
      retire(s);
    }
  }

  const describe: DescribeModel = deps.describeModel ?? ((_e, m) => ({ listed: false, label: m }));
  const limits = () => ({ tokens: readSetting(store, 'switchApprovalTokens'), usd: readSetting(store, 'switchApprovalUsd') });

  /**
   * The one place a model switch lands (the header and a run's model step): the stored model (and provider, when `provider` is another one),
   * its row and note, and the process retired. The conversation stays: the next reply opens the same session id on the new provider.
   */
  function applySwitch(from: string | undefined, to: string, label: string | undefined, provider?: string) {
    const cur = store.getSession(id)!;
    const target = provider ?? cur.engine;
    const moving = target !== cur.engine;
    // A reasoning level the new provider does not list cannot be sent to it.
    const dropLevel = moving && !!cur.effort && !describeLevel(target, cur.effort).listed;
    store.updateSession(id, { model: to || null, ...(moving ? { engine: target } : {}), ...(dropLevel ? { effort: null } : {}) });
    log('settings', { model: to, ...(moving ? { engine: target } : {}), ...(dropLevel ? { effort: '' } : {}) });
    const where = moving ? ` on ${deps.providers?.facts(target)?.label ?? target}` : '';
    log('note', { text: `Model set to ${to ? label ?? to : 'the default'}${where} from the next reply. The whole conversation goes to it as input.` }, runId);
    const was = pendingSwitch ? pendingSwitch.from : from;
    const wasEngine = pendingSwitch ? pendingSwitch.fromEngine : cur.engine;
    const wasEffort = pendingSwitch ? pendingSwitch.fromEffort : cur.effort;
    pendingSwitch = (to || undefined) === was && target === wasEngine ? undefined : { from: was, to, fromEngine: wasEngine, fromEffort: wasEffort };
    dropEngine();
  }

  const describeLevel: DescribeEffort = deps.describeEffort ?? ((_e, id) => ({ listed: false, label: id }));

  /** The one place a reasoning change lands (the header and a run's model step): no card, no cost; the next reply opens on the new level. */
  function applyEffort(to: string, label: string) {
    store.updateSession(id, { effort: to });
    log('settings', { effort: to });
    log('note', { text: `Reasoning set to ${label} from the next reply.` }, runId);
    dropEngine();
  }

  /** A run's model step with a reasoning: applied as the header does, unless the session is on it already. */
  function runReasoning(level: string) {
    const cur = store.getSession(id)!;
    if (level !== cur.effort) applyEffort(level, describeLevel(cur.engine, level).label);
  }

  // ponytail: a run's model step is never refused as busy or because another run is left detached; a detached run resumed later goes on with the model stored then.
  /** A run's model step: the same rules and card as the header's switch, asked inside the run (which waits on it). */
  async function runSwitch(name: string, step: string): Promise<SwitchOutcome> {
    const cur = store.getSession(id)!;
    const used = contextSize(store.readLog(id));
    const p = parseModel(name, cur.engine, checkEnv().installed, step);
    // A bad name (a resumed run has no start check) or a provider the session cannot move to now (removed, key gone, the other kind of conversation) is kept as it is.
    const why = 'error' in p ? p.error : providerRefusal(p.provider);
    if ('error' in p || why) {
      const label = cur.model ? describe(cur.engine, cur.model, used).label : 'the default model';
      log('note', { text: `${why} Kept ${label}: the steps after \`${step}\` run on it.` }, runId);
      return { to: 'kept', label };
    }
    const model = p.model;
    const moving = p.provider !== cur.engine;
    const d = describe(p.provider, model, used);
    if (!moving && (cur.model ?? '') === model) return { to: 'same', label: d.label };
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
    applySwitch(cur.model, model, d.label, p.provider);
    return { to: 'switched', label: d.label };
  }

  /** Why the session cannot move to `provider` (spec 9.3, 10.2), before anything is opened: not installed, no key, or the other kind of conversation. None = it can. */
  function providerRefusal(provider: string): string | undefined {
    const cur = store.getSession(id)!;
    if (provider === cur.engine) return undefined;
    const env = checkEnv();
    if (!env.installed(provider)) return missingProviderWords(provider);
    const to = env.facts(provider);
    if (to?.key === 'missing') return noKeyWords(to);
    return crossWords(env.facts(cur.engine), to);
  }

  /** What the run-start checks read: the installed providers, and the session's provider list when the host has one. */
  const checkEnv = (): CheckEnv => {
    const engine = store.getSession(id)!.engine;
    return {
      installed: deps.providers?.installed ?? ((p) => p === engine),
      facts: deps.providers?.facts ?? (() => undefined),
      ...(deps.describeModel ? { listed: (p: string, m: string) => describe(p, m, undefined).listed } : {}),
    };
  };

  /** The six checks of spec 10.2, before trust and spend: the first that fails is the refusal. */
  function refuseRun(w: Workflow, resolveBlock: (name: string) => Workflow | undefined): Ack | undefined {
    const cur = store.getSession(id)!;
    const why = runChecks(checkEnv(), { provider: cur.engine, model: cur.model ?? undefined }, w, resolveBlock);
    return why ? bad(why) : undefined;
  }

  /** The receipt's models with the provider's label for each, as the header shows it. */
  function labelled(r: Receipt): Receipt {
    if (!r.models) return r;
    const engine = store.getSession(id)!.engine;
    return { ...r, models: r.models.map((m) => ({ ...m, label: describe(engine, m.model, undefined).label })) };
  }

  /** What the folder holds that the provider's own process runs without asking: trusted once per hash, before a process of `provider` starts here. */
  async function trustFolder(provider: string) {
    const f = deps.folderTrust?.(provider, cwd);
    if (f && !store.isTrusted(cwd, f.key, f.hash)) {
      await mustSayYes(f);
      store.trust(cwd, f.key, f.hash);
    }
  }

  /** A `trust` question that must be answered yes; a no (or a stop) leaves a note and throws its words. */
  async function mustSayYes(q: { detail: string; prompt: string; refused: string; stopped: string }) {
    const a = await ask({ id: questionId(), kind: 'trust', detail: q.detail, prompt: q.prompt });
    if (a === null || !/^(y|yes)$/i.test(a)) {
      const error = stopping ? q.stopped : q.refused;
      log('note', { text: error });
      throw new Error(error);
    }
  }

  /** Spec 7.8: the provider's consent question, when its current address has no yes yet. A yes records it; a no (or a stop) throws its words and nothing is sent. */
  async function askConsent(provider: string) {
    // The question is read again after every answer: a yes counts only for the address it showed, so a changed address asks about the new one.
    for (let c = deps.consent?.(provider); c; c = deps.consent?.(provider)) {
      await mustSayYes(c);
      if (c.grant() !== false) return;
    }
  }

  /** Before a process or a request of `provider` starts: its consent, then its folder question (the session's own provider and a subagent's alike). */
  async function allowProvider(provider: string) {
    await askConsent(provider);
    await trustFolder(provider);
  }

  async function openEngine(): Promise<EngineSession | undefined> {
    cancelOpen = false;
    await allowProvider(store.getSession(id)!.engine);
    await retiring;
    if (cancelOpen || stopping) return undefined;
    const sid = store.getSession(id)!.engineSessionId;
    // A new session counts from 0; a resumed one from the total stored for its id, and without one (a session
    // from before the cost table) its first reply's cost is unknown.
    const base = sid ? store.getEngineTotal(sid) : 0;
    const models = sid ? store.getEngineModels(sid) : undefined;
    baseUnknown = base === undefined;
    const s = await getEngine().open({
      cwd, ...(sid ? { sessionId: sid } : {}),
      ...(base !== undefined ? { costBase: base } : {}),
      ...(models ? { costBaseByModel: models } : {}),
      policy: () => run?.policy() ?? PLAIN,
      pendingCards: () => (run ? run.takeCards() : queue.splice(0)),
      // The run borrows this session, so its USD room is read here live; with no run (plain chat) there is no limit.
      usdRoom: () => run?.usdRoom(),
    });
    live = s;
    return cancelOpen || stopping ? undefined : s;
  }
  /** Retires an engine that was made for another address than the provider has now; the next use opens a new one, which asks first. */
  function dropIfStale() {
    if (engine && !opening && deps.origin && deps.origin(store.getSession(id)!.engine) !== openedFor) dropEngine();
  }
  const ensureEngine = (): Promise<EngineSession | undefined> => {
    dropIfStale();
    return live ? Promise.resolve(live) : (opening ??= openEngine().finally(() => { opening = undefined; }));
  };

  /** A subagent never asks the user itself (Hermes): its tool request is a card on the parent run, titled with it, or refused by the setting. */
  function subagentApprove(title: string, r: ToolRequest): Promise<Decision> {
    if (readSetting(store, 'subagentApprovals') === 'deny') {
      log('note', { text: `Denied ${r.tool} for ${title}: subagent approvals are set to deny.` }, runId);
      return Promise.resolve({ behavior: 'deny', message: 'Denied by Reins: subagent approvals are set to deny. Carry on without this tool.' });
    }
    return askTool(io, r, title);
  }

  // ponytail: the subagent runs on its block's model, else the session's; its guard refusals count in the receipt but not on its chip (run `refusal` rows are not in the session log, :43).
  /** A subagent's own engine (D): its model, its own hook server, and its text, reasoning and tools kept as engine rows with its `step` (never usage or cost: they measure the parent's context). */
  async function openSubagent(o: SubagentOpen): Promise<SubagentOpened> {
    const cur = store.getSession(id)!;
    // The step's `provider:model`, on its own provider; a provider that is gone, has no key or cannot take the step pauses the step with the words.
    const r = resolveSubagent(checkEnv(), { provider: cur.engine, model: cur.model ?? undefined, effort: cur.effort ?? undefined }, o);
    if ('error' in r) throw new Error(r.error);
    const { provider, model } = r;
    await allowProvider(provider);
    if (stopping) throw new Error('The session was stopped before the subagent started.');
    const title = `Subagent ${o.title} (\`${o.step}\`)`;
    const e = deps.makeEngine({
      provider,
      ...(model ? { model } : {}), ...(r.effort ? { effort: r.effort } : {}),
      onApprove: (x) => subagentApprove(title, x),
      // usage, cost, compacted and hook measure or note the parent's context, so they stay out; the rest is kept under the step
      onLive: (ev) => { if (KEPT.has(ev.type)) log('engine', { ...ev, step: o.step }, runId); },
    });
    const { step: _s, title: _t, reasoning: _r, model: _m, ...open } = o;
    const s = await e.open({ ...open, ...(o.model && model ? { model } : {}), cwd, pendingCards: () => [] });
    const session: EngineSession = {
      sessionId: s.sessionId,
      async turn(text) {
        turnOpen = true; // ask() takes tool questions only while a turn is open
        try { return await s.turn(text); } finally { turnOpen = false; closeQuestions('the turn ended', 'tool'); }
      },
      interrupt: () => s.interrupt(),
      events: s.events,
      close: () => s.close(),
    };
    return { session, ...(model ? { model, label: describe(provider, model, undefined).label } : {}) };
  }

  /** One engine call (a reply or a compaction): the process, the cost total, the unknown-cost note, a failed switch. */
  async function call(f: (s: EngineSession) => Promise<TurnResult>): Promise<TurnResult> {
    notSent = false;
    // A running engine was opened under an earlier yes: the yes is looked up again for the CURRENT address on every call (a revoke, or a
    // changed address, asks again). A closed engine asks when it opens.
    dropIfStale();
    if (live) await askConsent(store.getSession(id)!.engine);
    const s = await ensureEngine();
    if (!s) { notSent = true; return { text: '', events: [] }; }
    let res: TurnResult;
    turnOpen = true;
    try {
      res = await f(s);
    } catch (e) {
      markDead(msg(e));
      if (e instanceof ProviderChanged) dropEngine(); // its manifest is old: the next reply makes a new engine from the installed one
      undoSwitch(msg(e));
      throw e;
    } finally {
      turnOpen = false;
      closeQuestions('the turn ended', 'tool');
    }
    if (res.total !== undefined) store.putEngineTotal(s.sessionId, res.total, res.totals);
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
            return { text: '', events: [], ...(pre.cost !== undefined ? { cost: pre.cost } : {}), ...(pre.total !== undefined ? { total: pre.total } : {}), ...(pre.models ? { models: pre.models } : {}) };
          }
        }
      } else if (at < 1 && w === undefined) {
        // The newest usage has no window: it can never be at the threshold. Said once (the log is the memory, so a restart does not say it twice).
        const unknown = modelWithoutWindow(rows);
        const text = `The window of ${unknown} is not known, so Reins will not compress on its own. Set it in Settings > Providers.`;
        if (unknown !== undefined && !rows.some((r) => r.type === 'note' && (r.data as { text?: unknown } | null)?.text === text)) log('note', { text }, runId);
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
    const models = sumModels(pre?.models, res.models);
    return cost === undefined || cost === res.cost ? (models === res.models ? res : { ...res, ...(models ? { models } : {}) }) : { ...res, cost, ...(models ? { models } : {}) };
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
      workflow: wf, engine: getEngine(), cwd, resolveBlock, session: lent, switchModel: runSwitch, setReasoning: runReasoning, openSubagent,
      ...(deps.env ? { env: deps.env } : {}),
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
    let out: Awaited<ReturnType<typeof driveRun>>;
    try {
      out = await driveRun(r, io, save);
    } finally {
      io.endOutput?.();                    // whatever a command left held back is written under this run, not the next one
    }
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
    log('receipt', labelled(receipt(r.getEvents())), rid);
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
    // The run row will name this file and this folder: a known key in either is answered now, in plain words, not after OK in the worker.
    if (holdsKey(file, cwd, id)) return bad(KEY_IN_IDENTITY);
    const loaded = loadWorkflow(file);
    const w = loaded.workflow;
    if (!w) return bad(loaded.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message).join('; ') || 'Invalid workflow.', loaded.diagnostics);
    const refused = refuseRun(w, loaded.resolveBlock);
    if (refused) return refused;
    begin();
    start(async () => {
      if (!(await trustedCommands(file, w, loaded.resolveBlock))) return;
      const rid = randomBytes(4).toString('hex');
      store.createRun({ id: rid, workflowPath: file, cwd });
      const carry = await execute(rid, w, loaded.resolveBlock, (o) => new Run(o));
      if (carry) await plainLoop(carry, true);
    });
    return OK;
  }

  const ended = (rid: string) => store.readLog(id).some((r) => r.runId === rid && (r.type === 'run_finished' || r.type === 'run_stopped'));

  function resume(rid: string): Ack {
    if (closingP) return closingAck();
    if (busy) return conflict('The session is busy.');
    const gone = providerGone();
    if (gone) return gone;
    if (store.sessionOfRun(rid) !== id) return conflict(`Run ${rid} does not belong to this session.`);
    if (ended(rid)) return conflict(`Run ${rid} has already ended.`);
    const saved = store.loadRun(rid);
    if (!saved?.snapshot) return conflict(`Run ${rid} has no saved state.`);
    const snapshot = saved.snapshot;
    const w = snapshot.workflow;
    const tagged = path.resolve(saved.workflowPath) === path.resolve(dir, 'runs', `${rid}.reins.md`); // exactly the file taggedRun wrote
    const { resolveBlock } = loadWorkflow(saved.workflowPath);
    // No unknownModel check here: a detached run is stopped only through Resume, so a model that dropped off the list must not lock the session out.
    begin();
    start(async () => {
      if (!tagged && !(await trustedCommands(saved.workflowPath, w, resolveBlock))) return;
      const carry = await execute(rid, w, resolveBlock, (o) => {
        const r = Run.restore(snapshot, o);
        log('note', { text: `Resumed run ${rid}.` }, rid);
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
      // A refused identity write is plain words (its text is never repeated); anything else keeps the old note.
      .catch((e) => { log('note', { text: e instanceof KeyInIdentity ? KEY_IN_IDENTITY : `Internal error: ${msg(e)}` }); unsent(); })
      .finally(() => {
        busy = false;
        run = undefined;
        runId = undefined;
        closeQuestions('the work ended');
        refresh();
      });
  }

  const closingAck = () => conflict('The session is closing.');

  /** Spec 9.4: a session whose provider is not installed (or was retired) takes no new reply; reading its log still works. A turn already running is left alone. */
  const providerGone = (): Ack | undefined => {
    if (busy) return undefined;
    const s = providerStatus(store.getSession(id)!.engine, checkEnv().installed);
    return s.status === 'ok' ? undefined : conflict(s.words);
  };

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
    const gone = providerGone();
    if (gone) return gone;
    if (detachedRuns(store.readLog(id)).length > 0) return conflict('A run is left paused in this session. Resume or stop it before compressing.');
    if (!store.getSession(id)!.engineSessionId) return conflict('Nothing to compress yet: send a message first.');
    begin();
    log('message', { role: 'user', text: '/compress' });
    start(() => plainLoop('', false, true));
    return OK;
  }

  function message(text: string, tags: Tag[] = []): Ack {
    if (closingP) return closingAck();
    const gone = providerGone();
    if (gone) return gone;
    if (tags.length) {
      if (busy) return conflict('The session is busy; tags start a new run, so wait until it is idle.');
      const t = taggedWorkflow(text, tags);
      if (!t.ok) {
        return { ok: false, code: 400, error: t.error, ...(t.text ? { text: t.text } : {}), ...(t.diagnostics ? { diagnostics: t.diagnostics } : {}) };
      }
      // The generated workflow file would hold the key in plain text.
      if (deps.redactor?.has(t.text)) return bad(KEY_IN_WORKFLOW);
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
      const gone = kind !== 'stop' ? providerGone() : undefined;
      if (gone) return gone;
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
  function settings(p: { autoApprove?: boolean; title?: string; model?: string; provider?: string; estimate?: number | undefined; label?: string; source?: 'table' | 'catalog'; effort?: string; effortLabel?: string }): Ack {
    const from = store.getSession(id)!.model;
    // `provider`: the provider the model is on, when it is not the session's own. A model of the same name on another provider is still a switch.
    const moving = p.provider !== undefined && p.provider !== store.getSession(id)!.engine;
    const switching = p.model !== undefined && (moving || p.model !== (from ?? ''));
    if ((switching || p.effort !== undefined) && !checkEnv().installed(store.getSession(id)!.engine)) return conflict(missingProviderWords(store.getSession(id)!.engine));
    if (moving) {
      if (closingP) return closingAck();
      const why = providerRefusal(p.provider!);
      if (why) return conflict(why);
    }
    const leveling = p.effort !== undefined && p.effort !== store.getSession(id)!.effort;
    if (leveling) {
      if (closingP) return closingAck();
      if (busy) return conflict('Change the reasoning when the session is idle.');
    }
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
    if (leveling) applyEffort(p.effort!, p.effortLabel ?? p.effort!);
    if (switching) {
      const to = p.model!;
      // ponytail: a switch card waits with no timeout; any new work closes it without switching; a server stop leaves it to recover.ts.
      if (check && 'ask' in check) void ask({ id: questionId(), kind: 'switch', ...check.ask }).then((a) => { if (a === 'switch') applySwitch(from, to, p.label, p.provider); });
      else applySwitch(from, to, p.label, p.provider);
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
    /** Spec 9.4: `ok`, `missing` or `gone`, with the words, for the state the UI reads. */
    providerStatus: () => providerStatus(store.getSession(id)!.engine, checkEnv().installed),
    /** Why the session cannot move to `provider` now (spec 9.3), or undefined when it can; the session is not touched. */
    providerRefusal: (provider: string) => (providerStatus(store.getSession(id)!.engine, checkEnv().installed).status === 'ok' ? providerRefusal(provider) : missingProviderWords(store.getSession(id)!.engine)),
    idle: () => worker,
  };
}
