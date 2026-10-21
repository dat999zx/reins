// The API agent loop, parts 1 to 5 (spec 4.1 to 4.6, 4.11, 4.12): one model call per step, cost, retries, errors, interrupt, the per-reply call cap, the file
// tools behind path confinement and `checkTool`, the shell tool (shell.ts), the user's approval for the shell and for paths outside the project, the
// cards that arrive during a turn, the system prompt, and the conversation file (store.ts) that a session opened with its id reads back,
// and the USD limits (`usdRoom`, `maxUsd`), held before every model call; and part 6 (compact.ts): compaction by hand, and once when an answer
// says the conversation is too long.
import { randomUUID } from 'node:crypto';
import { checkTool, type Decision, type Engine, type EngineEvent, type EngineProbe, type EngineSession, type OpenOptions, type ToolRequest, type TurnResult } from '@reins/core';
import { CARD_CONTEXT_LIMIT, noLoneSurrogate, nonceOf, wrapCard } from '../cards.js';
import type { EngineHost, ProviderManifest, SendWithKey, Wire } from '../mods/types.js';
import { SETTINGS } from '../settings.js';
import { chooseCut, stubOldResults, SUMMARY_SYSTEM, tokensOf, transcript, withSummary } from './compact.js';
import { callCost, priceOf, USD_EPSILON } from './cost.js';
import { callsOf, flattenRounds, INTERRUPTED, pairUp, resultBlock, type Call } from './pairs.js';
import { confine, type FsLike } from './paths.js';
import { bodyOf, classify, retryDelay, sleep as realSleep, STALL_MS, TRIES, WORDS, type ErrorClass } from './retry.js';
import { openConversation, type StoreFs } from './store.js';
import { readAgents, systemPrompt } from './system.js';
import { checkInput, cutText, noTool, offered, toolSpecs, type Target, type ToolCtx, type ToolOut } from './tools.js';
import type { Block, Extra, ModelRequest, Msg, Usage, WireEvent } from './types.js';
import { MAX_CALL_MS, MAX_REPLY } from './wire-util.js';

// The pairing rules moved to pairs.ts; callers and tests still import `pairUp` from here.
export { pairUp };

const REPLY_TOO_LONG = 'The reply was longer than Reins accepts and was cut off.';
const REPLY_TOO_SLOW = 'The reply took longer than Reins waits and was cut off.';
const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
const DENIED = 'Denied by the user in Reins.';
const CARD_CUT = ' […cut]';
const PATH_CHANGED = 'Blocked by Reins: the path changed while the question was open.';
const USD_USED_UP = 'The USD budget is used up.';

/** The clock and the dice of the retry back-off, and the platform and fs the tools see, for tests. */
export interface LoopDeps {
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  platform?: NodeJS.Platform;
  fs?: FsLike;
  /** The fs the conversation file is written and read with. */
  convFs?: StoreFs;
  /** What one reply may come to before it is cut off: bytes of text, thinking and tool arguments, and milliseconds from start to end of one call (tests make them small). */
  limits?: { replyBytes?: number; callMs?: number };
}

/** A tool input larger than this (in characters, strings and keys together) is shown in the public event as a preview. */
const PUBLIC_MAX = 1024 * 1024;
const PREVIEW_CHARS = 4096;
const PREVIEW_ITEMS = 100;

/** The size of a value in characters, counted up to a little over PUBLIC_MAX (it stops counting there). */
function weigh(v: unknown, sum = { n: 0 }): number {
  if (sum.n > PUBLIC_MAX) return sum.n;
  if (typeof v === 'string') sum.n += v.length;
  else if (Array.isArray(v)) for (const x of v) weigh(x, sum);
  else if (typeof v === 'object' && v !== null) {
    for (const [k, x] of Object.entries(v)) {
      sum.n += k.length;
      weigh(x, sum);
    }
  }
  else sum.n += 8;
  return sum.n;
}

/**
 * The same shape with every long string cut to its first 4,096 characters (redacted, the cut never ends on the start of a key) and "[N more
 * characters]" after it, and more than 100 entries of a list or object left out. Short strings are redacted whole. Not a full-size copy.
 */
function preview(v: unknown, red: (t: string, max?: number) => string, redAll: (t: string) => string): unknown {
  if (typeof v === 'string') {
    if (v.length <= PREVIEW_CHARS) return redAll(v);
    // Twice the shown length is redacted, so a key at the cut is seen whole; the cut itself is the redaction-safe one.
    return `${red(v.slice(0, PREVIEW_CHARS * 2), PREVIEW_CHARS)} [${v.length - PREVIEW_CHARS} more characters]`;
  }
  if (Array.isArray(v)) {
    const head = v.slice(0, PREVIEW_ITEMS).map((x) => preview(x, red, redAll));
    return v.length > PREVIEW_ITEMS ? [...head, `[${v.length - PREVIEW_ITEMS} more items]`] : head;
  }
  if (typeof v === 'object' && v !== null) {
    const entries = Object.entries(v);
    const out: Record<string, unknown> = {};
    for (const [k, x] of entries.slice(0, PREVIEW_ITEMS)) Object.defineProperty(out, redAll(k.slice(0, PREVIEW_CHARS)), { value: preview(x, red, redAll), enumerable: true, writable: true, configurable: true });
    if (entries.length > PREVIEW_ITEMS) out['[more]'] = `${entries.length - PREVIEW_ITEMS} more entries`;
    return out;
  }
  return v;
}

