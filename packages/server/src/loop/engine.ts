// The API agent loop, part 1 (spec 4.1): one model call per step, cost, retries, errors, interrupt, the per-reply call cap. No tools run yet:
// a tool call is answered with a stub. No conversation file, no compaction, no USD guard: history lives in memory for the life of the session.
import { randomUUID } from 'node:crypto';
import type { Engine, EngineEvent, EngineProbe, EngineSession, OpenOptions, TurnResult } from '@reins/core';
import type { EngineHost, ProviderManifest, Wire } from '../mods/types.js';
import { SETTINGS } from '../settings.js';
import { callCost, priceOf } from './cost.js';
import { classify, retryDelay, sleep as realSleep, STALL_MS, TRIES, WORDS, type ErrorClass } from './retry.js';
import { systemPrompt } from './system.js';
import type { Block, Extra, ModelRequest, Msg, Usage, WireEvent } from './types.js';

const STUB = 'Tools come in a later build.';
const INTERRUPTED = 'Interrupted; the tool did not finish.';

/** The clock and the dice of the retry back-off, for tests. */
export interface LoopDeps {
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

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
  const keyEnv = p.auth?.keyEnv[0] ?? 'a key';
  const red = (t: string, max?: number) => (h.redact ? h.redact(t, max) : max === undefined ? t : t.slice(0, max));

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
        const parsed = new Map<string, { input: unknown; bad?: string }>();
        const blocks = reply.blocks.map((b): Block => {
          if (b.type !== 'tool_call') return b;
          try {
            const input: unknown = JSON.parse(b.args as string);
            parsed.set(b.id, { input });
            return { ...b, args: input };
          } catch (e) {
            parsed.set(b.id, { input: b.args, bad: red(`Your arguments were not valid JSON: ${(e as Error).message}. Call the tool again.`) });
            return b;
          }
        });
        history.push({ role: 'assistant', blocks, ...(reply.extra ? { extra: reply.extra } : {}) });

        // ponytail: the loop must run text and thinking through StreamRedactor before they become events or history (a key split across two deltas); it is wired in a later task.
        const thought = blocks.flatMap((b) => (b.type === 'thinking' ? [b.text] : [])).join('');
        if (thought !== '') emit({ type: 'thinking', tokens: Math.ceil(thought.length / 4), text: thought });
        const said = textOf(blocks);
        if (said !== '') emit({ type: 'text', text: said });
        const asked = callsOf(blocks);
        if (!asked.length) return finish(said);

        for (const c of asked) emit({ type: 'tool_call', tool: c.name, input: parsed.get(c.id)!.input });
        if (signal.aborted) {
          stubUnanswered();
          return finish('');
        }
        const results: Block[] = [];
        for (const c of asked) {
          const out = parsed.get(c.id)!.bad ?? STUB;
          emit({ type: 'tool_result', tool: c.name, output: out });
          results.push(resultBlock(c.id, out, parsed.get(c.id)!.bad !== undefined));
        }
        history.push({ role: 'user', blocks: results });
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
