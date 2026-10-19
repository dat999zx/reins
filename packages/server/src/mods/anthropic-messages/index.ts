import { randomUUID } from 'node:crypto';
import { parseSse } from '../../loop/sse.js';
import type { Msg, ModelRequest, WireEvent } from '../../loop/types.js';
import { MAX_ARGS, MAX_CALLS, MAX_EXTRA, accumulate, count, failures, isObj, listModelIds, merge, mergeBodies, setOwn, type Obj } from '../../loop/wire-util.js';
import type { EngineHost, ModApi, ProviderManifest, Wire } from '../types.js';

/** [needs key]: confirm against the real API in Task 29. Thinking blocks go back only within the turn being continued (after a tool result). */
const THINKING_ONLY_IN_THE_TURN = true;
/** The API requires `max_tokens`; this is what a model that names none gets. */
const DEFAULT_MAX_TOKENS = 4096;

/** `{base}/v1/{tail}`; a base address that already ends in `/v1` is not given a second one. */
const endpoint = (base: string, tail: string) => {
  const b = base.replace(/\/+$/, '');
  return `${/\/v1$/.test(b) ? b : `${b}/v1`}/${tail}`;
};

/** The key header defaults to `x-api-key` when the manifest says `header` and names none. Anything unreadable is left to `send`. */
function withKeyHeader(p: ProviderManifest): ProviderManifest {
  try {
    return p.auth?.style === 'header' && !p.auth.header ? { ...p, auth: { ...p.auth, header: 'x-api-key' } } : p;
  } catch {
    return p;
  }
}

/** A whole number above 0, or undefined. */
const size = (v: unknown) => count(v) || undefined;

/** The input of a tool call: the stored arguments (parsed JSON text or an object), or `{}` when they are not an object. */
function inputOf(args: unknown): Obj {
  let v = args;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  return isObj(v) ? v : {};
}

interface Part { role: 'user' | 'assistant'; content: Obj[]; extra: Obj }

/** Blocks the stream had no name for, kept in the message's `extra` under this key and sent back first in the content. */
const UNKNOWN = 'unknownBlocks';

function userPart(m: Msg): Part {
  const content: Obj[] = [];
  for (const b of m.blocks) {
    if (b.type === 'tool_result') content.push({ type: 'tool_result', tool_use_id: b.id, content: b.content, is_error: b.isError === true });
    else if (b.type === 'text' && b.text !== '') content.push({ type: 'text', text: b.text });
  }
  return { role: 'user', content, extra: { ...m.extra } };
}

function assistantPart(m: Msg, thinking: boolean): Part {
  const { [UNKNOWN]: unknown, ...extra } = m.extra ?? {};
  const content: Obj[] = thinking && Array.isArray(unknown) ? unknown.filter((b): b is Obj => isObj(b) && typeof b.type === 'string') : [];
  for (const b of m.blocks) {
    if (b.type === 'text' && b.text !== '') content.push({ type: 'text', text: b.text });
    // A thinking block with no signature cannot be sent back: the API would refuse it.
    else if (b.type === 'thinking' && thinking && typeof b.signature === 'string' && b.signature !== '') content.push({ ...b.extra, type: 'thinking', thinking: b.text, signature: b.signature });
    else if (b.type === 'tool_call') content.push({ ...b.extra, type: 'tool_use', id: b.id, name: b.name, input: inputOf(b.args) });
  }
  return { role: 'assistant', content, extra };
}

/**
 * The neutral conversation as Messages. Consecutive messages of one role become one (the API refuses two user messages in a row), and in a
 * user message the tool results come before any text. Parts left with no content (a thinking block alone, once dropped) are left out.
 */
function toMessages(req: ModelRequest): Obj[] {
  // The turn being continued starts at the last user message that holds no tool result.
  const turn = req.messages.reduce((at, m, i) => (m.role === 'user' && !m.blocks.some((b) => b.type === 'tool_result') ? i : at), -1);
  const parts: Part[] = [];
  req.messages.forEach((m, i) => {
    const part = m.role === 'assistant' ? assistantPart(m, !THINKING_ONLY_IN_THE_TURN || i > turn) : userPart(m);
    if (!part.content.length) return;
    const last = parts.at(-1);
    if (last?.role === part.role) {
      last.content.push(...part.content);
      last.extra = merge(last.extra, part.extra);
    } else parts.push(part);
  });
  return parts.map(({ role, content, extra }) => ({
    ...extra,
    role,
    content: role === 'user' ? [...content.filter((b) => b.type === 'tool_result'), ...content.filter((b) => b.type !== 'tool_result')] : content,
  }));
}

