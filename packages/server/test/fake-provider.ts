// A scripted provider server for tests: both wires (OpenAI chat SSE, Anthropic Messages SSE), a model list, raw error replies.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeReply = {
  status?: number; headers?: Record<string, string>; body?: string;
  text?: string; reasoning?: string; reasoningField?: 'reasoning_content' | 'reasoning';
  toolCalls?: Array<{ id?: string; name: string; args: string; extra?: Record<string, unknown> }>;
  usage?: Record<string, unknown>; split?: number; dropAfter?: number; badLine?: true; hangMs?: number;
  thinking?: { text: string; signature: string };
  redirectTo?: string; // a 307 to another origin
};

export type FakeRequest = { path: string; headers: Record<string, string>; body: any };

const chunks = (s: string, n: number): string[] => {
  const size = Math.max(1, Math.ceil(s.length / Math.max(1, n)));
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.length ? out : [''];
};

const sse = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

function chatBody(r: FakeReply, includeUsage: boolean): string {
  const frame = (delta: object, finish: string | null = null) => sse({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] });
  let out = frame({ role: 'assistant', content: '' });
  if (r.badLine) out += 'data: this is not json\n\n';
  if (r.reasoning) out += frame({ [r.reasoningField ?? 'reasoning_content']: r.reasoning });
  if (r.text) out += frame({ content: r.text });
  (r.toolCalls ?? []).forEach((c, index) => {
    const pieces = chunks(c.args, r.split ?? 1);
    out += frame({ tool_calls: [{ index, id: c.id ?? `call_${index}`, type: 'function', function: { name: c.name, arguments: pieces[0] }, ...c.extra }] });
    for (const p of pieces.slice(1)) out += frame({ tool_calls: [{ index, function: { arguments: p } }] });
  });
  out += frame({}, r.toolCalls?.length ? 'tool_calls' : 'stop');
  if (includeUsage) out += sse({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model: 'fake', choices: [], usage: r.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  return out + 'data: [DONE]\n\n';
}

function messagesBody(r: FakeReply): string {
  const { output_tokens = 5, ...inputSide } = r.usage ?? { input_tokens: 10 };
  let out = sse({ type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', content: [], usage: { input_tokens: 10, ...inputSide, output_tokens: 1 } } }, 'message_start');
  if (r.badLine) out += 'event: ping\ndata: this is not json\n\n';
  let index = 0;
  const block = (start: object, deltas: object[]) => {
    out += sse({ type: 'content_block_start', index, content_block: start }, 'content_block_start');
    for (const delta of deltas) out += sse({ type: 'content_block_delta', index, delta }, 'content_block_delta');
    out += sse({ type: 'content_block_stop', index }, 'content_block_stop');
    index++;
  };
  if (r.thinking) block({ type: 'thinking', thinking: '' }, [{ type: 'thinking_delta', thinking: r.thinking.text }, { type: 'signature_delta', signature: r.thinking.signature }]);
  if (r.text) block({ type: 'text', text: '' }, [{ type: 'text_delta', text: r.text }]);
  (r.toolCalls ?? []).forEach((c, i) => {
    block({ type: 'tool_use', id: c.id ?? `toolu_${i}`, name: c.name, input: {}, ...c.extra }, chunks(c.args, r.split ?? 1).map((partial_json) => ({ type: 'input_json_delta', partial_json })));
  });
  out += sse({ type: 'message_delta', delta: { stop_reason: r.toolCalls?.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens } }, 'message_delta');
  return out + sse({ type: 'message_stop' }, 'message_stop');
}

/** The unpaired id of a request history, as the error message a strict API would give; undefined when every call has a result. */
function unpaired(wire: 'chat' | 'messages', body: any): string | undefined {
  const msgs: any[] = Array.isArray(body?.messages) ? body.messages : [];
  const noResult = (id: string) => (wire === 'chat' ? `tool_call_id ${id} has no matching tool result` : `tool_use ids were found without tool_result blocks immediately after: ${id}`);
  const noCall = (id: string) => (wire === 'chat' ? `tool_call_id ${id} has no matching tool call` : `unexpected tool_use_id ${id} found in tool_result blocks: no matching tool_use`);
  const callsOf = (m: any): string[] =>
    wire === 'chat' ? (m.role === 'assistant' ? (m.tool_calls ?? []).map((c: any) => c.id) : []) : m.role === 'assistant' ? (Array.isArray(m.content) ? m.content : []).filter((b: any) => b.type === 'tool_use').map((b: any) => b.id) : [];
  // Which results (ids, in order) sit right after message i, before any text or the next assistant message; and the index where they end.
  const resultsAfter = (i: number): { ids: string[]; end: number } => {
    const ids: string[] = [];
    if (wire === 'chat') {
      let j = i + 1;
      for (; j < msgs.length && msgs[j].role === 'tool'; j++) ids.push(msgs[j].tool_call_id);
      return { ids, end: j };
    }
    const next = msgs[i + 1];
    if (next?.role !== 'user' || !Array.isArray(next.content)) return { ids, end: i + 1 };
    // The results come first in the one user message.
    for (const b of next.content) {
      if (b.type !== 'tool_result') break;
      ids.push(b.tool_use_id);
    }
    return { ids, end: i + 2 };
  };
  const accounted = new Set<number>();
  for (let i = 0; i < msgs.length; i++) {
    const calls = callsOf(msgs[i]);
    if (!calls.length) continue;
    const { ids, end } = resultsAfter(i);
    for (let k = i + 1; k < end; k++) accounted.add(k);
    const missing = calls.find((id) => !ids.includes(id));
    if (missing) return noResult(missing);
    const stray = ids.find((id, k) => !calls.includes(id) || ids.indexOf(id) !== k);
    if (stray) return noCall(stray);
  }
  // A result anywhere else (not right after its own call message) has no call.
  const resultIds = (m: any): string[] =>
    wire === 'chat' ? (m.role === 'tool' ? [m.tool_call_id] : []) : m.role === 'user' && Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool_result').map((b: any) => b.tool_use_id) : [];
  for (let i = 0; i < msgs.length; i++) {
    const ids = resultIds(msgs[i]);
    if (ids.length && !accounted.has(i)) return noCall(ids[0]!);
  }
  // A result block after text in the same user message (messages wire): not first, so not a result of the round.
  if (wire === 'messages') {
    for (const m of msgs) {
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      let text = false;
      for (const b of m.content) {
        if (b.type !== 'tool_result') text = true;
        else if (text) return noCall(b.tool_use_id);
      }
    }
  }
  return undefined;
}

/** Whether a request carries any tool call or tool result. */
function hasToolBlocks(wire: 'chat' | 'messages', body: any): boolean {
  return (Array.isArray(body?.messages) ? body.messages : []).some((m: any) =>
    wire === 'chat' ? m.role === 'tool' || (m.tool_calls ?? []).length > 0 : (Array.isArray(m.content) ? m.content : []).some((b: any) => b.type === 'tool_use' || b.type === 'tool_result'));
}

/** `toolBlocksFail`: every request that carries a tool call or result is answered with a pairing 400 (a provider that cannot take the round at all). */
export async function startFakeProvider(o: { strictPairs?: boolean; toolBlocksFail?: boolean } = {}) {
  const queue: FakeReply[] = [];
  const requests: FakeRequest[] = [];
  let aborted = 0;   // requests the client closed while they hung (hangMs)

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0];
      let body: any = raw || undefined;
      try { if (raw) body = JSON.parse(raw); } catch { /* keep the raw text */ }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
      requests.push({ path, headers, body });
      serve(req.method ?? 'GET', path, body, res);
    });
  });

  function serve(method: string, path: string, body: any, res: http.ServerResponse) {
    if (method === 'GET' && path.endsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model-1', object: 'model' }, { id: 'fake-model-2', object: 'model' }] }));
      return;
    }
    const wire = method === 'POST' && path.endsWith('/v1/chat/completions') ? 'chat' : method === 'POST' && path.endsWith('/v1/messages') ? 'messages' : undefined;
    if (!wire) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`fake provider: no route for ${method} ${path}`);
      return;
    }
    const bad = o.strictPairs ? unpaired(wire, body) : o.toolBlocksFail && hasToolBlocks(wire, body)
      ? (wire === 'chat' ? "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'." : 'unexpected tool_use_id toolu_x found in tool_result blocks')
      : undefined;
    if (bad) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(wire === 'chat' ? { error: { message: bad } } : { type: 'error', error: { type: 'invalid_request_error', message: bad } }));
      return;
    }
    const r = queue.shift();
    if (!r) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('fake provider: the reply queue was empty (a test forgot to push)');
      return;
    }
    // hangMs: nothing is sent until the delay passes; a client abort ends the wait and the timer never holds the process.
    const wait = new Promise<boolean>((done) => {
      if (!r.hangMs) return done(true);
      let waiting = true;
      const t = setTimeout(() => { waiting = false; done(true); }, r.hangMs);
      t.unref();
      res.on('close', () => { clearTimeout(t); if (waiting) aborted++; done(false); });
    });
    void wait.then((go) => {
      if (!go || res.destroyed) return;
      if (r.redirectTo) {
        res.writeHead(307, { location: r.redirectTo });
        res.end();
      } else if (r.status !== undefined || r.body !== undefined) {
        res.writeHead(r.status ?? 200, r.headers ?? {});
        res.end(r.body ?? '');
      } else {
        const text = wire === 'chat' ? chatBody(r, body?.stream_options?.include_usage === true) : messagesBody(r);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...r.headers });
        if (r.dropAfter === undefined) return void res.end(text);
        res.flushHeaders();
        res.write(Buffer.from(text).subarray(0, r.dropAfter), () => res.socket?.destroy());
      }
    });
  }

  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    push: (...r: FakeReply[]) => void queue.push(...r),
    requests,
    aborted: () => aborted,
    close: () => new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections(); }),
  };
}