/**
 * What one tool call comes to before it runs: a result already (a refusal, an input error), or the function that runs it. `ask` is set when the
 * user must say yes first (the shell, a path outside the project): such a call is never in the parallel batch. `same` names what the question was
 * about (tool, real path, root, class, scope): after the yes the call is prepared again and must come to the same, or it does not run.
 */
type Prep = { text: string; isError: true; denied: boolean } | { run: () => Promise<ToolOut>; parallel: boolean; ask?: ToolRequest; same?: string };
const plain = (text: string, denied = false): Prep => ({ text, isError: true, denied });

/**
 * `unknownUsage`: the stream carried no usage, so the cost of the call is unknown. `cutOff`: the call was ended by Reins for its size or its time;
 * `blocks` then hold only that notice (never the partial), and the cost is unknown.
 */
type Reply = { blocks: Block[]; usage: Usage; extra?: Extra; unknownUsage?: boolean; cutOff?: string };

const textOf = (blocks: Block[]) => blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');

export function loopEngine(p: ProviderManifest, wire: Wire, h: EngineHost, deps: LoopDeps = {}): Engine {
  const keyState = () => h.key?.(p).state;
  return {
    id: p.id,
    // No request is made: only whether a key is there to send.
    probe: async (): Promise<EngineProbe> => ({
      installed: true,
      loggedIn: keyState() !== 'missing',
      capabilities: { midTurnSteer: 'none', preToolDeny: true, resume: true },
      problems: [],
    }),
    open: async (opts) => openSession(p, wire, h, opts, deps),
  };
}

