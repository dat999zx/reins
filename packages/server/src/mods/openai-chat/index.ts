import { randomUUID } from 'node:crypto';
import { readBounded } from '../../loop/bounded.js';
import { parseSse } from '../../loop/sse.js';
import type { Extra, Msg, ModelRequest, Usage, WireEvent } from '../../loop/types.js';
import type { EngineHost, ModApi, ProviderManifest, Wire } from '../types.js';

/** What one reply may hold, in characters (text and thinking are streamed on and not counted), and the model list in bytes. */
const MAX_ARGS = 4 * 1024 * 1024;
const MAX_CALLS = 128;
const MAX_EXTRA = 256 * 1024;
const MAX_LIST = 1024 * 1024;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
// An own property even for the key `__proto__`, which a plain assignment would take for the prototype.
const setOwn = (o: Obj, k: string, v: unknown) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

/** `b` over `a`: objects are merged, anything else (arrays too) is replaced. Returns a new object; neither input is changed. */
function merge(a: Obj, b: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(a)) setOwn(out, k, v);
  for (const [k, v] of Object.entries(b)) {
    const cur = Object.hasOwn(out, k) ? out[k] : undefined;
    setOwn(out, k, isObj(v) ? merge(isObj(cur) ? cur : {}, v) : v);
  }
  return out;
}

/** Streamed unknown fields add up: text joins, lists extend, objects merge, anything else is replaced. */
function accumulate(into: Obj, k: string, v: unknown) {
  const cur = Object.hasOwn(into, k) ? into[k] : undefined;
  if (typeof cur === 'string' && typeof v === 'string') setOwn(into, k, cur + v);
  else if (Array.isArray(cur) && Array.isArray(v)) setOwn(into, k, [...cur, ...v]);
  else if (isObj(cur) && isObj(v)) setOwn(into, k, merge(cur, v));
  else setOwn(into, k, v);
}

const reasoningField = (p: ProviderManifest) => p.reasoning?.field ?? 'reasoning_content';

/** Most of a provider's error text that is shown, after redacting. */
const MAX_ERROR_TEXT = 500;
/** What an error says when the host's sanitizer fails: built without calling it again. */
const HIDDEN = 'The request failed and its details were hidden.';

/**
 * Makes the errors of ONE call of the wire. Each is a new Error whose whole message went through the host's `redact` (provider text
 * included), cut after redacting to MAX_ERROR_TEXT plus the head; without a `redact` the provider's text and the manifest's label are
 * left out. `own` holds this call's errors only, so an error from anywhere else, an earlier call's included, is never taken for one.
 */
function failures(h: EngineHost, p: ProviderManifest) {
  const own = new WeakSet<Error>();
  const fail = (what: (who: string) => string, provider?: string): Error => {
    let e: Error;
    try {
      const head = what(p.label);
      const max = head.length + 2 + MAX_ERROR_TEXT;
      let text = what('The provider');
      if (h.redact) {
        // The host's answer is held to its contract: a string of at most `max` characters. Anything else is not used.
        const got: unknown = h.redact(`${head}${provider ? `: ${provider}` : ''}`, max);
        if (typeof got !== 'string' || got.length > max) throw new Error('the sanitizer broke its contract');
        text = got;
      }
      e = new Error(text);
    } catch {
      e = new Error(HIDDEN); // the sanitizer itself failed: a constant, and it is not asked again
    }
    own.add(e);
    return e;
  };
  return { fail, own };
}

/** The neutral conversation as chat messages. Every tool result is its own `tool` message, and comes before any text of the same turn. */
function toMessages(req: ModelRequest, p: ProviderManifest): Obj[] {
  const out: Obj[] = [];
  if (req.system) out.push({ role: 'system', content: req.system });
  for (const m of req.messages) out.push(...(m.role === 'assistant' ? [assistant(m, p)] : user(m)));
  return out;
}

function user(m: Msg): Obj[] {
  const out: Obj[] = [];
  for (const b of m.blocks) if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.id, content: b.content });
  const text = m.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n\n');
  if (text !== '' || !out.length) out.push({ ...m.extra, role: 'user', content: text });
  return out;
}

