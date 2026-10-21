import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUNDLED_MODS, startMods } from '../src/engines.js';
import type { Block, ModelRequest, Msg, Usage, WireEvent } from '../src/loop/types.js';
import type { EngineHost, Mods, Protocol, ProviderManifest, Wire } from '../src/mods/types.js';
import { Redactor, redactCut, setKey } from '../src/secrets.js';
import { makeSend } from '../src/send.js';
import { startFakeProvider, type FakeReply } from './fake-provider.js';
import { tempHome } from './mods-harness.js';

const KEY = 'sk-test-0123456789abcdef';
const enc = new TextEncoder();

type Fake = Awaited<ReturnType<typeof startFakeProvider>>;
let home: ReturnType<typeof tempHome>;
let a: Fake;
let mods: Mods;
let wire: Wire;
let urls: string[]; // every address the host's fetch was given

beforeEach(async () => {
  home = tempHome();
  a = await startFakeProvider();
  setKey(home.home, 'p', KEY);
  mods = await startMods({ dir: home.home, env: {} });
  wire = (mods.registry.get<Protocol>('protocol-impl', 'openai-chat') as Extract<Protocol, { conversation: 'reins' }>).wire;
  urls = [];
});
afterEach(async () => {
  mods.dispose();
  await a.close();
  home.cleanup();
});

const manifest = (over: Partial<ProviderManifest> = {}): ProviderManifest => ({
  reins: 1, id: 'p', kind: 'provider', version: '1', label: 'Fake', protocol: 'openai-chat', baseUrl: `${a.url}/v1`,
  auth: { style: 'bearer', keyEnv: ['P_API_KEY'] }, defaultModel: 'm', models: [{ id: 'm' }], ...over,
});

function host(o: { fetch?: typeof fetch; consent?: boolean; withSend?: boolean; noRedact?: boolean; redact?: EngineHost['redact']; env?: NodeJS.ProcessEnv } = {}): EngineHost {
  const base = o.fetch ?? fetch;
  const redactor = new Redactor({ home: home.home, env: o.env ?? {}, keyEnvNames: () => ['P_API_KEY', 'Q_API_KEY'] });
  const send = makeSend({
    secrets: () => new Map([['p', KEY]]),
    env: {},
    redactor,
    consent: () => o.consent ?? true,
    fetch: ((u: string, init: RequestInit) => { urls.push(String(u)); return base(u, init); }) as typeof fetch,
  });
  return {
    env: {}, home: home.home, onApprove: async () => ({ behavior: 'allow' }), onLive: () => {},
    ...(o.withSend === false ? {} : { send }), ...(o.noRedact ? {} : { redact: o.redact ?? ((t: string, max?: number) => redactCut(redactor, t, max)) }),
  };
}

const user = (text: string): Msg => ({ role: 'user', blocks: [{ type: 'text', text }] });
const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({ model: 'm', system: 'be brief', messages: [user('hi')], ...over });

async function run(r: ModelRequest = req(), p = manifest(), h = host(), signal = new AbortController().signal): Promise<WireEvent[]> {
  const out: WireEvent[] = [];
  for await (const e of wire.call(r, p, h, signal)) out.push(e);
  return out;
}
const types = (ev: WireEvent[]) => ev.map((e) => e.type);
const usageOf = (ev: WireEvent[]) => ev.filter((e): e is Extract<WireEvent, { type: 'usage' }> => e.type === 'usage');
const calls = (ev: WireEvent[]) => ev.filter((e): e is Extract<WireEvent, { type: 'tool_call' }> => e.type === 'tool_call');