function openSession(p: ProviderManifest, wire: Wire, h: EngineHost, opts: OpenOptions, deps: LoopDeps): EngineSession {
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  const sessionId = opts.sessionId ?? randomUUID();
  const cwd = opts.cwd ?? process.cwd();
  const model = opts.model ?? h.model ?? p.defaultModel;
  const effort = opts.effort ?? h.effort ?? p.defaultEffort;
  const info = p.models.find((m) => m.id === model);
  const platform = deps.platform ?? process.platform;
  const toolsOn = info?.tools !== false;
  const keyEnv = p.auth?.keyEnv[0] ?? 'a key';
  // The card marker of this session: in its system prompt (trust note) and on every card it is sent.
  const nonce = nonceOf(h.home, sessionId);
  const onApprove = opts.onApprove ?? h.onApprove;
  const red = (t: string, max?: number) => (h.redact ? h.redact(t, max) : max === undefined ? t : t.slice(0, max));
  /** A whole text redacted, with no trim of an ending that could be the start of a key. */
  const redAll = (t: string) => (h.redactAll ? h.redactAll(t) : red(t));
  /** A copy of a tool input for the events: strings redacted whole (through its JSON text, where a key is found in its escaped form too). */
  const publicInput = (input: unknown): unknown => {
    try {
      // An input that is big is shown as a preview, never copied whole: the copy would cost as much memory again, several times over.
      if (weigh(input) > PUBLIC_MAX) return preview(input, red, redAll);
      const json = JSON.stringify(input);
      return json === undefined ? input : JSON.parse(redAll(json));
    } catch {
      return redAll(String(input).slice(0, PREVIEW_CHARS));
    }
  };

  // A session id that is not one Reins made throws here, before the disk is touched. A fresh session writes no file until its first reply.
  const convo = openConversation(h.home, sessionId, { fs: deps.convFs, redactAll: redAll, holdsSecret: h.holdsSecret, provider: p.id });
  let loaded: ReturnType<typeof convo.load> | undefined;
  if (opts.sessionId) {
    // One session owns a conversation at a time: the lock is taken before the file is read and kept until `close`.
    convo.lock();
    try {
      loaded = convo.load(p.protocol);
    } catch (e) {
      convo.release();
      throw e;
    }
  }
  let history: Msg[] = loaded?.msgs ?? [];
  // The running total of USD; undefined = unknown (an unpriced call, or a resumed session whose total was not kept), and it stays so.
  // What Reins counted (`costBase`) is the baseline a turn's cost is measured from. What was paid is the file's sum: when it is larger, a call
  // was paid that the Run never counted (a turn that threw), and the next turn is charged for it. The larger of the two is the running total.
  // A file whose total is unknown (a lost line) cannot say what was paid after the base: the base is kept, and `unknownTail` makes a USD limit refuse.
  const fileTotal: number | undefined = loaded ? loaded.total : 0;
  const counted = opts.costBase;
  let unknownTail = false;
  let total: number | undefined;
  if (counted === undefined) total = fileTotal;
  else if (fileTotal === undefined) {
    total = counted;
    unknownTail = true;
  } else total = Math.max(counted, fileTotal);
  const fileTotals = loaded?.totals ?? {};
  const countedBy = opts.costBaseByModel;
  const totals: Record<string, number> = countedBy ? { ...countedBy } : { ...fileTotals };
  // Per model the larger too. A model the Run has no figure for starts at the file's, so its past spend is in the total but not in this turn's split.
  let baseBy: Record<string, number> = countedBy ? { ...countedBy } : { ...totals };
  if (countedBy) for (const [m, t] of Object.entries(fileTotals)) { totals[m] = Math.max(totals[m] ?? 0, t); baseBy[m] ??= t; }
  // What Reins counted before the turn now running; moves only when a turn resolves, so a turn that rejects leaves its spend for the next one.
  let base = counted ?? total;
  // What `maxUsd` counts from: the total when this session opened, so it holds across turns (it is not reset by a new turn).
  const openTotal = total;

  let turnEvents: EngineEvent[] = [];
  const emit = (e: EngineEvent) => {
    turnEvents.push(e);
    h.onLive(e);
  };

  let turnAbort: AbortController | undefined;
  let closed = false;

  /**
   * Writes to the conversation file (a fresh session takes its lock with the first write). A write that fails (disk, permissions, a key the
   * redaction missed) never fails the turn: one `hook` event tells the host, and nothing more is written this session. History in memory carries
   * on. It is not an `error` event: the session treats that as a dead engine and drops it.
   */
  let lost = false;
  const save = (write: () => void) => {
    if (lost || closed || convo.failed) return;
    try {
      convo.lock();
      write();
    } catch (e) {
      lost = true;
      emit({ type: 'hook', event: 'conversation-save', decision: 'failed', reason: red(e instanceof Error ? e.message : String(e), 300) });
    }
  };

  /** Answers every tool call that has no result with the interrupted stub, in the history and in the events. */
  const stubUnanswered = () => {
    const r = pairUp(history);
    history = r.msgs;
    for (const c of r.stubbed) emit({ type: 'tool_result', tool: c.name, output: INTERRUPTED });
  };

  /** What a failed call says (spec 4.9 table). */
  const finalError = (cls: ErrorClass, e: unknown): Error => {
    const err = e instanceof Error ? e : new Error(String(e));
    const status = (e as { status?: number }).status;
    let what = '';
    if (cls === 'network') what = `Cannot reach ${new URL(p.baseUrl).host}: ${red(err.message, 500).replace(/\.$/, '')}.`;
    else if (cls === 'refused') what = red(err.message, 500);
    else if (cls === 'auth') what = keyEnv;
    else if (cls === 'notFound') what = model;
    else if (cls === 'context') return new Error(`${WORDS.context.say(p.label, status, model)} The provider said: ${red(bodyOf(err.message), 500)}`);
    else if (cls === 'bad' || cls === 'unpaired') what = red(bodyOf(err.message), 500);
    return new Error(WORDS[cls].say(p.label, status, what));
  };

  /**
   * One try of one model call. 'stalled' and 'cancelled' are not errors. A drop mid-reply throws: nothing of the partial reply is kept.
   * `seen.started` is set once the provider has answered 200 (the body began): from then on a failure may have been billed.
   * A reply over the byte cap, or a call over the time cap (which a stream of comments does not extend: only the stall timer is re-armed by bytes),
   * ends as a `cutOff` reply: the notice stands for it, never the partial text.
   */
  async function callOnce(req: ModelRequest, outer: AbortSignal, seen: { started: boolean }): Promise<Reply | 'stalled' | 'cancelled'> {
    const ac = new AbortController();
    const stop = () => ac.abort();
    outer.addEventListener('abort', stop, { once: true });
    if (outer.aborted) ac.abort();
    let stalled = false;
    let cut: string | undefined;
    const cutOff = (words: string) => {
      cut ??= words;
      ac.abort();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { stalled = true; ac.abort(); }, STALL_MS);
    };
    arm();
    const clock = setTimeout(() => cutOff(REPLY_TOO_SLOW), deps.limits?.callMs ?? MAX_CALL_MS);
    const maxBytes = deps.limits?.replyBytes ?? MAX_REPLY;
    let bytes = 0;
    const count = (t: string) => {
      bytes += Buffer.byteLength(t);
      if (bytes > maxBytes) cutOff(REPLY_TOO_LONG);
    };
    const notice = (): Reply => ({ blocks: [{ type: 'text', text: cut! }], usage: NO_USAGE, unknownUsage: true, cutOff: cut! });
    const send = h.send;
    const watched = send ? { send: (async (...a: Parameters<SendWithKey>) => { const res = await send(...a); seen.started = true; return res; }) as SendWithKey } : {};
    try {
      const blocks: Block[] = [];
      let usage: Usage | undefined;
      let unknownUsage = false;
      let done: Extract<WireEvent, { type: 'done' }> | undefined;
      for await (const ev of wire.call(req, p, { ...h, ...watched, heartbeat: () => { h.heartbeat?.(); arm(); } }, ac.signal)) {
        if (cut) break;
        if (ev.type === 'text' || ev.type === 'thinking') count(ev.text);
        else if (ev.type === 'tool_call') count(ev.args);
        if (cut) break;
        const last = blocks.at(-1);
        if (ev.type === 'text') {
          if (last?.type === 'text') last.text += ev.text;
          else blocks.push({ type: 'text', text: ev.text });
        } else if (ev.type === 'thinking') {
          // A signature ends the block it belongs to; text after a signed block starts a new one.
          const open = last?.type === 'thinking' && last.signature === undefined ? last : undefined;
          if (open) {
            open.text += ev.text;
            if (ev.signature !== undefined) open.signature = ev.signature;
          } else blocks.push({ type: 'thinking', text: ev.text, ...(ev.signature !== undefined ? { signature: ev.signature } : {}) });
        } else if (ev.type === 'tool_call') {
          blocks.push({ type: 'tool_call', id: ev.id, name: ev.name, args: ev.args, ...(ev.extra ? { extra: ev.extra } : {}) });
        } else if (ev.type === 'usage') {
          usage = ev.usage;
          unknownUsage = ev.unknown === true;
        } else done = ev;
      }
      if (outer.aborted) return 'cancelled';
      if (cut) return notice();
      if (stalled) return 'stalled';
      if (!done || !usage) throw new Error('the reply ended before it was complete');
      return { blocks, usage, ...(unknownUsage ? { unknownUsage } : {}), ...(done.extra ? { extra: done.extra } : {}) };
    } catch (e) {
      if (outer.aborted) return 'cancelled';
      if (cut) return notice();
      if (stalled) return 'stalled';
      throw e;
    } finally {
      clearTimeout(timer);
      clearTimeout(clock);
      outer.removeEventListener('abort', stop);
    }
  }

  /**
   * A finished call is paid for and counted, whatever happens next. Returns what it cost; undefined when that is not known, and the total is then
   * unknown for good. `unknownUsage`: the call carried no usage (or it failed after the provider began to answer), so its cost is not known.
   */
  function charge(usage: Usage, unknownUsage = false): number | undefined {
    const price = priceOf(p, h, model);
    const cost = price && !unknownUsage ? callCost(price, usage) : undefined;
    // A cost that is not a number (a usage with a NaN in it) is no cost: the total becomes unknown, never a NaN that no comparison catches.
    const spent = cost !== undefined && Number.isFinite(cost) ? cost : undefined;
    if (total !== undefined) {
      if (spent === undefined) total = undefined;
      else {
        total += spent;
        totals[model] = (totals[model] ?? 0) + spent;
      }
    }
    return spent;
  }

  /**
   * A call that failed after the provider began to answer (a drop, a stall, a protocol error) may have been billed for its input at least: its cost
   * is unknown, not 0. The total becomes unknown now (so a retry under a USD limit is not sent), and the file says so (so a reopened session knows).
   * A failure before any 200 (a refused connection, a 4xx, a 5xx) is not this: nothing was billed.
   */
  function loseSpend() {
    charge(NO_USAGE, true);
    save(() => convo.appendUnknownSpend(model));
  }

  /** The money fields of a result: what was spent since the last one, the totals, the split by model. Moves the baseline up to now. */
  function costFields(): Pick<TurnResult, 'cost' | 'total' | 'totals' | 'models'> {
    const split = Object.fromEntries(Object.entries(totals).map(([m, t]) => [m, t - (baseBy[m] ?? 0)] as const).filter(([, c]) => c > 0));
    const fields = total !== undefined ? { cost: total - base!, total, totals: { ...totals }, models: split } : {};
    base = total;
    baseBy = { ...totals };
    return fields;
  }

  /**
   * Spec 4.9: tries again what is worth it, with the waits of the table; the final error is the table's words.
   * `repair`: an `unpaired` 400 flattens the tool rounds once and goes again. `again`: a `context` 400 calls it (it compacts, at most once for the
   * whole turn); 'ok' = the history is smaller, go again; undefined = it will not, so the final error. Without either the class is a final error.
   */
  async function callWithRetry(
    first: ModelRequest,
    signal: AbortSignal,
    beforeSend: () => string | undefined,
    how: { repair?: boolean; again?: () => Promise<'ok' | 'cancelled' | { stop: string } | undefined> } = {},
  ): Promise<Reply | 'cancelled' | { stop: string }> {
    let req = first;
    let tries = 0;
    let stalls = 0;
    let repaired = false;
    let sent = false;
    for (;;) {
      // Every request that goes out is judged against the live budget: the room may have gone while this one backed off, stalled or was repaired.
      if (sent) {
        const stop = beforeSend();
        if (stop) return { stop };
      }
      sent = true;
      let out: Reply | 'stalled' | 'cancelled';
      const seen = { started: false };
      try {
        out = await callOnce(req, signal, seen);
      } catch (e) {
        if (seen.started) loseSpend();
        const cls = classify(e);
        if (cls === 'consent') throw e; // the session asks the user; not rewritten
        if (cls === 'unpaired') {
          // A 400 about a tool id, and the history was already sanitized: the same request would be refused again. So once, at once, every tool
          // round goes as plain text (the file is not touched; the session keeps the flat history). The same answer twice is the final error.
          if (repaired || !how.repair) throw finalError(cls, e);
          repaired = true;
          history = flattenRounds(pairUp(history).msgs);
          req = { ...req, messages: history };
          continue;
        }
        if (cls === 'context') {
          const again = how.again ? await how.again() : undefined;
          if (again === undefined) throw finalError(cls, e);
          if (again !== 'ok') return again;
          req = { ...req, messages: history };
          continue;
        }
        if (!WORDS[cls].retry || ++tries >= TRIES) throw finalError(cls, e);
        await sleep(retryDelay(tries, (e as { retryAfter?: string }).retryAfter, random), signal);
        if (signal.aborted) return 'cancelled';
        continue;
      }
      if (out === 'stalled') {
        if (seen.started) loseSpend();
        if (stalls++ >= 1) throw new Error(WORDS.stall.say(p.label, undefined, ''));
        continue;
      }
      return out;
    }
  }

  /**
   * Spec 4.5 steps 1 to 4 for one call, in order: the tool table, the input, confinement, `checkTool`, then whether it would have to ask.
   * It runs nothing. Any exception is a deny (fail closed, as the CLI's hooks do).
   */
  function prepare(c: Call, entry: { input: unknown; bad?: string }, ctx: ToolCtx): Prep {
    try {
      if (entry.bad !== undefined) return plain(entry.bad);
      // Only what this platform offers: a model that calls the other platform's shell gets "no such tool", as for any invented name.
      const tool = toolsOn ? offered(platform).find((t) => t.name === c.name) : undefined;
      if (!tool) return plain(noTool(c.name, platform, toolsOn), true);
      const wrong = checkInput(tool, entry.input);
      if (wrong) return plain(wrong);
      const args = entry.input as Record<string, unknown>;
      const refused = tool.refuse?.(args, { home: ctx.home, cwd: ctx.cwd, platform });
      if (refused) return plain(refused, true);
      let target: Target | undefined;
      let inside = true;
      if (tool.path) {
        const at = confine((args[tool.path.arg] as string | undefined) ?? '.', { cwd: ctx.cwd, home: ctx.home, platform, ...(ctx.fs ? { fs: ctx.fs } : {}) });
        if (!at.ok) return plain(at.reason, true);
        inside = at.inside;
        target = { abs: at.abs, root: at.root, ...(inside ? {} : { scope: at.abs }) };
      }
      if (tool.class !== 'read') {
        // The path as the model wrote it, then the real path the tool would open: a guard holds for both.
        const why = checkTool(ctx.policy(), tool.name, args, ctx.cwd) ?? (target ? checkTool(ctx.policy(), tool.name, { ...args, file_path: target.abs }, target.root) : null);
        if (why) return plain(why, true);
      }
      if (!tool.run) return plain(`Blocked by Reins: ${tool.name} cannot run.`, true);
      const run = tool.run.bind(tool);
      // Only now, after every check above: the shell and a path outside the folder need the user's yes. The tool gets the input as the model wrote it.
      const ask: ToolRequest | undefined = !inside || tool.class === 'shell' ? { tool: tool.name, input: entry.input, id: c.id, ...(inside ? {} : { reason: `outside the project (${target!.abs})` }) } : undefined;
      return {
        parallel: tool.class === 'read' && !ask,
        ...(ask ? { ask, same: JSON.stringify([tool.name, target?.abs, target?.root, inside, target?.scope]) } : {}),
        run: async () => {
          try {
            return await run(args, ctx, target ?? { abs: ctx.cwd, root: ctx.cwd });
          } catch (e) {
            return { text: `${tool.name} failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
          }
        },
      };
    } catch (e) {
      return plain(`Blocked by Reins: internal error (${red(e instanceof Error ? e.message : String(e), 200)}).`, true);
    }
  }

  /**
   * Spec 4.1 and 6.3, asked before each model call: why this call must not be sent, or undefined. The room is the run's now (`usdRoom`) less
   * what this turn has spent; `maxUsd` is what this session may spend since it opened. A limit with a model that has no price, or a total
   * that is unknown (an unpriced call, a lost reply), cannot be held, so the call is not sent: unknown is never counted as zero.
   */
  function usdStop(): string | undefined {
    const room = opts.usdRoom?.();
    const cap = opts.maxUsd;
    if (room === undefined && cap === undefined) return undefined;
    // A figure that is not a number (a NaN room from the host, an infinite cap) cannot be held either: every comparison with it would be false.
    if ([room, cap, total, base, openTotal].some((x) => x !== undefined && !Number.isFinite(x))) return USD_USED_UP;
    const limit = Math.round(Math.min(room ?? Infinity, cap ?? Infinity) * 1e6) / 1e6;
    if (!priceOf(p, h, model)) return `${model} has no price, so Reins cannot hold the $${limit} budget. Add a price in Settings > Providers, or remove the budget.`;
    if (total === undefined || base === undefined || openTotal === undefined || unknownTail) return USD_USED_UP;
    if (room !== undefined && room - (total - base) <= USD_EPSILON) return USD_USED_UP;
    if (cap !== undefined && total - openTotal >= cap - USD_EPSILON) return USD_USED_UP;
    return undefined;
  }

  /**
   * Spec 4.8: one call on the same model summarises the head of the history (old long tool results cut); the tail stays as it is; the history
   * becomes the summary and the tail. Honours the budget first, like any call. The boundary goes into the file only after the summary call
   * returned (a call that fails, stops or is cancelled leaves the file and the history as they were). The boundary line is the first message of the
   * new history with the summary as its `summary` block, and the rest of the tail follows as lines of their own, so the file loads from the boundary
   * to exactly the history in memory. A copied reply carries a usage of nothing (cost 0): its spend is in the line it was first written in, and
   * a reply with no usage would make the total of the file unknown.
   */
  async function compactNow(signal: AbortSignal, trigger: 'manual' | 'overflow'): Promise<{ before: number; after: number } | 'none' | 'cancelled' | { stop: string }> {
    const stop = usdStop();
    if (stop) return { stop };
    const paired = pairUp(history).msgs;
    const cut = chooseCut(paired, info?.context);
    if (cut === undefined) return 'none';
    const head = stubOldResults(paired, cut).slice(0, cut);
    // ponytail: a head larger than the window makes the summary call itself too long (its own final error); the user starts a new session.
    const req: ModelRequest = {
      model,
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', blocks: [{ type: 'text', text: transcript(head) }] }],
      ...(info?.maxOutput !== undefined ? { maxOutput: info.maxOutput } : {}),
    };
    const reply = await callWithRetry(req, signal, usdStop);
    if (reply === 'cancelled' || 'stop' in reply) return reply;
    if (reply.cutOff) {
      loseSpend();
      throw new Error(reply.cutOff);
    }
    // The call finished: it is paid for and counted, whatever happens next.
    const spent = charge(reply.usage, reply.unknownUsage);
    const said = textOf(reply.blocks).trim();
    if (said === '') throw new Error(`${p.label} sent an empty summary, so the conversation was not compressed.`);
    const next = withSummary(said, paired.slice(cut));
    const before = tokensOf(history);
    const after = tokensOf(next);
    save(() => {
      convo.appendSummary(next[0]!, p.protocol, { model, ...reply.usage, ...(spent !== undefined ? { cost: spent } : {}) });
      for (const m of next.slice(1)) convo.appendMsg(m, p.protocol, m.role === 'assistant' ? { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } : undefined);
    });
    history = next;
    emit({ type: 'compacted', trigger, before, after });
    return { before, after };
  }

  async function runTurn(text: string, ac: AbortController): Promise<TurnResult> {
    const signal = ac.signal;
    const max = h.settings?.maxCallsPerTurn ?? SETTINGS.maxCallsPerTurn.default;
    // Where this turn began in the history; a compaction in the turn makes the index mean nothing, and then nothing is cut back (Infinity).
    let mark = history.length;
    turnEvents = [];
    // Written to the file with the first reply, not before: a turn that got no reply at all leaves no trace there either.
    const userMsg: Msg = { role: 'user', blocks: [{ type: 'text', text }] };
    let userSaved = false;
    let shrunk = false;
    history.push(userMsg);
    let calls = 0;
    let finished = 0;
    let lastUsage: Usage | undefined;
    // Once per turn, not per model call: the project's AGENTS.md as the file tools would read it.
    const system = systemPrompt({
      cwd,
      platform,
      tools: toolsOn ? offered(platform).map((t) => t.name) : [],
      nonce,
      agents: readAgents({ cwd, home: h.home, platform, fs: deps.fs, redact: red, redactAll: redAll }),
    });

    /**
     * `error`: the turn failed (an `error` event, which the session reads as a dead engine). `budget`: the turn stopped because a USD limit cannot
     * be held; that is a normal stop, so it is one `hook` event and no `error`, and the engine and its conversation stay (spec 6.3).
     */
    const finish = (text: string, error?: string, budget = false): TurnResult => {
      if (error) emit({ type: 'error', message: error });
      if (budget) emit({ type: 'hook', event: 'usd-stop', decision: 'stopped', reason: text });
      if (lastUsage) {
        const used = lastUsage.input + lastUsage.cacheRead + lastUsage.cacheWrite + lastUsage.output;
        emit({ type: 'usage', model, used, ...(info?.context !== undefined ? { window: info.context } : {}) });
      }
      return {
        text,
        ...costFields(),
        ...(error || budget ? { isError: true } : {}),
        ...(budget ? { budgetStop: true } : {}),
        events: turnEvents,
      };
    };

    /** The turn ends here because no call may be sent: answered tool calls stay, a turn with no reply at all leaves no trace (its text is sent again). */
    const stopForBudget = (words: string): TurnResult => {
      stubUnanswered();
      if (finished === 0) history = history.slice(0, mark);
      return finish(words, undefined, true);
    };

    try {
      for (;;) {
        if (signal.aborted) {
          stubUnanswered();
          return finish('');
        }
        // Before the call, not after it: a call that would start with no room is not sent.
        const stop = usdStop();
        if (stop) return stopForBudget(stop);
        if (++calls > max) {
          const words = `Reins stopped this reply after ${max} model calls (the per-reply limit in Settings).`;
          stubUnanswered();
          // An error result carries its words as its text: that is what a Run shows ("the subagent's reply was an error (...)").
          return finish(words, words);
        }
        history = pairUp(history).msgs;
        const req: ModelRequest = {
          model,
          system,
          messages: history,
          ...(toolsOn ? { tools: toolSpecs(platform) } : {}),
          ...(effort ? { effort } : {}),
          ...(info?.maxOutput !== undefined ? { maxOutput: info.maxOutput } : {}),
        };
        const reply = await callWithRetry(req, signal, usdStop, {
          repair: true,
          // A "too long" answer compacts once in the whole turn, however many calls the turn makes; a second one is the final error.
          again: async () => {
            if (shrunk) return undefined;
            shrunk = true;
            const done = await compactNow(signal, 'overflow');
            if (done === 'cancelled' || done === 'none' || 'stop' in done) return done === 'none' ? undefined : done;
            // The tail, which holds this turn's user message, was written to the file with the boundary.
            userSaved = true;
            mark = Infinity;
            return 'ok';
          },
        });
        if (reply === 'cancelled') {
          stubUnanswered();
          return finish('');
        }
        if ('stop' in reply) return stopForBudget(reply.stop);

        // The call finished: it is paid for and counted, whatever happens next.
        finished++;
        lastUsage = reply.usage;
        const spent = charge(reply.usage, reply.unknownUsage);

        // Tool-call arguments arrive as JSON text; a block keeps them parsed when they are, as the text when they are not.
        // Keyed by the block itself: two calls with the same id (a broken provider) never share an input.
        const parsed = new Map<Block, { input: unknown; bad?: string }>();
        const blocks = reply.blocks.map((b): Block => {
          if (b.type !== 'tool_call') return b;
          try {
            const input: unknown = JSON.parse(b.args as string);
            const parsedBlock = { ...b, args: input };
            parsed.set(parsedBlock, { input });
            return parsedBlock;
          } catch (e) {
            parsed.set(b, { input: b.args, bad: `Your arguments were not valid JSON: ${(e as Error).message}. Call the tool again.` });
            return b;
          }
        });
        const assistant: Msg = { role: 'assistant', blocks, ...(reply.extra ? { extra: reply.extra } : {}) };
        history.push(assistant);
        save(() => {
          if (!userSaved) {
            userSaved = true;
            convo.appendMsg(userMsg, p.protocol);
          }
          // The reply and its spend are one line.
          convo.appendMsg(assistant, p.protocol, { model, ...reply.usage, ...(spent !== undefined ? { cost: spent } : {}) });
        });
        // Cut off by Reins: the notice is the reply (in the history and the file), its cost is unknown, and the turn ends as an error.
        if (reply.cutOff) return finish(reply.cutOff, reply.cutOff);

        // The loop has already joined the stream's deltas into whole messages, so a key split across deltas is whole here and one redaction finds it.
        // History keeps the raw text: the next request goes to the provider that wrote it.
        const thought = redAll(blocks.flatMap((b) => (b.type === 'thinking' ? [b.text] : [])).join(''));
        if (thought !== '') emit({ type: 'thinking', tokens: Math.ceil(thought.length / 4), text: thought });
        const said = redAll(textOf(blocks));
        if (said !== '') emit({ type: 'text', text: said });
        const asked = callsOf(blocks);
        if (!asked.length) return finish(said);

        // The event shows a redacted copy of the input; the tool is given the arguments as they came.
        for (const c of asked) emit({ type: 'tool_call', tool: c.name, input: publicInput(parsed.get(c)!.input) });
        if (signal.aborted) {
          stubUnanswered();
          return finish('');
        }
        const ctx: ToolCtx = { cwd, home: h.home, policy: opts.policy, signal, redact: red, redactAll: redAll, platform, holdsSecret: h.holdsSecret, env: h.shellEnv, redactStream: h.redactStream, ...(deps.fs ? { fs: deps.fs } : {}) };
        // Settles when the turn is aborted: a tool that does not look at the signal (a stuck read) is no longer waited for, and its late answer is dropped.
        const aborted = new Promise<'aborted'>((ok) => {
          if (signal.aborted) ok('aborted');
          else signal.addEventListener('abort', () => ok('aborted'), { once: true });
        });
        const runIt = async (r: { run: () => Promise<ToolOut> }): Promise<ToolOut | undefined> => {
          // Nothing starts once the turn is aborted (a synchronous Write would be done before the race could look at the signal).
          if (signal.aborted) return undefined;
          const out = await Promise.race([r.run(), aborted]);
          return out === 'aborted' || signal.aborted ? undefined : out;
        };
        const results: Block[] = [];
        /** The result enters the conversation and the events once, redacted and capped (spec 8.3 choke point 3). A refusal also says so as events. */
        const settle = (c: Call, text: string, isError: boolean, denied = false) => {
          const shown = cutText(red, redAll, text);
          if (denied) {
            emit({ type: 'refusal', reason: shown });
            emit({ type: 'hook', event: 'pre-tool', tool: c.name, decision: 'deny', reason: shown });
          }
          emit({ type: 'tool_result', tool: c.name, output: shown });
          results.push(resultBlock(c.id, shown, isError));
        };
        /**
         * Puts the question to the user (spec 4.5 step 4) and gives the answer; undefined when the turn was aborted first (the question is void:
         * the host closes it when the turn ends, and a late answer is dropped). The raw input goes to the host. A failure or a malformed answer is a deny.
         */
        const askUser = async (c: Call, req: ToolRequest): Promise<Decision | undefined> => {
          let d: Decision;
          try {
            const answer = Promise.resolve().then(() => onApprove(req));
            answer.catch(() => {}); // a rejection after the abort has no one to tell
            const got = await Promise.race([answer, aborted]);
            if (got === 'aborted' || signal.aborted) return undefined;
            if (got?.behavior !== 'allow' && got?.behavior !== 'deny') throw new Error('the answer was not allow or deny');
            d = got;
          } catch (e) {
            d = { behavior: 'deny', message: `Blocked by Reins: internal error (${red(e instanceof Error ? e.message : String(e), 200)}).` };
          }
          emit({ type: 'hook', event: 'approve', tool: c.name, decision: d.behavior, ...(d.message ? { reason: redAll(d.message) } : {}) });
          // The event itself may have interrupted the turn (a host listening for it): then the answer does not count.
          return signal.aborted ? undefined : d;
        };
        const ready = asked.map((c) => prepare(c, parsed.get(c)!, ctx));
        if (ready.every((r) => 'run' in r && r.parallel)) {
          // Only reads inside the folder: all at once, the results in the model's order. A call that was cut short by an interrupt does not count.
          const outs = await Promise.all(ready.map((r) => runIt(r as { run: () => Promise<ToolOut> })));
          asked.forEach((c, i) => { const out = outs[i]; if (out) settle(c, out.text, out.isError === true); });
        } else {
          // Anything else, one by one in the model's order; each call is judged just before it runs, not at the start of the batch.
          for (let i = 0; i < asked.length; i++) {
            if (signal.aborted) break;
            let r = i === 0 ? ready[0]! : prepare(asked[i]!, parsed.get(asked[i]!)!, ctx);
            if ('run' in r) {
              if (r.ask) {
                const d = await askUser(asked[i]!, r.ask);
                if (!d) break;
                // A user's no is not a guard refusal: no `refusal` event, so the receipt does not count it.
                if (d.behavior !== 'allow') {
                  settle(asked[i]!, d.message || DENIED, true);
                  continue;
                }
                // The user answered about the call as it was. Time has passed: judge it again from the start (the path, the policy, the word scan)
                // and run only a call that is the same question. Reins, not the user, refuses a call that is not.
                const fresh = prepare(asked[i]!, parsed.get(asked[i]!)!, ctx);
                if (!('run' in fresh)) {
                  settle(asked[i]!, fresh.text, true, true);
                  continue;
                }
                if (fresh.same !== r.same) {
                  settle(asked[i]!, PATH_CHANGED, true, true);
                  continue;
                }
                r = fresh;
              }
              const out = await runIt(r);
              if (!out) break;
              settle(asked[i]!, out.text, out.isError === true);
            } else settle(asked[i]!, r.text, true, r.denied);
          }
        }
        // The completed results enter the history first: whatever the cards do, they are not lost.
        const message: Msg = { role: 'user', blocks: results };
        if (results.length) history.push(message);
        if (signal.aborted) {
          // What did finish happened for real: it is kept. The calls it does not answer are stubbed again when the file is read.
          if (results.length) save(() => convo.appendMsg(message, p.protocol));
          stubUnanswered();
          return finish('');
        }
        // Spec 4.5 step 6: the cards queued while the tools ran go in the same user message as the results, after them. An aborted batch leaves them queued.
        // A host that throws, or answers with anything but a list of texts, delivers no card.
        let cards: string[] = [];
        try {
          const got: unknown = opts.pendingCards?.();
          if (Array.isArray(got)) cards = got.filter((x): x is string => typeof x === 'string');
        } catch {
          cards = [];
        }
        emit({ type: 'hook', event: 'post-tool', tool: asked.at(-1)!.name, decision: cards.length ? 'card' : 'pass' });
        // ponytail: a card is never cut to nothing (at least 500 characters of text), so more than about 20 cards in one round go over the 10,000
        // characters of CARD_CONTEXT_LIMIT. A person types few; a bounded drain (the host handing over only what fits) would belong to the host.
        const budget = Math.max(500, Math.floor(CARD_CONTEXT_LIMIT / Math.max(cards.length, 1)) - 400);
        const wrapped = cards.map((card): Block => {
          emit({ type: 'card_delivered', card, channel: 'mid-turn' });
          return { type: 'text', text: wrapCard(card.length > budget ? noLoneSurrogate(card.slice(0, budget)) + CARD_CUT : card, nonce) };
        });
        if (wrapped.length) {
          const placed = results.length > 0;
          results.push(...wrapped);
          if (!placed) history.push(message);
        }
        if (message.blocks.length) save(() => convo.appendMsg(message, p.protocol));
      }
    } catch (e) {
      stubUnanswered();
      // A turn that got no reply at all leaves no trace: its text is sent again by whoever retries it.
      if (finished === 0) history = history.slice(0, mark);
      throw e;
    }
  }

  /** The start of a turn or a compaction: refuses when closed, busy or without a key; the abort of the work that follows. */
  function begin(): AbortController {
    if (closed) throw new Error('the session is closed');
    if (turnAbort) throw new Error('a turn is already running');
    if (h.key?.(p).state === 'missing') throw new Error(`${p.label} has no key. Set ${keyEnv}, or add a key in Settings > Providers.`);
    return (turnAbort = new AbortController());
  }

  return {
    sessionId,
    async turn(text) {
      const ac = begin();
      try {
        return await runTurn(text, ac);
      } finally {
        turnAbort = undefined;
      }
    },
    // Runs as a turn does: one at a time (a second call while one runs is refused), and `interrupt` cancels it.
    async compact() {
      const ac = begin();
      turnEvents = [];
      try {
        const done = await compactNow(ac.signal, 'manual');
        if (typeof done === 'object' && 'stop' in done) {
          emit({ type: 'hook', event: 'usd-stop', decision: 'stopped', reason: done.stop });
          return { text: done.stop, ...costFields(), isError: true, budgetStop: true, events: turnEvents };
        }
        return { text: done === 'none' ? 'Nothing to compress yet: the conversation is short.' : '', ...costFields(), events: turnEvents };
      } finally {
        turnAbort = undefined;
      }
    },
    async interrupt() {
      turnAbort?.abort();
    },
    events: {
      // ponytail: live events go to EngineHost.onLive, as the CLI engine's do; nothing reads this stream.
      async *[Symbol.asyncIterator]() {},
    },
    async close() {
      closed = true;
      turnAbort?.abort();
      convo.release();
    },
  };
}