function assistant(m: Msg, p: ProviderManifest): Obj {
  const text = m.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const thinking = m.blocks.flatMap((b) => (b.type === 'thinking' ? [b.text] : [])).join('');
  const calls = m.blocks.flatMap((b) =>
    b.type === 'tool_call'
      ? [{ ...b.extra, id: b.id, type: 'function', function: { name: b.name, arguments: typeof b.args === 'string' ? b.args : JSON.stringify(b.args ?? {}) } }]
      : []);
  return {
    ...m.extra,
    role: 'assistant',
    content: text !== '' ? text : calls.length ? null : '',
    ...(p.reasoning?.echo && thinking !== '' ? { [reasoningField(p)]: thinking } : {}),
    ...(calls.length ? { tool_calls: calls } : {}),
  };
}

function requestBody(req: ModelRequest, p: ProviderManifest): Obj {
  const base: Obj = { model: req.model, messages: toMessages(req, p) };
  if (req.tools?.length) base.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
  if (p.usage?.streamOptions !== false) base.stream_options = { include_usage: true };
  const layers = [p.body, p.models.find((x) => x.id === req.model)?.body, p.efforts?.find((e) => e.id === req.effort)?.body];
  const body = layers.reduce<Obj>((acc, l) => (l ? merge(acc, l) : acc), base);
  return setOwn(body, 'stream', true);
}

