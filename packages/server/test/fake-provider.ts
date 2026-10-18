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
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (wire === 'chat') {
      for (const c of m.tool_calls ?? []) calls.add(c.id);
      if (m.role === 'tool') results.add(m.tool_call_id);
    } else {
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'tool_use') calls.add(b.id);
        if (b.type === 'tool_result') results.add(b.tool_use_id);
      }
    }
  }
  const noResult = [...calls].find((id) => !results.has(id));
  if (noResult) return wire === 'chat' ? `tool_call_id ${noResult} has no matching tool result` : `tool_use ids were found without tool_result blocks immediately after: ${noResult}`;
  const noCall = [...results].find((id) => !calls.has(id));
  if (noCall) return wire === 'chat' ? `tool_call_id ${noCall} has no matching tool call` : `unexpected tool_use_id ${noCall} found in tool_result blocks: no matching tool_use`;
  return undefined;
}

export async function startFakeProvider(o: { strictPairs?: boolean } = {}) {
  const queue: FakeReply[] = [];
  const requests: FakeRequest[] = [];

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
    const bad = o.strictPairs ? unpaired(wire, body) : undefined;
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
      const t = setTimeout(() => done(true), r.hangMs);
      t.unref();
      res.on('close', () => { clearTimeout(t); done(false); });
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
    close: () => new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections(); }),
  };
}
