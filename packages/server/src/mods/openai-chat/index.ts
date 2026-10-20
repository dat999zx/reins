import { randomUUID } from 'node:crypto';
import { parseSse } from '../../loop/sse.js';
import type { Extra, Msg, ModelRequest, Usage, WireEvent } from '../../loop/types.js';
import { MAX_ARGS, MAX_CALLS, MAX_EXTRA, accumulate, count, failures, isObj, listModelIds, mergeBodies, setOwn, type Obj } from '../../loop/wire-util.js';
import type { EngineHost, ModApi, ProviderManifest, Wire } from '../types.js';

const reasoningField = (p: ProviderManifest) => p.reasoning?.field ?? 'reasoning_content';

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
  return setOwn(mergeBodies(base, p, req.model, req.effort), 'stream', true);
}

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
  const { fail, foreign } = failures(h, p);
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
    for await (const ev of parseSse(res.body, signal, h.heartbeat)) {
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
    throw foreign(e);
  }
  if (signal.aborted) return; // the caller stopped it: no half calls, no done

  for (const [, c] of [...calls].sort((a, b) => a[0] - b[0])) {
    const extra: Extra = c.extra;
    yield { type: 'tool_call', id: c.id ?? `call_${randomUUID().slice(0, 8)}`, name: c.name, args: c.args === '' ? '{}' : c.args, ...(Object.keys(extra).length ? { extra } : {}) };
  }
  yield { type: 'usage', usage: usageOf(usage) };
  yield { type: 'done', ...(stop ? { stop } : {}), ...(Object.keys(messageExtra).length ? { extra: messageExtra } : {}) };
}

const listRequest = (p: ProviderManifest) => ({ manifest: p, url: p.modelsUrl ?? `${p.baseUrl.replace(/\/+$/, '')}/models`, headers: { accept: 'application/json' } });
const listModels = (p: ProviderManifest, h: EngineHost, signal: AbortSignal) => listModelIds(listRequest(p), h, signal);

const wire: Wire = { call, listRequest, listModels };

export default function activate(api: ModApi): void {
  api.registerProtocol({ id: 'openai-chat', conversation: 'reins', wire });
}
