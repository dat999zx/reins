// The API agent loop, parts 1 and 2 (spec 4.1 to 4.5): one model call per step, cost, retries, errors, interrupt, the per-reply call cap, and the file tools
// behind path confinement and `checkTool`. A call that would need the user's approval (outside the folder, the shell) is refused: nothing can ask yet.
// No conversation file, no compaction, no USD guard: history lives in memory for the life of the session.
import { randomUUID } from 'node:crypto';
import { checkTool, type Engine, type EngineEvent, type EngineProbe, type EngineSession, type OpenOptions, type TurnResult } from '@reins/core';
import type { EngineHost, ProviderManifest, Wire } from '../mods/types.js';
import { SETTINGS } from '../settings.js';
import { callCost, priceOf } from './cost.js';
import { confine, type FsLike } from './paths.js';
import { classify, retryDelay, sleep as realSleep, STALL_MS, TRIES, WORDS, type ErrorClass } from './retry.js';
import { systemPrompt } from './system.js';
import { checkInput, cutText, findTool, noTool, toolSpecs, type Target, type ToolCtx, type ToolOut } from './tools.js';
import type { Block, Extra, ModelRequest, Msg, Usage, WireEvent } from './types.js';

const CANNOT_ASK = 'Blocked by Reins: this needs your approval, which this build cannot ask yet.';
const INTERRUPTED = 'Interrupted; the tool did not finish.';

/** The clock and the dice of the retry back-off, and the platform and fs the tools see, for tests. */
export interface LoopDeps {
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  platform?: NodeJS.Platform;
  fs?: FsLike;
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

/** What one tool call comes to before it runs: a result already (a refusal, an input error), or the function that runs it. */
type Prep = { text: string; isError: true; denied: boolean } | { run: () => Promise<ToolOut>; parallel: boolean };
const plain = (text: string, denied = false): Prep => ({ text, isError: true, denied });

type Call = Extract<Block, { type: 'tool_call' }>;
type Reply = { blocks: Block[]; usage: Usage; extra?: Extra };

const textOf = (blocks: Block[]) => blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
const callsOf = (blocks: Block[]): Call[] => blocks.filter((b): b is Call => b.type === 'tool_call');
const resultBlock = (id: string, content: string, isError = false): Block => ({ type: 'tool_result', id, content, ...(isError ? { isError } : {}) });

/**
 * Spec 4.12b, the part that exists so far: drops tool results whose call is not in the history and gives every call that has no result
 * the stub. Returns a new list (messages it changes are copies); `stubbed` names the calls it answered.
 */
export function pairUp(msgs: Msg[]): { msgs: Msg[]; stubbed: Call[] } {
  const calls = new Set(msgs.flatMap((m) => (m.role === 'assistant' ? callsOf(m.blocks).map((c) => c.id) : [])));
  const kept: Msg[] = [];
  for (const m of msgs) {
    const blocks = m.blocks.filter((b) => b.type !== 'tool_result' || calls.has(b.id));
    if (blocks.length) kept.push(blocks.length === m.blocks.length ? m : { ...m, blocks });
  }
  const answered = new Set(kept.flatMap((m) => m.blocks.flatMap((b) => (b.type === 'tool_result' ? [b.id] : []))));
  const out: Msg[] = [];
  const stubbed: Call[] = [];
  for (let i = 0; i < kept.length; i++) {
    const m = kept[i]!;
    out.push(m);
    const missing = m.role === 'assistant' ? callsOf(m.blocks).filter((c) => !answered.has(c.id)) : [];
    if (!missing.length) continue;
    stubbed.push(...missing);
    const stubs = missing.map((c) => resultBlock(c.id, INTERRUPTED, true));
    const next = kept[i + 1];
    if (next?.role === 'user') {
      out.push({ ...next, blocks: [...stubs, ...next.blocks] });
      i++;
    } else out.push({ role: 'user', blocks: stubs });
  }
  return { msgs: out, stubbed };
}

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

  let history: Msg[] = [];
  // The running total of USD; undefined = unknown (an unpriced call, or a resumed session whose total was not kept), and it stays so.
  let total: number | undefined = opts.costBase ?? (opts.sessionId ? undefined : 0);
  const totals: Record<string, number> = { ...opts.costBaseByModel };
  // What Reins counted before the turn now running; moves only when a turn resolves, so a turn that rejects leaves its spend for the next one.
  let base = total;
  let baseBy = { ...totals };

  let turnEvents: EngineEvent[] = [];
  const emit = (e: EngineEvent) => {
    turnEvents.push(e);
    h.onLive(e);
  };