function requestBody(req: ModelRequest, p: ProviderManifest): Obj {
  const base: Obj = { model: req.model, max_tokens: size(req.maxOutput) ?? size(p.models.find((x) => x.id === req.model)?.maxOutput) ?? DEFAULT_MAX_TOKENS, messages: toMessages(req) };
  if (req.system) base.system = req.system;
  if (req.tools?.length) base.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
  return setOwn(mergeBodies(base, p, req.model, req.effort), 'stream', true);
}

interface Call { id?: string; name: string; args: string; input?: string; extra: Obj }
type Open = { kind: 'text' } | { kind: 'thinking'; sig: string } | { kind: 'other'; block: Obj };

const TOOL_KNOWN = new Set(['type', 'id', 'name', 'input']);
const sizeOf = (k: string, v: unknown) => k.length + (typeof v === 'string' ? v.length : (JSON.stringify(v) ?? '').length);

async function* call(req: ModelRequest, p: ProviderManifest, h: EngineHost, signal: AbortSignal): AsyncGenerator<WireEvent> {
  if (!h.send) throw new Error('This host cannot send requests to a provider.');
  const res = await h.send(withKeyHeader(p), endpoint(p.baseUrl, 'messages'), {
    method: 'POST',
    headers: { 'anthropic-version': '2023-06-01', 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(requestBody(req, p)),
    signal,
  }, 'chat');
  const { fail, foreign } = failures(h, p);
  if (!res.body) throw fail((who) => `${who} sent no reply.`);

  const calls = new Map<number, Call>(); // by the block `index`, not by arrival
  const open = new Map<number, Open>(); // the blocks that are not tool calls, until they stop
  const unknown = new Map<number, Obj>();
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let extraSize = 0;
  const charge = (n: number) => {
    extraSize += n;
    if (extraSize > MAX_EXTRA) throw fail((who) => `${who} sent more extra fields than Reins keeps.`);
  };
  const tooLong = () => fail((who) => `${who} sent a tool call with more arguments than Reins accepts.`);
  let stop: string | undefined;
  let stopped = false;

  // The end of a block: a thinking block hands over its whole signature, an unknown block is kept for the message.
  const close = (at: number): WireEvent | undefined => {
    const b = open.get(at);
    open.delete(at);
    if (b?.kind === 'thinking' && b.sig !== '') return { type: 'thinking', text: '', signature: b.sig };
    if (b?.kind === 'other') unknown.set(at, b.block);
    return undefined;
  };

  try {
    read: for await (const ev of parseSse(res.body, signal, h.heartbeat)) {
      let j: unknown;
      try {
        j = JSON.parse(ev.data);
      } catch {
        continue; // one bad line does not end the reply
      }
      if (!isObj(j)) continue;
      // A block index that is not a whole number from 0 belongs to no block: the event is skipped, nothing is allocated for it.
      const at = typeof j.index === 'number' && Number.isSafeInteger(j.index) && j.index >= 0 ? j.index : undefined;
      switch (typeof j.type === 'string' ? j.type : ev.event) {
        case 'message_start': {
          const m = isObj(j.message) && isObj(j.message.usage) ? j.message.usage : {};
          Object.assign(u, { input: count(m.input_tokens), output: count(m.output_tokens), cacheRead: count(m.cache_read_input_tokens), cacheWrite: count(m.cache_creation_input_tokens) });
          break;
        }
        case 'content_block_start': {
          const b = j.content_block;
          if (at === undefined || !isObj(b)) break;
          if (b.type === 'tool_use') {
            if (calls.has(at)) break;
            if (calls.size >= MAX_CALLS) throw fail((who) => `${who} sent more than ${MAX_CALLS} tool calls in one reply.`);
            const c: Call = { name: typeof b.name === 'string' ? b.name : '', args: '', extra: {} };
            if (typeof b.id === 'string' && b.id !== '') c.id = b.id;
            if (isObj(b.input) && Object.keys(b.input).length) {
              c.input = JSON.stringify(b.input); // a provider that sends the whole input here and no pieces
              if (c.input.length > MAX_ARGS) throw tooLong();
            }
            for (const [k, v] of Object.entries(b)) {
              if (TOOL_KNOWN.has(k) || v === null || v === undefined) continue;
              charge(sizeOf(k, v));
              accumulate(c.extra, k, v);
            }
            calls.set(at, c);
            break;
          }
          if (open.size >= MAX_CALLS) throw fail((who) => `${who} sent more content blocks than Reins keeps.`);
          if (b.type === 'text') {
            open.set(at, { kind: 'text' });
            if (typeof b.text === 'string' && b.text !== '') yield { type: 'text', text: b.text };
          } else if (b.type === 'thinking') {
            const sig = typeof b.signature === 'string' ? b.signature : '';
            charge(sig.length);
            open.set(at, { kind: 'thinking', sig });
            if (typeof b.thinking === 'string' && b.thinking !== '') yield { type: 'thinking', text: b.thinking };
          } else {
            charge(sizeOf('block', b));
            open.set(at, { kind: 'other', block: merge({}, b) });
          }
          break;
        }
        case 'content_block_delta': {
          const d = j.delta;
          if (!isObj(d)) break;
          // Text has no index to join on: it is streamed on whatever the index says. The rest belongs to a block.
          if (d.type === 'text_delta') {
            if (typeof d.text === 'string' && d.text !== '') yield { type: 'text', text: d.text };
            break;
          }
          if (d.type === 'thinking_delta') {
            if (typeof d.thinking === 'string' && d.thinking !== '') yield { type: 'thinking', text: d.thinking };
            break;
          }
          if (at === undefined) break;
          const b = open.get(at);
          if (d.type === 'input_json_delta') {
            const c = calls.get(at);
            if (c && typeof d.partial_json === 'string') {
              if (c.args.length + d.partial_json.length > MAX_ARGS) throw tooLong();
              c.args += d.partial_json;
            }
          } else if (d.type === 'signature_delta') {
            if (b?.kind === 'thinking' && typeof d.signature === 'string') {
              charge(d.signature.length);
              b.sig += d.signature;
            }
          } else if (b?.kind === 'other') {
            for (const [k, v] of Object.entries(d)) {
              if (k === 'type' || v === null || v === undefined) continue;
              charge(sizeOf(k, v));
              accumulate(b.block, k, v);
            }
          }
          break;
        }
        case 'content_block_stop': {
          const e = at === undefined ? undefined : close(at);
          if (e) yield e;
          break;
        }
        case 'message_delta': {
          if (isObj(j.delta) && typeof j.delta.stop_reason === 'string') stop = j.delta.stop_reason;
          if (isObj(j.usage)) {
            if (typeof j.usage.output_tokens === 'number') u.output = count(j.usage.output_tokens); // cumulative: the last one counts
            u.input ||= count(j.usage.input_tokens); // only when the start gave none
            u.cacheRead ||= count(j.usage.cache_read_input_tokens);
            u.cacheWrite ||= count(j.usage.cache_creation_input_tokens);
          }
          break;
        }
        case 'message_stop':
          stopped = true;
          break read;
        case 'error': {
          const e = j.error;
          throw fail((who) => `${who} reported an error`, String(isObj(e) ? (e.message ?? 'no details') : (e ?? 'no details')));
        }
        default:
          break; // ping, and any event Reins does not know
      }
    }
  } catch (e) {
    if (signal.aborted) return;
    throw foreign(e);
  }
  if (signal.aborted) return; // the caller stopped it: no half calls, no done
  if (!stopped) throw fail((who) => `${who}'s reply ended before it was complete.`);

  for (const at of [...open.keys()].sort((a, b) => a - b)) {
    const e = close(at);
    if (e) yield e;
  }
  for (const [, c] of [...calls].sort((a, b) => a[0] - b[0])) {
    yield { type: 'tool_call', id: c.id ?? `toolu_${randomUUID().slice(0, 8)}`, name: c.name, args: c.args !== '' ? c.args : c.input ?? '{}', ...(Object.keys(c.extra).length ? { extra: c.extra } : {}) };
  }
  yield { type: 'usage', usage: { ...u, reasoning: 0 } };
  const unknownBlocks = [...unknown].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
  yield { type: 'done', ...(stop ? { stop } : {}), ...(unknownBlocks.length ? { extra: { [UNKNOWN]: unknownBlocks } } : {}) };
}

/** `modelsUrl`, or `{baseUrl}/v1/models`; the provider's own page size is raised so one request lists them all. */
const listModels = (p: ProviderManifest, h: EngineHost, signal: AbortSignal) =>
  listModelIds(p, h, signal, p.modelsUrl ?? `${endpoint(p.baseUrl, 'models')}?limit=1000`);

const wire: Wire = { call, listModels };

export default function activate(api: ModApi): void {
  api.registerProtocol({ id: 'anthropic-messages', conversation: 'reins', wire });
}
