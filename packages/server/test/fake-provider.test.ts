import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { startFakeProvider, type FakeReply } from './fake-provider.js';

type Fake = Awaited<ReturnType<typeof startFakeProvider>>;
let fake: Fake;
afterEach(async () => {
  await fake?.close();
});

const CHAT = '/v1/chat/completions';
const MSGS = '/v1/messages';
const post = (p: string, body: unknown, init: RequestInit = {}) => fetch(fake.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...init });
/** The `data:` payloads of an SSE body: parsed JSON, or the raw string for [DONE] and non-JSON lines. */
const datas = (s: string): any[] =>
  s.split('\n\n').filter(Boolean).map((f) => {
    const d = f.split('\n').find((l) => l.startsWith('data: '))!.slice(6);
    try { return JSON.parse(d); } catch { return d; }
  });
const chat = async (r: FakeReply, body: any = { messages: [] }) => {
  fake.push(r);
  return datas(await (await post(CHAT, body)).text());
};
const msgs = async (r: FakeReply, body: any = { messages: [] }) => {
  fake.push(r);
  return datas(await (await post(MSGS, body)).text());
};
const deltas = (chunks: any[]) => chunks.filter((c) => c !== '[DONE]' && c.choices?.length).map((c) => c.choices[0].delta);

describe('fake provider: openai chat', () => {
  it('streams text, ends with [DONE]', async () => {
    fake = await startFakeProvider();
    const c = await chat({ text: 'hello' });
    expect(deltas(c).map((d) => d.content).join('')).toBe('hello');
    expect(c.at(-1)).toBe('[DONE]');
    expect(c.find((x) => x !== '[DONE]' && x.choices?.[0]?.finish_reason)?.choices[0].finish_reason).toBe('stop');
  });

  it('reasoning goes in reasoning_content by default and in reasoning when asked', async () => {
    fake = await startFakeProvider();
    expect(deltas(await chat({ reasoning: 'think', text: 'x' })).find((d) => d.reasoning_content)?.reasoning_content).toBe('think');
    const other = deltas(await chat({ reasoning: 'think', reasoningField: 'reasoning', text: 'x' }));
    expect(other.find((d) => d.reasoning)?.reasoning).toBe('think');
    expect(other.some((d) => 'reasoning_content' in d)).toBe(false);
  });

  it('tool calls are keyed by index; split cuts the arguments across chunks', async () => {
    fake = await startFakeProvider();
    const c = await chat({ toolCalls: [{ id: 'c1', name: 'Read', args: '{"path":"a.txt"}', extra: { extra_content: { sig: 1 } } }, { name: 'Glob', args: '{}' }], split: 4 });
    const calls = deltas(c).flatMap((d) => d.tool_calls ?? []);
    expect(calls.filter((t: any) => t.index === 0).length).toBeGreaterThan(1);
    expect(calls.filter((t: any) => t.index === 0).map((t: any) => t.function.arguments).join('')).toBe('{"path":"a.txt"}');
    expect(calls.find((t: any) => t.index === 0)).toMatchObject({ id: 'c1', function: { name: 'Read' }, extra_content: { sig: 1 } });
    expect(calls.find((t: any) => t.index === 1)).toMatchObject({ id: 'call_1', function: { name: 'Glob' } });
    expect(c.find((x) => x !== '[DONE]' && x.choices?.[0]?.finish_reason)?.choices[0].finish_reason).toBe('tool_calls');
  });

  it('without split a call is one chunk', async () => {
    fake = await startFakeProvider();
    const calls = deltas(await chat({ toolCalls: [{ name: 'Read', args: '{"path":"a.txt"}' }] })).flatMap((d) => d.tool_calls ?? []);
    expect(calls).toHaveLength(1);
  });

  it('sends the usage chunk only when include_usage was asked', async () => {
    fake = await startFakeProvider();
    const asked = await chat({ text: 'x', usage: { prompt_tokens: 7, completion_tokens: 3 } }, { messages: [], stream_options: { include_usage: true } });
    expect(asked.filter((c) => c !== '[DONE]' && c.usage)).toEqual([expect.objectContaining({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })]);
    expect(asked.at(-1)).toBe('[DONE]');
    const notAsked = await chat({ text: 'x', usage: { prompt_tokens: 7 } });
    expect(notAsked.some((c) => c !== '[DONE]' && c.usage)).toBe(false);
    const falsy = await chat({ text: 'x' }, { messages: [], stream_options: { include_usage: false } });
    expect(falsy.some((c) => c !== '[DONE]' && c.usage)).toBe(false);
  });
});