/** A count from a provider: a whole number from 0 up. A fraction is cut down; a negative, odd or unsafe value is 0. */
const count = (v: unknown) => {
  const n = typeof v === 'number' ? Math.floor(v) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

/**
 * Spec 4.7: `input` is what the prompt count (`prompt_tokens`, or the `input_tokens` spelling) holds beyond the cache reads and writes.
 * `output` is `completion_tokens` or the `output_tokens` spelling. `reasoning` is informational and kept apart: billing uses `output`,
 * and not every provider's completion count is known to include it, so it is not clamped to `output`.
 */
function usageOf(u: Obj | undefined): Usage {
  const prompt = isObj(u?.prompt_tokens_details) ? u.prompt_tokens_details : {};
  const completion = isObj(u?.completion_tokens_details) ? u.completion_tokens_details : {};
  const cacheRead = count(prompt.cached_tokens) || count(u?.prompt_cache_hit_tokens) || count(u?.cache_read_input_tokens);
  const cacheWrite = count(u?.cache_creation_input_tokens) || count(prompt.cache_write_tokens);
  return {
    input: Math.max(0, (count(u?.prompt_tokens) || count(u?.input_tokens)) - cacheRead - cacheWrite),
    output: count(u?.completion_tokens) || count(u?.output_tokens),
    cacheRead,
    cacheWrite,
    reasoning: count(completion.reasoning_tokens),
  };
}

interface Call { id?: string; name: string; args: string; extra: Obj }

const TOOL_KNOWN = new Set(['index', 'id', 'type', 'function']);

async function* call(req: ModelRequest, p: ProviderManifest, h: EngineHost, signal: AbortSignal): AsyncGenerator<WireEvent> {
  if (!h.send) throw new Error('This host cannot send requests to a provider.');
  const res = await h.send(p, `${p.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(requestBody(req, p)),
    signal,
  }, 'chat');
  const { fail, own } = failures(h, p);
  if (!res.body) throw fail((who) => `${who} sent no reply.`);

  const known = new Set(['role', 'content', 'tool_calls', 'reasoning_content', 'reasoning', reasoningField(p)]);
  const reasoningFields = [...new Set([reasoningField(p), 'reasoning_content', 'reasoning'])];
  const calls = new Map<number, Call>(); // by the provider's `index`, not by arrival
  const messageExtra: Obj = {};
  let extraSize = 0;
  const addExtra = (into: Obj, k: string, v: unknown) => {
    extraSize += k.length + (typeof v === 'string' ? v.length : (JSON.stringify(v) ?? '').length);
    if (extraSize > MAX_EXTRA) throw fail((who) => `${who} sent more extra fields than Reins keeps.`);
    accumulate(into, k, v);
  };
  let usage: Obj | undefined;
  let stop: string | undefined;
  let last = -1; // the call the latest delta without an index belongs to

  try {
    for await (const ev of parseSse(res.body, signal)) {
      if (ev.data.trim() === '[DONE]') break;
      let j: unknown;
      try {
        j = JSON.parse(ev.data);
      } catch {
        continue; // one bad line does not end the reply
      }
      if (!isObj(j)) continue;
      if (isObj(j.error)) throw fail((who) => `${who} reported an error`, String(j.error.message ?? 'no details'));
      if (isObj(j.usage)) usage = j.usage;
      const choice = Array.isArray(j.choices) ? j.choices[0] : undefined;
      if (!isObj(choice)) continue;
      if (typeof choice.finish_reason === 'string') stop = choice.finish_reason;
      const delta = choice.delta;
      if (!isObj(delta)) continue;

      for (const f of reasoningFields) {
        const t = delta[f];
        if (typeof t === 'string' && t !== '') {
          yield { type: 'thinking', text: t };
          break;
        }
      }
      if (typeof delta.content === 'string' && delta.content !== '') yield { type: 'text', text: delta.content };

      for (const raw of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        if (!isObj(raw)) continue;
        // A provider that sends no usable index: a new id starts the next call, anything else goes on with the latest.
        const at = typeof raw.index === 'number' && Number.isSafeInteger(raw.index) && raw.index >= 0
          ? raw.index
          : typeof raw.id === 'string' && raw.id !== '' ? last + 1 : Math.max(last, 0);
        last = at;
        let c = calls.get(at);
        if (!c) {
          if (calls.size >= MAX_CALLS) throw fail((who) => `${who} sent more than ${MAX_CALLS} tool calls in one reply.`);
          calls.set(at, (c = { name: '', args: '', extra: {} }));
        }
        if (typeof raw.id === 'string' && raw.id !== '' && !c.id) c.id = raw.id;
        const fn = isObj(raw.function) ? raw.function : {};
        if (typeof fn.name === 'string' && fn.name !== '' && !c.name) c.name = fn.name;
        if (typeof fn.arguments === 'string') {
          if (c.args.length + fn.arguments.length > MAX_ARGS) throw fail((who) => `${who} sent a tool call with more arguments than Reins accepts.`);
          c.args += fn.arguments;
        }
        for (const [k, v] of Object.entries(raw)) if (!TOOL_KNOWN.has(k) && v !== null && v !== undefined) addExtra(c.extra, k, v);
      }
      for (const [k, v] of Object.entries(delta)) if (!known.has(k) && v !== null && v !== undefined) addExtra(messageExtra, k, v);
    }
  } catch (e) {
    if (signal.aborted) return;
    // This call's own errors go on as they are. Anything else (a read that failed, a stream that is not valid, a hostile value) is
    // rebuilt: a new error with the host's sanitizer over the whole text. If looking at it fails, the error is a constant.
    let out: Error;
    try {
      out = own.has(e as Error) ? (e as Error) : fail((who) => `${who}'s reply was cut off`, e instanceof Error ? String(e.message) : String(e));
    } catch {
      out = new Error(HIDDEN);
    }
    throw out;
  }
  if (signal.aborted) return; // the caller stopped it: no half calls, no done

  for (const [, c] of [...calls].sort((a, b) => a[0] - b[0])) {
    const extra: Extra = c.extra;
    yield { type: 'tool_call', id: c.id ?? `call_${randomUUID().slice(0, 8)}`, name: c.name, args: c.args === '' ? '{}' : c.args, ...(Object.keys(extra).length ? { extra } : {}) };
  }
  yield { type: 'usage', usage: usageOf(usage) };
  yield { type: 'done', ...(stop ? { stop } : {}), ...(Object.keys(messageExtra).length ? { extra: messageExtra } : {}) };
}

/** `{ data: [{ id }] }`, or a bare list. Sorted; undefined when the request or the reading fails, the body is over 1 MiB, or nothing is listed. */
async function listModels(p: ProviderManifest, h: EngineHost, signal: AbortSignal): Promise<string[] | undefined> {
  try {
    if (!h.send) return undefined;
    const url = p.modelsUrl ?? `${p.baseUrl.replace(/\/+$/, '')}/models`;
    const res = await h.send(p, url, { method: 'GET', headers: { accept: 'application/json' }, signal }, 'models');
    const { text, over } = await readBounded(res, MAX_LIST);
    if (over) return undefined;
    const body: unknown = JSON.parse(text);
    const list = Array.isArray(body) ? body : isObj(body) && Array.isArray(body.data) ? body.data : undefined;
    const ids = (list ?? []).flatMap((x: unknown) => (typeof x === 'string' ? [x] : isObj(x) && typeof x.id === 'string' ? [x.id] : []));
    return ids.length ? [...new Set(ids)].sort() : undefined;
  } catch {
    return undefined;
  }
}

const wire: Wire = { call, listModels };

export default function activate(api: ModApi): void {
  api.registerProtocol({ id: 'openai-chat', conversation: 'reins', wire });
}