  let turnAbort: AbortController | undefined;
  let closed = false;

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
    else if (cls === 'auth') what = keyEnv;
    else if (cls === 'notFound') what = model;
    else if (cls === 'bad') what = red(err.message.replace(/^[\s\S]*?answered \d{3}(?:: )?/, ''), 500);
    return new Error(WORDS[cls].say(p.label, status, what));
  };

  /** One try of one model call. 'stalled' and 'cancelled' are not errors. A drop mid-reply throws: nothing of the partial reply is kept. */
  async function callOnce(req: ModelRequest, outer: AbortSignal): Promise<Reply | 'stalled' | 'cancelled'> {
    const ac = new AbortController();
    const stop = () => ac.abort();
    outer.addEventListener('abort', stop, { once: true });
    if (outer.aborted) ac.abort();
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { stalled = true; ac.abort(); }, STALL_MS);
    };
    arm();
    try {
      const blocks: Block[] = [];
      let usage: Usage | undefined;
      let done: Extract<WireEvent, { type: 'done' }> | undefined;
      for await (const ev of wire.call(req, p, { ...h, heartbeat: () => { h.heartbeat?.(); arm(); } }, ac.signal)) {
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
        } else if (ev.type === 'usage') usage = ev.usage;
        else done = ev;
      }
      if (outer.aborted) return 'cancelled';
      if (stalled) return 'stalled';
      if (!done || !usage) throw new Error('the reply ended before it was complete');
      return { blocks, usage, ...(done.extra ? { extra: done.extra } : {}) };
    } catch (e) {
      if (outer.aborted) return 'cancelled';
      if (stalled) return 'stalled';
      throw e;
    } finally {
      clearTimeout(timer);
      outer.removeEventListener('abort', stop);
    }
  }

  /** Spec 4.9: tries again what is worth it, with the waits of the table; the final error is the table's words. */
  async function callWithRetry(req: ModelRequest, signal: AbortSignal): Promise<Reply | 'cancelled'> {
    let tries = 0;
    let stalls = 0;
    for (;;) {
      let out: Reply | 'stalled' | 'cancelled';
      try {
        out = await callOnce(req, signal);
      } catch (e) {
        const cls = classify(e);
        if (cls === 'consent') throw e; // the session asks the user; not rewritten
        if (!WORDS[cls].retry || ++tries >= TRIES) throw finalError(cls, e);
        await sleep(retryDelay(tries, (e as { retryAfter?: string }).retryAfter, random), signal);
        if (signal.aborted) return 'cancelled';
        continue;
      }
      if (out === 'stalled') {
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
      const tool = toolsOn ? findTool(c.name) : undefined;
      if (!tool) return plain(noTool(c.name, platform, toolsOn), true);
      const wrong = checkInput(tool, entry.input);
      if (wrong) return plain(wrong);
      const args = entry.input as Record<string, unknown>;
      const refused = tool.refuse?.(args);
      if (refused) return plain(refused, true);
      let target: Target | undefined;
      let inside = true;
      if (tool.path) {
        const at = confine((args[tool.path.arg] as string | undefined) ?? '.', { cwd: ctx.cwd, home: ctx.home, platform, ...(ctx.fs ? { fs: ctx.fs } : {}) });
        if (!at.ok) return plain(at.reason, true);
        target = { abs: at.abs, root: at.root };
        inside = at.inside;
      }
      if (tool.class !== 'read') {
        // The path as the model wrote it, then the real path the tool would open: a guard holds for both.
        const why = checkTool(ctx.policy(), tool.name, args, ctx.cwd) ?? (target ? checkTool(ctx.policy(), tool.name, { ...args, file_path: target.abs }, target.root) : null);
        if (why) return plain(why, true);
      }
      // Anything that would need the user's approval: outside the folder, or the shell (its tool runs in a later build).
      if (!inside || tool.class === 'shell' || !tool.run) return plain(CANNOT_ASK, true);
      const run = tool.run.bind(tool);
      return {
        parallel: tool.class === 'read',
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

  async function runTurn(text: string, ac: AbortController): Promise<TurnResult> {
    const signal = ac.signal;
    const max = h.settings?.maxCallsPerTurn ?? SETTINGS.maxCallsPerTurn.default;
    const mark = history.length;
    turnEvents = [];
    history.push({ role: 'user', blocks: [{ type: 'text', text }] });
    let calls = 0;
    let finished = 0;
    let lastUsage: Usage | undefined;

    const finish = (text: string, error?: string): TurnResult => {
      if (error) emit({ type: 'error', message: error });
      if (lastUsage) {
        const used = lastUsage.input + lastUsage.cacheRead + lastUsage.cacheWrite + lastUsage.output;
        emit({ type: 'usage', model, used, ...(info?.context !== undefined ? { window: info.context } : {}) });
      }
      const known = total !== undefined;
      const split = Object.fromEntries(Object.entries(totals).map(([m, t]) => [m, t - (baseBy[m] ?? 0)] as const).filter(([, c]) => c > 0));
      const result: TurnResult = {
        text,
        ...(known ? { cost: total! - base!, total, totals: { ...totals }, models: split } : {}),
        ...(error ? { isError: true } : {}),
        events: turnEvents,
      };
      base = total;
      baseBy = { ...totals };
      return result;
    };

    try {
      for (;;) {
        if (signal.aborted) {
          stubUnanswered();
          return finish('');
        }
        if (++calls > max) {
          const words = `Reins stopped this reply after ${max} model calls (the per-reply limit in Settings).`;
          stubUnanswered();
          // An error result carries its words as its text: that is what a Run shows ("the subagent's reply was an error (...)").
          return finish(words, words);
        }
        history = pairUp(history).msgs;
        const req: ModelRequest = {
          model,
          system: systemPrompt(cwd),
          messages: history,
          ...(toolsOn ? { tools: toolSpecs(platform) } : {}),
          ...(effort ? { effort } : {}),
          ...(info?.maxOutput !== undefined ? { maxOutput: info.maxOutput } : {}),
        };
        const reply = await callWithRetry(req, signal);
        if (reply === 'cancelled') {
          stubUnanswered();
          return finish('');
        }

        // The call finished: it is paid for and counted, whatever happens next.
        finished++;
        lastUsage = reply.usage;
        if (total !== undefined) {
          const price = priceOf(p, h, model);
          if (!price) total = undefined;
          else {
            const c = callCost(price, reply.usage);
            total += c;
            totals[model] = (totals[model] ?? 0) + c;
          }
        }

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
        history.push({ role: 'assistant', blocks, ...(reply.extra ? { extra: reply.extra } : {}) });

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
        const ctx: ToolCtx = { cwd, home: h.home, policy: opts.policy, signal, redact: red, redactAll: redAll, platform, ...(deps.fs ? { fs: deps.fs } : {}) };
        // Settles when the turn is aborted: a tool that does not look at the signal (a stuck read) is no longer waited for, and its late answer is dropped.
        const aborted = new Promise<'aborted'>((ok) => {
          if (signal.aborted) ok('aborted');
          else signal.addEventListener('abort', () => ok('aborted'), { once: true });
        });
        const runIt = async (r: { run: () => Promise<ToolOut> }): Promise<ToolOut | undefined> => {
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
        const ready = asked.map((c) => prepare(c, parsed.get(c)!, ctx));
        if (ready.every((r) => 'run' in r && r.parallel)) {
          // Only reads inside the folder: all at once, the results in the model's order. A call that was cut short by an interrupt does not count.
          const outs = await Promise.all(ready.map((r) => runIt(r as { run: () => Promise<ToolOut> })));
          asked.forEach((c, i) => { const out = outs[i]; if (out) settle(c, out.text, out.isError === true); });
        } else {
          // Anything else, one by one in the model's order; each call is judged just before it runs, not at the start of the batch.
          for (let i = 0; i < asked.length; i++) {
            if (signal.aborted) break;
            const r = i === 0 ? ready[0]! : prepare(asked[i]!, parsed.get(asked[i]!)!, ctx);
            if ('run' in r) {
              const out = await runIt(r);
              if (!out) break;
              settle(asked[i]!, out.text, out.isError === true);
            } else settle(asked[i]!, r.text, true, r.denied);
          }
        }
        if (results.length) history.push({ role: 'user', blocks: results });
        if (signal.aborted) {
          stubUnanswered();
          return finish('');
        }
      }
    } catch (e) {
      stubUnanswered();
      // A turn that got no reply at all leaves no trace: its text is sent again by whoever retries it.
      if (finished === 0) history = history.slice(0, mark);
      throw e;
    }
  }

  return {
    sessionId,
    async turn(text) {
      if (closed) throw new Error('the session is closed');
      if (turnAbort) throw new Error('a turn is already running');
      if (h.key?.(p).state === 'missing') throw new Error(`${p.label} has no key. Set ${keyEnv}, or add a key in Settings > Providers.`);
      const ac = (turnAbort = new AbortController());
      try {
        return await runTurn(text, ac);
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
    },
  };
}