// Raw streams, for what the fake's own reply shapes cannot say.
const data = (o: unknown) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`;
const delta = (d: object, finish: string | null = null) => data({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
const raw = (...frames: string[]): FakeReply => ({ body: frames.join(''), headers: { 'content-type': 'text/event-stream' } });
const usageFrame = (usage: object) => data({ choices: [], usage });

describe('the protocol is registered', () => {
  it('openai-chat is a bundled protocol of the reins kind after loadMods, with no problem', () => {
    expect(mods.registry.ids('protocol')).toContain('openai-chat');
    const m = mods.mods.find((x) => x.id === 'openai-chat')!;
    expect(m).toMatchObject({ kind: 'protocol', source: 'bundled', problems: [], hasCode: true });
    const p = mods.registry.get<Protocol>('protocol-impl', 'openai-chat')!;
    expect(p.conversation).toBe('reins');
    expect(typeof (p as { wire: Wire }).wire.call).toBe('function');
    expect(typeof (p as { wire: Wire }).wire.listModels).toBe('function');
  });

  it('its folder holds mod.json and the file main names, so the build copies and counts it', () => {
    const dir = path.join(BUNDLED_MODS, 'openai-chat');
    const mj = JSON.parse(fs.readFileSync(path.join(dir, 'mod.json'), 'utf8')) as { main: string };
    expect(fs.existsSync(path.join(dir, mj.main.replace(/\.js$/, '.ts')))).toBe(true);
  });
});

describe('the request', () => {
  it('posts to {baseUrl}/chat/completions with the key, json, and a streamed body', async () => {
    a.push({ text: 'ok' });
    await run();
    expect(a.requests).toHaveLength(1);
    const r = a.requests[0];
    expect(r.path).toBe('/v1/chat/completions');
    expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.body).toMatchObject({
      model: 'm', stream: true, stream_options: { include_usage: true },
      messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }],
    });
    expect(r.body.tools).toBeUndefined();
  });

  it('a base address with a trailing slash does not double it', async () => {
    a.push({ text: 'ok' });
    await run(req(), manifest({ baseUrl: `${a.url}/v1/` }));
    expect(a.requests[0].path).toBe('/v1/chat/completions');
  });

  it('the key is in the header and nowhere in the address', async () => {
    a.push({ text: 'ok' }, { text: 'ok' });
    await run();
    await run(req(), manifest({ auth: { style: 'header', header: 'X-Api-Key', keyEnv: ['P_API_KEY'] } }));
    expect(urls).toHaveLength(2);
    for (const u of urls) expect(decodeURIComponent(u)).not.toContain(KEY);
    expect(a.requests[1].headers['x-api-key']).toBe(KEY);
    expect(a.requests[1].headers.authorization).toBeUndefined();
  });

  it('a keyless provider sends no auth header; a provider with a named header sends only that', async () => {
    a.push({ text: 'ok' });
    await run(req(), manifest({ auth: { style: 'none', keyEnv: [] } }));
    expect(Object.keys(a.requests[0].headers).filter((k) => /auth|key/i.test(k))).toEqual([]);
  });

  it('manifest headers are added', async () => {
    a.push({ text: 'ok' });
    await run(req(), manifest({ headers: { 'HTTP-Referer': 'https://reins.example', 'X-Title': 'Reins' } }));
    expect(a.requests[0].headers['http-referer']).toBe('https://reins.example');
    expect(a.requests[0].headers['x-title']).toBe('Reins');
  });

  it('the body is merged: manifest, then the model, then the effort; later wins, objects merge, arrays are replaced', async () => {
    a.push({ text: 'ok' });
    const p = manifest({
      body: { thinking: { type: 'enabled', budget: 1 }, stop: ['a', 'b'], level: 'manifest', only: { manifest: true } },
      models: [{ id: 'm', body: { thinking: { budget: 2 }, stop: ['c'], level: 'model' } }],
      efforts: [{ id: 'high', label: 'High', body: { thinking: { extra: 3 }, level: 'effort' } }, { id: 'low', label: 'Low', body: { level: 'low' } }],
    });
    await run(req({ effort: 'high' }), p);
    expect(a.requests[0].body).toMatchObject({
      model: 'm', stream: true,
      thinking: { type: 'enabled', budget: 2, extra: 3 },
      stop: ['c'], level: 'effort', only: { manifest: true },
    });
    expect(p.body).toEqual({ thinking: { type: 'enabled', budget: 1 }, stop: ['a', 'b'], level: 'manifest', only: { manifest: true } }); // the manifest is not changed
  });

  it('no effort or an unknown one adds no effort body; another model gets no model body', async () => {
    a.push({ text: 'ok' }, { text: 'ok' });
    const p = manifest({ body: { level: 'manifest' }, models: [{ id: 'm', body: { level: 'model' } }, { id: 'n' }], efforts: [{ id: 'high', label: 'High', body: { level: 'effort' } }] });
    await run(req({ effort: 'nope' }), p);
    await run(req({ model: 'n', effort: 'high' }), p);
    expect(a.requests.map((r) => r.body.level)).toEqual(['model', 'effort']);
  });

  it('a __proto__ key in a body layer is data, not a prototype', async () => {
    a.push({ text: 'ok' });
    const poisoned = JSON.parse('{"__proto__":{"polluted":true},"nested":{"__proto__":{"polluted":true}}}') as Record<string, unknown>;
    await run(req(), manifest({ body: poisoned, models: [{ id: 'm', body: JSON.parse('{"__proto__":{"also":1}}') as Record<string, unknown> }] }));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).also).toBeUndefined();
    expect(a.requests).toHaveLength(1);
    expect(a.requests[0].body.model).toBe('m');
    expect(a.requests[0].body.stream).toBe(true);
  });

  it('stream_options is sent unless the manifest says false; stream stays true', async () => {
    a.push({ text: 'ok' }, { text: 'ok' }, { text: 'ok' });
    await run(req(), manifest({ usage: { streamOptions: true } }));
    await run(req(), manifest({ usage: { streamOptions: false } }));
    await run(req(), manifest({ usage: { streamOptions: false }, body: { stream: false } }));
    expect(a.requests.map((r) => r.body.stream_options)).toEqual([{ include_usage: true }, undefined, undefined]);
    expect(a.requests.map((r) => r.body.stream)).toEqual([true, true, true]);
  });

  it('tools become function tools', async () => {
    a.push({ text: 'ok' });
    await run(req({ tools: [{ name: 'read', description: 'Read a file', schema: { type: 'object', properties: { path: { type: 'string' } } } }] }));
    expect(a.requests[0].body.tools).toEqual([{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }]);
  });

  it('a host with no send fails in plain words, and nothing is sent', async () => {
    await expect(run(req(), manifest(), host({ withSend: false }))).rejects.toThrow('This host cannot send requests to a provider.');
    expect(a.requests).toEqual([]);
  });

  it('an error status is an error, with the status and no key', async () => {
    a.push({ status: 429, body: `slow down ${KEY}` });
    const e = await run().then(() => undefined, (x: Error) => x);
    expect(e?.message).toContain('429');
    expect(e?.message).not.toContain(KEY);
  });
});

describe('messages', () => {
  it('assistant tool calls, separate tool messages for every result, then the next user text; the strict fake accepts it', async () => {
    const strict = await startFakeProvider({ strictPairs: true });
    try {
      strict.push({ text: 'done' });
      const history: Msg[] = [
        user('go'),
        { role: 'assistant', blocks: [{ type: 'text', text: 'on it' }, { type: 'tool_call', id: 'c1', name: 'read', args: { path: 'a' } }, { type: 'tool_call', id: 'c2', name: 'read', args: '{"path":"b"}' }] },
        { role: 'user', blocks: [{ type: 'tool_result', id: 'c1', content: 'A' }, { type: 'tool_result', id: 'c2', content: 'B', isError: true }, { type: 'text', text: 'and then?' }] },
      ];
      await run(req({ messages: history }), manifest({ baseUrl: `${strict.url}/v1` }));
      expect(strict.requests[0].body.messages).toEqual([
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'on it', tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
          { id: 'c2', type: 'function', function: { name: 'read', arguments: '{"path":"b"}' } },
        ] },
        { role: 'tool', tool_call_id: 'c1', content: 'A' },
        { role: 'tool', tool_call_id: 'c2', content: 'B' },
        { role: 'user', content: 'and then?' },
      ]);
    } finally {
      await strict.close();
    }
  });

  it('an assistant message with only tool calls has null content; an empty system prompt is left out', async () => {
    a.push({ text: 'ok' });
    const history: Msg[] = [
      user('go'),
      { role: 'assistant', blocks: [{ type: 'tool_call', id: 'c1', name: 'ls', args: {} }] },
      { role: 'user', blocks: [{ type: 'tool_result', id: 'c1', content: 'x' }] },
    ];
    await run(req({ system: '', messages: history }));
    const m = a.requests[0].body.messages;
    expect(m[0]).toEqual({ role: 'user', content: 'go' });
    expect(m[1]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }] });
    expect(m[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'x' });
    expect(m).toHaveLength(3); // no empty user message after the results
  });
});

describe('the stream', () => {
  it('text arrives as it is sent, then usage, then done', async () => {
    a.push(raw(delta({ role: 'assistant', content: '' }), delta({ content: 'Hel' }), delta({ content: 'lo' }), delta({}, 'stop'), usageFrame({ prompt_tokens: 3, completion_tokens: 2 }), data('[DONE]')));
    const ev = await run();
    expect(ev).toEqual([
      { type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' },
      { type: 'usage', usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
      { type: 'done', stop: 'stop' },
    ]);
  });

  it("the fake's own reply: text, usage and done", async () => {
    a.push({ text: 'Hello' });
    expect(await run()).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'usage', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
      { type: 'done', stop: 'stop' },
    ]);
  });

  it('two parallel tool calls with split arguments are joined by index, not by arrival', async () => {
    // Call 1 starts before call 0; the pieces of both are interleaved; id and name come once.
    a.push(raw(
      delta({ role: 'assistant', content: null }),
      delta({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'write', arguments: '{"pa' } }] }),
      delta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"x"' } }] }),
      delta({ tool_calls: [{ index: 1, function: { arguments: 'th":"b' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }, { index: 1, function: { arguments: '.txt"}' } }] }),
      delta({}, 'tool_calls'),
      data('[DONE]'),
    ));
    const ev = await run();
    expect(calls(ev)).toEqual([
      { type: 'tool_call', id: 'call_a', name: 'read', args: '{"x":1}' },
      { type: 'tool_call', id: 'call_b', name: 'write', args: '{"path":"b.txt"}' },
    ]);
    expect(types(ev)).toEqual(['tool_call', 'tool_call', 'usage', 'done']);
    expect(ev.at(-1)).toEqual({ type: 'done', stop: 'tool_calls' });
  });

  it("the fake's tool calls, split in pieces", async () => {
    a.push({ toolCalls: [{ id: 'one', name: 'read', args: '{"path":"alpha.txt"}' }, { id: 'two', name: 'ls', args: '{"dir":"."}' }], split: 4 });
    const ev = await run();
    expect(calls(ev).map((c) => [c.id, c.name, c.args])).toEqual([['one', 'read', '{"path":"alpha.txt"}'], ['two', 'ls', '{"dir":"."}']]);
  });

  it('a call with no arguments hands over {}; arguments that are not JSON are handed over as text', async () => {
    a.push(raw(delta({ tool_calls: [{ index: 0, id: 'x', function: { name: 'pwd' } }, { index: 1, id: 'y', function: { name: 'bad', arguments: '{oops' } }] }), data('[DONE]')));
    expect(calls(await run()).map((c) => c.args)).toEqual(['{}', '{oops']);
  });

  it('a provider that sends no index: a new id starts a call, the rest go on with the latest', async () => {
    a.push(raw(
      delta({ tool_calls: [{ id: 'a', function: { name: 'read', arguments: '{"p"' } }] }),
      delta({ tool_calls: [{ function: { arguments: ':1}' } }] }),
      delta({ tool_calls: [{ id: 'b', function: { name: 'ls', arguments: '{}' } }] }),
      data('[DONE]'),
    ));
    expect(calls(await run()).map((c) => [c.id, c.name, c.args])).toEqual([['a', 'read', '{"p":1}'], ['b', 'ls', '{}']]);
  });

  it('a call with no id gets one', async () => {
    a.push(raw(delta({ tool_calls: [{ index: 0, function: { name: 'pwd', arguments: '{}' } }] }), data('[DONE]')));
    expect(calls(await run())[0].id).toMatch(/^call_/);
  });

  it('reasoning comes from reasoning_content and from reasoning', async () => {
    a.push({ reasoning: 'think A', text: 'x', reasoningField: 'reasoning_content' }, { reasoning: 'think B', text: 'y', reasoningField: 'reasoning' });
    const one = await run();
    const two = await run();
    expect(one.filter((e) => e.type === 'thinking')).toEqual([{ type: 'thinking', text: 'think A' }]);
    expect(two.filter((e) => e.type === 'thinking')).toEqual([{ type: 'thinking', text: 'think B' }]);
    expect(types(one)).toEqual(['thinking', 'text', 'usage', 'done']);
  });

  it('the manifest field names where the reasoning is; the named field is not collected as an unknown one', async () => {
    a.push(raw(delta({ thought: 'deep' }), delta({ content: 'x' }), data('[DONE]')));
    const ev = await run(req(), manifest({ reasoning: { field: 'thought' } }));
    expect(ev.filter((e) => e.type === 'thinking')).toEqual([{ type: 'thinking', text: 'deep' }]);
    expect(ev.at(-1)).toEqual({ type: 'done' });
  });

  it('a line that is not json is skipped, and the stream goes on', async () => {
    a.push({ text: 'still here', badLine: true });
    const ev = await run();
    expect(types(ev)).toEqual(['text', 'usage', 'done']);
    a.push(raw(delta({ content: 'a' }), 'data: {"half":\n\n', 'data: 42\n\n', delta({ content: 'b' }), data('[DONE]')));
    expect((await run()).filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
  });

  it('[DONE] ends the stream: what follows is not read', async () => {
    a.push(raw(delta({ content: 'a' }), data('[DONE]'), delta({ content: 'after' })));
    const ev = await run();
    expect(ev.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'a' }]);
    expect(ev.at(-1)?.type).toBe('done');
  });

  it('a stream that ends without [DONE] still ends with done', async () => {
    a.push(raw(delta({ content: 'a' }), delta({}, 'stop')));
    const ev = await run();
    expect(types(ev)).toEqual(['text', 'usage', 'done']);
    expect(ev.at(-1)).toEqual({ type: 'done', stop: 'stop' });
  });

  it('a connection that drops mid-stream is an error, not a finished reply', async () => {
    a.push({ text: 'x'.repeat(500), dropAfter: 150 });
    await expect(run()).rejects.toThrow();
  });

  it('an error object inside the stream is an error', async () => {
    a.push(raw(delta({ content: 'a' }), data({ error: { message: 'overloaded' } })));
    await expect(run()).rejects.toThrow('Fake reported an error: overloaded');
  });

  it('an abort mid-stream stops cleanly: no more events, no done, no error, and the read is let go', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode(delta({ content: 'first' }))); }, // then it stays open
      cancel() { cancelled = true; },
    });
    const stub = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const ctl = new AbortController();
    const got: WireEvent[] = [];
    for await (const e of wire.call(req(), manifest(), host({ fetch: stub }), ctl.signal)) {
      got.push(e);
      setTimeout(() => ctl.abort(), 10);
    }
    expect(got).toEqual([{ type: 'text', text: 'first' }]);
    expect(cancelled).toBe(true);
  });

  it('an abort before the request is sent ends with the abort error from send', async () => {
    const ctl = new AbortController();
    ctl.abort();
    a.push({ text: 'x' });
    await expect(run(req(), manifest(), host(), ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(a.requests).toEqual([]);
  });
});

describe('usage', () => {
  const usageFor = async (usage: Record<string, unknown>): Promise<Usage> => {
    a.push({ text: 'x', usage });
    const u = usageOf(await run());
    expect(u).toHaveLength(1);
    return u[0].usage;
  };

  it('plain counts', async () => {
    expect(await usageFor({ prompt_tokens: 100, completion_tokens: 20 })).toEqual({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  });

  it('cached tokens are taken out of the input, once', async () => {
    expect(await usageFor({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } })).toEqual({ input: 40, output: 20, cacheRead: 60, cacheWrite: 0, reasoning: 0 });
  });

  it('the hit count of a provider that names it differently', async () => {
    expect(await usageFor({ prompt_tokens: 50, completion_tokens: 5, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 20 })).toEqual({ input: 20, output: 5, cacheRead: 30, cacheWrite: 0, reasoning: 0 });
  });

  it('cache read and cache write counts of the other spelling', async () => {
    expect(await usageFor({ prompt_tokens: 100, completion_tokens: 1, cache_read_input_tokens: 30, cache_creation_input_tokens: 20 })).toEqual({ input: 50, output: 1, cacheRead: 30, cacheWrite: 20, reasoning: 0 });
  });

  it('reasoning tokens are counted, and stay part of the output', async () => {
    expect(await usageFor({ prompt_tokens: 10, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 12 } })).toEqual({ input: 10, output: 30, cacheRead: 0, cacheWrite: 0, reasoning: 12 });
  });

  it('no usage at all gives one usage event marked unknown (zeros that mean nothing), never a known 0', async () => {
    a.push(raw(delta({ content: 'x' }), delta({}, 'stop'), data('[DONE]')));
    const ev = await run();
    expect(usageOf(ev)).toEqual([{ type: 'usage', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, unknown: true }]);
    // include_usage off: the fake sends none either
    a.push({ text: 'x' });
    expect(usageOf(await run(req(), manifest({ usage: { streamOptions: false } })))[0]).toMatchObject({ unknown: true });
    // a usage chunk, even an empty one, is a usage the server gave
    a.push(raw(delta({ content: 'x' }), delta({}, 'stop'), usageFrame({}), data('[DONE]')));
    expect(usageOf(await run())[0]!.unknown).toBeUndefined();
  });

  it('a stream with neither [DONE] nor a finish_reason is an error, not a reply; the text before it is not kept', async () => {
    a.push(raw(delta({ content: 'part' })));
    const got: WireEvent[] = [];
    const e = await (async () => { for await (const x of wire.call(req(), manifest(), host(), new AbortController().signal)) got.push(x); })().then(() => undefined, (x: Error) => x);
    expect(e?.message).toBe('The reply ended before it was complete.');
    expect(types(got)).toEqual(['text']); // streamed on, but no usage and no done: the loop keeps nothing of it
    a.push(raw(''));
    await expect(run()).rejects.toThrow('ended before it was complete');
    // a finish_reason with no [DONE] is an end
    a.push(raw(delta({ content: 'x' }), delta({}, 'stop')));
    expect(types(await run())).toEqual(['text', 'usage', 'done']);
  });

  it('never negative: a cache count above the prompt count, and negative or odd numbers', async () => {
    expect((await usageFor({ prompt_tokens: 5, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 10 } })).input).toBe(0);
    expect(await usageFor({ prompt_tokens: -4, completion_tokens: -1, prompt_tokens_details: { cached_tokens: -3 }, completion_tokens_details: { reasoning_tokens: -2 } })).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    expect(await usageFor({ prompt_tokens: '12', completion_tokens: null, prompt_tokens_details: 'x' })).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  });
});

describe('echo and pass-through', () => {
  const assistantWith = (blocks: Block[], extra?: Msg['extra']): Msg => ({ role: 'assistant', blocks, ...(extra ? { extra } : {}) });

  it('reasoning.echo sends the thinking back in the named field of the assistant message; without echo it is dropped', async () => {
    a.push({ reasoning: 'I will think', text: 'answer' });
    const first = await run();
    const thinking = first.filter((e) => e.type === 'thinking').map((e) => (e as { text: string }).text).join('');
    const history: Msg[] = [user('q'), assistantWith([{ type: 'thinking', text: thinking }, { type: 'text', text: 'answer' }]), user('again')];

    a.push({ text: 'x' }, { text: 'x' }, { text: 'x' });
    await run(req({ messages: history }), manifest({ reasoning: { field: 'reasoning_content', echo: true } }));
    await run(req({ messages: history }), manifest({ reasoning: { field: 'reasoning', echo: true } }));
    await run(req({ messages: history }), manifest({ reasoning: { field: 'reasoning_content' } }));
    const sent = a.requests.slice(1).map((r) => r.body.messages[2]);
    expect(sent[0]).toEqual({ role: 'assistant', content: 'answer', reasoning_content: 'I will think' });
    expect(sent[1]).toEqual({ role: 'assistant', content: 'answer', reasoning: 'I will think' });
    expect(sent[2]).toEqual({ role: 'assistant', content: 'answer' });
  });

  it('echo with no field named uses reasoning_content; an assistant turn with no thinking sends none', async () => {
    a.push({ text: 'x' });
    await run(req({ messages: [user('q'), assistantWith([{ type: 'thinking', text: 'hm' }, { type: 'text', text: 'a' }]), assistantWith([{ type: 'text', text: 'b' }]), user('z')] }), manifest({ reasoning: { echo: true } }));
    const m = a.requests[0].body.messages;
    expect(m[2].reasoning_content).toBe('hm');
    expect('reasoning_content' in m[3]).toBe(false);
  });

  it('unknown fields of a tool call come back unchanged on the next request (S20)', async () => {
    const extra_content = { google: { thought_signature: 'sig-abc==' } };
    a.push({ toolCalls: [{ id: 'g1', name: 'read', args: '{"path":"a"}', extra: { extra_content } }, { id: 'g2', name: 'ls', args: '{}' }], split: 3 });
    const ev = await run();
    const got = calls(ev);
    expect(got[0].extra).toEqual({ extra_content });
    expect(got[1].extra).toBeUndefined();

    const blocks: Block[] = got.map((c) => ({ type: 'tool_call', id: c.id, name: c.name, args: c.args, ...(c.extra ? { extra: c.extra } : {}) }));
    const history: Msg[] = [user('go'), assistantWith(blocks), { role: 'user', blocks: got.map((c) => ({ type: 'tool_result' as const, id: c.id, content: 'r' })) }];
    a.push({ text: 'done' });
    await run(req({ messages: history }));
    const sent = a.requests[1].body.messages[2].tool_calls;
    expect(sent[0]).toEqual({ id: 'g1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' }, extra_content });
    expect(sent[1]).toEqual({ id: 'g2', type: 'function', function: { name: 'ls', arguments: '{}' } });
  });

  it('unknown fields of the message come back unchanged too; null ones and the known ones are not collected', async () => {
    a.push(raw(
      delta({ role: 'assistant', content: '', refusal: null, annotations: [{ n: 1 }], note: 'ab', meta: { a: 1 } }),
      delta({ content: 'hi', annotations: [{ n: 2 }], note: 'cd', meta: { b: 2 } }),
      delta({}, 'stop'),
      data('[DONE]'),
    ));
    const ev = await run();
    const done = ev.at(-1) as { type: 'done'; extra?: Record<string, unknown> };
    expect(done.extra).toEqual({ annotations: [{ n: 1 }, { n: 2 }], note: 'abcd', meta: { a: 1, b: 2 } });

    const history: Msg[] = [user('q'), assistantWith([{ type: 'text', text: 'hi' }], done.extra), user('next')];
    a.push({ text: 'x' });
    await run(req({ messages: history }));
    expect(a.requests[1].body.messages[2]).toEqual({ role: 'assistant', content: 'hi', annotations: [{ n: 1 }, { n: 2 }], note: 'abcd', meta: { a: 1, b: 2 } });
  });

  it('a __proto__ field of a delta is kept as data and pollutes nothing', async () => {
    a.push(raw(
      `data: {"choices":[{"index":0,"delta":{"content":"x","__proto__":{"polluted":true},"tool_calls":[{"index":0,"id":"t","function":{"name":"n","arguments":"{}"},"__proto__":{"polluted2":true}}]}}]}\n\n`,
      data('[DONE]'),
    ));
    const ev = await run();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
    expect(Object.keys(calls(ev)[0].extra ?? {})).toEqual(['__proto__']);
  });

  it('the core fields of a tool call win over a stored extra', async () => {
    a.push({ text: 'x' });
    const blocks: Block[] = [{ type: 'tool_call', id: 'real', name: 'read', args: {}, extra: { id: 'forged', type: 'other', function: 'no' } }];
    await run(req({ messages: [user('q'), assistantWith(blocks), { role: 'user', blocks: [{ type: 'tool_result', id: 'real', content: 'r' }] }] }));
    expect(a.requests[0].body.messages[2].tool_calls[0]).toEqual({ id: 'real', type: 'function', function: { name: 'read', arguments: '{}' } });
  });
});

describe('listModels', () => {
  const listed = (p = manifest(), h = host(), signal = new AbortController().signal) => wire.listModels!(p, h, signal);
  const json = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('reads { data: [{ id }] } through send: ids sorted, key sent, the models address', async () => {
    expect(await listed()).toEqual(['fake-model-1', 'fake-model-2']);
    expect(a.requests[0]).toMatchObject({ path: '/v1/models', headers: { authorization: `Bearer ${KEY}` } });
  });

  it('sorts, drops what has no id, and drops repeats', async () => {
    const f = json({ data: [{ id: 'zeta' }, { id: 'alpha' }, { name: 'no id' }, { id: 'alpha' }, 'beta', 7] });
    expect(await listed(manifest(), host({ fetch: f }))).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('a bare array works, of objects and of text', async () => {
    expect(await listed(manifest(), host({ fetch: json([{ id: 'b' }, { id: 'a' }]) }))).toEqual(['a', 'b']);
    expect(await listed(manifest(), host({ fetch: json(['y', 'x']) }))).toEqual(['x', 'y']);
  });

  it('modelsUrl is used when the manifest has one', async () => {
    await listed(manifest({ modelsUrl: `${a.url}/v1/models?limit=5` }));
    expect(urls).toEqual([`${a.url}/v1/models?limit=5`]);
  });

  it('any failure is undefined and never throws: a bad status, bad json, a wrong shape, an empty list, a network error', async () => {
    a.push({ status: 500, body: 'down' });
    expect(await listed(manifest({ baseUrl: `${a.url}/nowhere` }))).toBeUndefined(); // 404 from the fake
    expect(await listed(manifest(), host({ fetch: json({ error: 'x' }, 401) }))).toBeUndefined();
    expect(await listed(manifest(), host({ fetch: (async () => new Response('not json')) as unknown as typeof fetch }))).toBeUndefined();
    expect(await listed(manifest(), host({ fetch: json({ models: [] }) }))).toBeUndefined();
    expect(await listed(manifest(), host({ fetch: json({ data: [] }) }))).toBeUndefined();
    expect(await listed(manifest(), host({ fetch: json('text') }))).toBeUndefined();
    expect(await listed(manifest(), host({ fetch: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch }))).toBeUndefined();
    expect(await listed(manifest(), host({ withSend: false }))).toBeUndefined();
  });

  it('a keyed provider with no consent gets undefined and no request; a keyless one needs none', async () => {
    expect(await listed(manifest(), host({ consent: false }))).toBeUndefined();
    expect(a.requests).toEqual([]);
    expect(await listed(manifest({ auth: { style: 'none', keyEnv: [] } }), host({ consent: false }))).toEqual(['fake-model-1', 'fake-model-2']);
    expect(a.requests).toHaveLength(1);
    expect(a.requests[0].headers.authorization).toBeUndefined();
  });

  it('a modelsUrl on another address is refused by send: undefined, nothing sent', async () => {
    const other = await startFakeProvider();
    try {
      expect(await listed(manifest({ modelsUrl: `${other.url}/v1/models` }))).toBeUndefined();
      expect(other.requests).toEqual([]);
      expect(a.requests).toEqual([]);
    } finally {
      await other.close();
    }
  });
});

describe('fix round: errors the wire builds', () => {
  const failure = (h: EngineHost) => run(req(), manifest(), h).then(() => undefined, (x: Error) => x);
  // A 200 reply whose body gives these frames and then ends, or fails with `err`.
  const streamFetch = (frames: string[], err?: Error) => (async () => new Response(new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      if (err) c.error(err);
      else c.close();
    },
  }), { status: 200 })) as unknown as typeof fetch;

  it('an error object in the stream that holds the key is redacted in message and stack', async () => {
    a.push(raw(data({ error: { message: KEY } })));
    const e = await failure(host());
    expect(e?.message).toBe('Fake reported an error: [key Reins]');
    for (const t of [e?.message, e?.stack ?? '']) expect(t).not.toContain(KEY);
  });

  it('a key inside a longer provider message is redacted too, and the label as well', async () => {
    a.push(raw(data({ error: { message: `bad key ${KEY} for you` } })));
    const e = await run(req(), manifest({ label: KEY }), host()).then(() => undefined, (x: Error) => x);
    expect(e?.message).toBe('[key Reins] reported an error: bad key [key Reins] for you');
    expect(e?.stack ?? '').not.toContain(KEY);
  });

  it('a read that fails with the key in its message becomes a new redacted error', async () => {
    const e = await failure(host({ fetch: streamFetch([delta({ content: 'a' })], new Error(`socket reset ${KEY}`)) }));
    expect(e?.message).toBe("Fake's reply was cut off: socket reset [key Reins]");
    expect(e?.cause).toBeUndefined();
    for (const t of [e?.message, e?.stack ?? '']) expect(t).not.toContain(KEY);
  });

  it('with no host sanitizer the provider text is left out altogether', async () => {
    a.push(raw(data({ error: { message: `overloaded ${KEY}` } })));
    const e = await failure(host({ noRedact: true }));
    expect(e?.message).toBe('The provider reported an error');
    const f = host({ noRedact: true, fetch: streamFetch([], new Error(`socket ${KEY}`)) });
    const e2 = await run(req(), manifest({ label: KEY }), f).then(() => undefined, (x: Error) => x);
    expect(e2?.message).toBe("The provider's reply was cut off");
    for (const t of [e?.message, e?.stack, e2?.message, e2?.stack]) expect(t ?? '').not.toContain(KEY);
  });

  it('the errors of the wire itself do not pass through a second time, and an abort is not an error', async () => {
    const ctl = new AbortController();
    const fetchHang = (async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(delta({ content: 'a' }))); } }), { status: 200 })) as unknown as typeof fetch;
    const got: WireEvent[] = [];
    for await (const e of wire.call(req(), manifest(), host({ fetch: fetchHang }), ctl.signal)) { got.push(e); ctl.abort(); }
    expect(got).toHaveLength(1);
  });
});

describe('fix round: caps on one reply', () => {
  const KIB = 1024;
  const args = (n: number) => 'a'.repeat(n);
  const callFrames = (id: number, text: string) => delta({ tool_calls: [{ index: id, id: `c${id}`, function: { name: 'f', arguments: text } }] });

  it('tool call arguments: 4 MiB work, one character more is an error', async () => {
    const piece = 512 * KIB;
    a.push(raw(...Array.from({ length: 8 }, () => callFrames(0, args(piece))), data('[DONE]')));
    expect(calls(await run())[0].args).toHaveLength(8 * piece);
    a.push(raw(...Array.from({ length: 8 }, () => callFrames(0, args(piece))), callFrames(0, 'x'), data('[DONE]')));
    await expect(run()).rejects.toThrow('Fake sent a tool call with more arguments than Reins accepts.');
  });

  it('tool calls: 128 work, 129 is an error', async () => {
    const many = (n: number) => raw(...Array.from({ length: n }, (_, i) => callFrames(i, '{}')), data('[DONE]'));
    a.push(many(128));
    expect(calls(await run())).toHaveLength(128);
    a.push(many(129));
    await expect(run()).rejects.toThrow('more than 128 tool calls');
  });

  it('extra fields: 256 KiB in all work, one character more is an error (message and tool call alike)', async () => {
    const max = 256 * KIB;
    a.push(raw(delta({ note: args(max - 'note'.length) }), data('[DONE]')));
    const ok = (await run()).at(-1) as { extra?: Record<string, string> };
    expect(ok.extra?.note).toHaveLength(max - 4);
    a.push(raw(delta({ note: args(max - 'note'.length + 1) }), data('[DONE]')));
    await expect(run()).rejects.toThrow('more extra fields than Reins keeps');
    a.push(raw(delta({ tool_calls: [{ index: 0, id: 'x', function: { name: 'f', arguments: '{}' }, blob: args(max - 'blob'.length + 1) }] }), data('[DONE]')));
    await expect(run()).rejects.toThrow('more extra fields than Reins keeps');
    a.push(raw(delta({ note: args(max - 10) }), delta({ tool_calls: [{ index: 0, id: 'x', function: { name: 'f', arguments: '{}' }, blob: args(10) }] }), data('[DONE]')));
    await expect(run()).rejects.toThrow('more extra fields than Reins keeps'); // the total, not each part
  });

  it('text and thinking are streamed on and not capped', async () => {
    const big = args(900 * KIB);
    a.push(raw(...Array.from({ length: 6 }, () => delta({ content: big }) + delta({ reasoning_content: big })), data('[DONE]')));
    const ev = await run();
    expect(ev.filter((e) => e.type === 'text')).toHaveLength(6);
    expect(ev.filter((e) => e.type === 'thinking')).toHaveLength(6);
  });

  it('an error from a cap passes no provider text and no key even without a host sanitizer', async () => {
    a.push(raw(...Array.from({ length: 129 }, (_, i) => callFrames(i, '{}'))));
    const e = await run(req(), manifest({ label: KEY }), host({ noRedact: true })).then(() => undefined, (x: Error) => x);
    expect(e?.message).toBe('The provider sent more than 128 tool calls in one reply.');
  });

  it('a tool index that is not a whole number from 0 is not used as an index: the exact calls that result', async () => {
    const one = (index: unknown, id: string | undefined, args: string, name = 'f') => delta({ tool_calls: [{ index, ...(id ? { id } : {}), function: { ...(id ? { name } : {}), arguments: args } }] });
    a.push(raw(
      one(5, 'a', '1', 'fa'), one(-1, 'b', '2', 'fb'), one(1.5, 'c', '3', 'fc'),
      one(0.5, undefined, 'X'), // no id: goes on with the latest call
      one('x', 'd', '4', 'fd'), data('[DONE]'),
    ));
    // a is at 5; each invalid index with an id starts the next call (6, 7, then 8); the one with no id adds to call 7
    expect(calls(await run()).map((c) => [c.id, c.name, c.args])).toEqual([['a', 'fa', '1'], ['b', 'fb', '2'], ['c', 'fc', '3X'], ['d', 'fd', '4']]);
  });
});

describe('fix round: listModels is bounded', () => {
  const MIB = 1024 * 1024;
  const sized = (n: number) => (async () => new Response(JSON.stringify({ data: [{ id: 'a'.repeat(n - '{"data":[{"id":""}]}'.length) }] }))) as unknown as typeof fetch;
  it('1 MiB of body is read; one byte more is undefined, and the download is cancelled', async () => {
    expect((await wire.listModels!(manifest(), host({ fetch: sized(MIB) }), new AbortController().signal))?.[0]).toHaveLength(MIB - 20);
    expect(await wire.listModels!(manifest(), host({ fetch: sized(MIB + 1) }), new AbortController().signal)).toBeUndefined();

    let pulls = 0;
    let cancelled = false;
    const chunk = enc.encode('x'.repeat(64 * 1024));
    const f = (async () => new Response(new ReadableStream<Uint8Array>({ pull(c) { if (++pulls > 1000) c.close(); else c.enqueue(chunk); }, cancel() { cancelled = true; } }))) as unknown as typeof fetch;
    expect(await wire.listModels!(manifest(), host({ fetch: f }), new AbortController().signal)).toBeUndefined();
    expect(pulls).toBeLessThan(30);
    expect(cancelled).toBe(true);
  });
});

describe('fix round: usage counts are whole numbers', () => {
  const usageFor = async (usage: Record<string, unknown>): Promise<Usage> => {
    a.push({ text: 'x', usage });
    return usageOf(await run())[0].usage;
  };
  it('a fraction is cut down, an unsafe number is 0, and reasoning is kept apart from output (not clamped)', async () => {
    expect(await usageFor({ prompt_tokens: 10.9, completion_tokens: 2.2, completion_tokens_details: { reasoning_tokens: 99 } })).toEqual({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 99 });
    expect(await usageFor({ prompt_tokens: 1e300, completion_tokens: 2 ** 60, prompt_tokens_details: { cached_tokens: 0.9 } })).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    expect(await usageFor({ prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 30.7, completion_tokens_details: { reasoning_tokens: 10 } })).toEqual({ input: 70, output: 10, cacheRead: 30, cacheWrite: 0, reasoning: 10 });
  });
});
describe('fix round 2: errors of the wire', () => {
  const HIDDEN = 'The request failed and its details were hidden.';
  const stream = (frames: string[], err?: unknown) => (async () => new Response(new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      if (err !== undefined) c.error(err);
      else c.close();
    },
  }), { status: 200 })) as unknown as typeof fetch;
  const failure = (h: EngineHost) => run(req(), manifest(), h).then(() => undefined, (x: Error) => x);
  const noKey = (e?: Error) => { for (const t of [e?.message, e?.stack, e?.name]) expect(t ?? '').not.toContain(KEY); };

  it('a provider message of 490 characters and then the key leaves no prefix: it is redacted whole, then cut', async () => {
    a.push(raw(data({ error: { message: 'x'.repeat(490) + KEY } })));
    const e = await failure(host());
    expect(e?.message).not.toContain('sk-test-');
    expect(e?.message.length).toBeLessThanOrEqual('Fake reported an error'.length + 2 + 500);
    a.push(raw(data({ error: { message: 'x'.repeat(2000) + KEY } })));
    expect((await failure(host()))?.message).not.toContain('sk-test-');
  });

  it('a partial key that the cut would end on is held back, and a key that ends exactly at the cap is redacted', async () => {
    a.push(raw(data({ error: { message: 'x'.repeat(498) + 'sk-test-01' + 'z'.repeat(20) } })));
    expect((await failure(host()))?.message.endsWith('x')).toBe(true);
    a.push(raw(data({ error: { message: 'x'.repeat(500 - KEY.length) + KEY } })));
    expect((await failure(host()))?.message).toBe(`Fake reported an error: ${'x'.repeat(500 - KEY.length)}[key Reins]`);
  });

  it('an error of an earlier call, polluted with the key, thrown by a later stream is rebuilt, not passed on', async () => {
    a.push(raw(data({ error: { message: 'first' } })));
    const first = await failure(host());
    expect(first?.message).toBe('Fake reported an error: first');
    first!.message = `leak ${KEY}`;
    first!.stack = `Error: ${KEY}`;
    const e = await failure(host({ fetch: stream([delta({ content: 'a' })], first) }));
    expect(e?.message).toBe("Fake's reply was cut off: leak [key Reins]");
    expect(e).not.toBe(first);
    noKey(e);
  });

  it('a host redact that throws Error(key) gives the constant, for the provider error, a cut-off read and a cap error', async () => {
    const boom = () => { throw new Error(KEY); };
    a.push(raw(data({ error: { message: 'x' } })));
    for (const e of [
      await failure(host({ redact: boom })),
      await failure(host({ redact: boom, fetch: stream([], new Error('socket')) })),
    ]) {
      expect(e?.message).toBe(HIDDEN);
      noKey(e);
    }
    a.push(raw(...Array.from({ length: 129 }, (_, i) => delta({ tool_calls: [{ index: i, id: `c${i}`, function: { name: 'f', arguments: '{}' } }] }))));
    const cap = await failure(host({ redact: boom }));
    expect(cap?.message).toBe(HIDDEN);
    noKey(cap);
    // a reply with no body at all: this error is built outside the stream's own try
    const none = await failure(host({ redact: boom, fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch }));
    expect(none?.message).toBe(HIDDEN);
    noKey(none);
    expect((await failure(host({ fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch })))?.message).toBe('Fake sent no reply.');
  });

  it('a hostile value that fails the read (a Proxy whose prototype lookup throws, a message getter that throws) gives the constant', async () => {
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error(KEY); } });
    const e = await failure(host({ fetch: stream([], hostile) }));
    expect(e?.message).toBe(HIDDEN);
    noKey(e);
    const getter = Object.defineProperty(new Error('x'), 'message', { get() { throw new Error(KEY); } });
    const e2 = await failure(host({ fetch: stream([], getter) }));
    expect(e2?.message).toBe(HIDDEN);
    noKey(e2);
  });
});

describe('fix round 2: usage spellings', () => {
  const usageFor = async (usage: Record<string, unknown>): Promise<Usage> => {
    a.push({ text: 'x', usage });
    return usageOf(await run())[0].usage;
  };
  it('output_tokens and input_tokens are read, reasoning stays its own number, prompt_tokens wins when both are there', async () => {
    expect(await usageFor({ output_tokens: 30, completion_tokens_details: { reasoning_tokens: 12 } })).toEqual({ input: 0, output: 30, cacheRead: 0, cacheWrite: 0, reasoning: 12 });
    expect(await usageFor({ input_tokens: 7, output_tokens: 3 })).toEqual({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    expect(await usageFor({ prompt_tokens: 9, input_tokens: 7, completion_tokens: 4, output_tokens: 3 })).toEqual({ input: 9, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  });
});
describe('fix round 3: the wire and the host sanitizer', () => {
  const HIDDEN = 'The request failed and its details were hidden.';
  const failure = (h: EngineHost) => run(req(), manifest(), h).then(() => undefined, (x: Error) => x);
  const frame = (message: string) => raw(data({ error: { message } }));
  const MAX = 'Fake reported an error'.length + 2 + 500; // the cap the wire asks the host for

  it('overlapping known keys in a provider message are both hidden', async () => {
    a.push(frame('abcdefghABCDEFGHABCDEFGH!'));
    const e = await failure(host({ env: { P_API_KEY: 'abcdefghABCDEFGH', Q_API_KEY: 'ABCDEFGHABCDEFGH' } }));
    expect(e?.message).toBe('Fake reported an error: [key P_API_KEY]!');
    expect(e?.stack ?? '').not.toContain('ABCDEFGH');
  });

  it('a sanitizer that ignores max and returns 20000 characters gives the constant', async () => {
    a.push(frame('x'));
    const e = await failure(host({ redact: () => 'x'.repeat(20_000) }));
    expect(e?.message).toBe(HIDDEN);
  });

  it('a sanitizer that returns something that is not a string gives the constant, whatever the thing holds', async () => {
    for (const bad of [42, null, undefined, { toString: () => KEY }, [KEY], new String(KEY)]) {
      a.push(frame('x'));
      const e = await failure(host({ redact: (() => bad) as unknown as EngineHost['redact'] }));
      expect(e?.message).toBe(HIDDEN);
      for (const t of [e?.message, e?.stack]) expect(t ?? '').not.toContain(KEY);
    }
  });

  it('exactly max characters is accepted, one more is not', async () => {
    a.push(frame('x'));
    expect((await failure(host({ redact: () => 'y'.repeat(MAX) })))?.message).toBe('y'.repeat(MAX));
    a.push(frame('x'));
    expect((await failure(host({ redact: () => 'y'.repeat(MAX + 1) })))?.message).toBe(HIDDEN);
  });
});