describe('fake provider: anthropic messages', () => {
  const events = (s: any[]) => s.map((e) => e.type);

  it('streams text with the full event sequence and usage on message_delta', async () => {
    fake = await startFakeProvider();
    const e = await msgs({ text: 'hi', usage: { input_tokens: 12, output_tokens: 4 } });
    expect(events(e)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(e[0].message.usage.input_tokens).toBe(12);
    expect(e[2].delta).toEqual({ type: 'text_delta', text: 'hi' });
    expect(e[4]).toMatchObject({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } });
  });

  it('thinking comes first with a signature_delta', async () => {
    fake = await startFakeProvider();
    const e = await msgs({ thinking: { text: 'hmm', signature: 'sig-1' }, text: 'ok' });
    expect(e[1].content_block).toMatchObject({ type: 'thinking' });
    expect(e[2].delta).toEqual({ type: 'thinking_delta', thinking: 'hmm' });
    expect(e[3].delta).toEqual({ type: 'signature_delta', signature: 'sig-1' });
    expect(e.find((x) => x.type === 'content_block_start' && x.content_block.type === 'text').index).toBe(1);
  });

  it('tool_use arguments arrive as input_json_delta, split when asked', async () => {
    fake = await startFakeProvider();
    const e = await msgs({ toolCalls: [{ id: 'tu1', name: 'Read', args: '{"path":"a.txt"}' }], split: 3 });
    expect(e.find((x) => x.type === 'content_block_start').content_block).toMatchObject({ type: 'tool_use', id: 'tu1', name: 'Read' });
    const parts = e.filter((x) => x.type === 'content_block_delta').map((x) => x.delta);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.type === 'input_json_delta')).toBe(true);
    expect(parts.map((p) => p.partial_json).join('')).toBe('{"path":"a.txt"}');
    expect(e.find((x) => x.type === 'message_delta').delta.stop_reason).toBe('tool_use');
  });
});

describe('fake provider: odd replies', () => {
  it('status, headers and body make a raw reply', async () => {
    fake = await startFakeProvider();
    fake.push({ status: 429, headers: { 'retry-after': '2' }, body: '{"error":"slow down"}' }, { status: 500, body: 'boom' }, { status: 401, body: 'no' });
    const a = await post(CHAT, { messages: [] });
    expect([a.status, a.headers.get('retry-after'), await a.text()]).toEqual([429, '2', '{"error":"slow down"}']);
    const b = await post(MSGS, { messages: [] });
    expect([b.status, await b.text()]).toEqual([500, 'boom']);
    expect((await post(CHAT, { messages: [] })).status).toBe(401);
  });

  it('badLine puts one non-JSON SSE line in the stream', async () => {
    fake = await startFakeProvider();
    const c = await chat({ text: 'x', badLine: true });
    expect(c.filter((x) => typeof x === 'string' && x !== '[DONE]')).toHaveLength(1);
    expect(deltas(c).map((d) => d.content).join('')).toBe('x');
    const m = await msgs({ text: 'x', badLine: true });
    expect(m.filter((x) => typeof x === 'string')).toHaveLength(1);
  });

  it('dropAfter closes the socket after exactly N body bytes, short of the whole reply', async () => {
    fake = await startFakeProvider();
    fake.push({ text: 'hello world' });
    expect((await (await post(CHAT, { messages: [] })).text()).length).toBeGreaterThan(40);
    fake.push({ text: 'hello world', dropAfter: 40 });
    const got = await new Promise<{ bytes: number; complete: boolean }>((done) => {
      const req = http.request(fake.url + CHAT, { method: 'POST' }, (res) => {
        let bytes = 0;
        res.on('data', (d) => (bytes += d.length));
        res.on('error', () => {});
        res.on('close', () => done({ bytes, complete: res.complete }));
      });
      req.on('error', () => {});
      req.end('{"messages":[]}');
    });
    expect(got).toEqual({ bytes: 40, complete: false });
  });

  it('hangMs delays the first byte; an abort during the wait is honoured', async () => {
    fake = await startFakeProvider();
    fake.push({ text: 'late', hangMs: 150 });
    const t = Date.now();
    const res = await post(CHAT, { messages: [] });
    expect(Date.now() - t).toBeGreaterThanOrEqual(130);
    expect(await res.text()).toContain('late');

    fake.push({ text: 'never', hangMs: 60_000 });
    const ac = new AbortController();
    const pending = post(CHAT, { messages: [] }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(pending).rejects.toThrow();
    await fake.close(); // would hang for 60 s if the timer held the server
  });

  it('redirectTo answers 307 to another origin, which records the request that arrives', async () => {
    fake = await startFakeProvider();
    const other = await startFakeProvider();
    try {
      other.push({ text: 'there' });
      fake.push({ redirectTo: `${other.url}${CHAT}` });
      const r = await post(CHAT, { messages: [] }, { redirect: 'manual', headers: { authorization: 'Bearer k' } });
      expect([r.status, r.headers.get('location')]).toEqual([307, `${other.url}${CHAT}`]);
      expect(other.requests).toHaveLength(0);
      // A client that follows the redirect and keeps the header shows up at the other origin.
      await fetch(r.headers.get('location')!, { method: 'POST', headers: { authorization: 'Bearer k' }, body: '{}' });
      expect(other.requests).toHaveLength(1);
      expect(other.requests[0].path).toBe(CHAT);
      expect(other.requests[0].headers.authorization).toBe('Bearer k');
    } finally {
      await other.close();
    }
  });
});

describe('fake provider: server behaviour', () => {
  it('records every request: path, lower-case headers, parsed body', async () => {
    fake = await startFakeProvider();
    fake.push({ text: 'a' });
    await post('/prefix/v1/chat/completions', { model: 'm', messages: [] }, { headers: { 'X-Api-Key': 'abc', 'content-type': 'application/json' } });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].path).toBe('/prefix/v1/chat/completions');
    expect(fake.requests[0].headers['x-api-key']).toBe('abc');
    expect(fake.requests[0].body).toEqual({ model: 'm', messages: [] });
  });

  it('GET models answers the openai shape under any prefix and takes nothing from the queue', async () => {
    fake = await startFakeProvider();
    fake.push({ text: 'kept' });
    const res = await fetch(`${fake.url}/anything/v1/models`);
    const j: any = await res.json();
    expect(j.object).toBe('list');
    expect(j.data.map((m: any) => m.id)).toEqual(['fake-model-1', 'fake-model-2']);
    expect(deltas(datas(await (await post(CHAT, { messages: [] })).text())).map((d) => d.content).join('')).toBe('kept');
  });

  it('serves replies in queue order', async () => {
    fake = await startFakeProvider();
    fake.push({ text: 'one' }, { text: 'two' });
    const a = deltas(datas(await (await post(CHAT, { messages: [] })).text()));
    const b = datas(await (await post(MSGS, { messages: [] })).text());
    expect(a.map((d) => d.content).join('')).toBe('one');
    expect(b.find((e) => e.type === 'content_block_delta').delta.text).toBe('two');
  });

  it('an empty queue answers 500 and says so', async () => {
    fake = await startFakeProvider();
    for (const p of [CHAT, MSGS]) {
      const res = await post(p, { messages: [] });
      expect(res.status).toBe(500);
      expect(await res.text()).toMatch(/queue was empty/);
    }
  });

  it('an unknown route is 404', async () => {
    fake = await startFakeProvider();
    expect((await fetch(`${fake.url}/nope`)).status).toBe(404);
  });

  it('close() stops the server, even with a connection open', async () => {
    fake = await startFakeProvider();
    const url = fake.url;
    fake.push({ text: 'x', hangMs: 60_000 });
    void post(CHAT, { messages: [] }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    await fake.close();
    await expect(fetch(`${url}/v1/models`)).rejects.toThrow();
  });
});

describe('fake provider: strictPairs', () => {
  const chatCall = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{}' } }] };
  const chatResult = { role: 'tool', tool_call_id: 'c1', content: 'ok' };
  const useBlock = { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] };
  const resultBlock = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] };
  const user = { role: 'user', content: 'go' };

  it('chat: a call with no result and a result with no call are 400 naming the id; a pair passes', async () => {
    fake = await startFakeProvider({ strictPairs: true });
    const noResult = await post(CHAT, { messages: [user, chatCall] });
    expect(noResult.status).toBe(400);
    const j1: any = await noResult.json();
    expect(j1.error.message).toContain('c1');
    expect(j1.error.message).toMatch(/has no matching/);
    const noCall = await post(CHAT, { messages: [user, chatResult] });
    expect(noCall.status).toBe(400);
    expect(((await noCall.json()) as any).error.message).toContain('c1');
    fake.push({ text: 'fine' });
    expect((await post(CHAT, { messages: [user, chatCall, chatResult] })).status).toBe(200);
    expect(fake.requests).toHaveLength(3);
  });

  it('messages: a tool_use with no result and a result with no tool_use are 400 in the Anthropic error shape', async () => {
    fake = await startFakeProvider({ strictPairs: true });
    const noResult = await post(MSGS, { messages: [user, useBlock] });
    expect(noResult.status).toBe(400);
    const j1: any = await noResult.json();
    expect(j1).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
    expect(j1.error.message).toContain('tu1');
    const noCall = await post(MSGS, { messages: [user, resultBlock] });
    expect(noCall.status).toBe(400);
    expect(((await noCall.json()) as any).error.message).toContain('tu1');
    fake.push({ text: 'fine' });
    expect((await post(MSGS, { messages: [user, useBlock, resultBlock] })).status).toBe(200);
  });

  it('a 400 from strictPairs does not use up a queued reply; without strictPairs orphans pass', async () => {
    fake = await startFakeProvider({ strictPairs: true });
    fake.push({ text: 'kept' });
    expect((await post(CHAT, { messages: [chatCall] })).status).toBe(400);
    expect((await post(CHAT, { messages: [user] })).status).toBe(200);
    await fake.close();
    fake = await startFakeProvider();
    fake.push({ text: 'x' });
    expect((await post(CHAT, { messages: [chatCall] })).status).toBe(200);
  });
});
