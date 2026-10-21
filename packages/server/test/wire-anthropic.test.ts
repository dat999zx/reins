import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUNDLED_MODS, startMods } from '../src/engines.js';
import type { Block, ModelRequest, Msg, Usage, WireEvent } from '../src/loop/types.js';
import type { EngineHost, Mods, Protocol, ProviderManifest, Wire } from '../src/mods/types.js';
import { Redactor, redactCut, setKey } from '../src/secrets.js';
import { makeSend } from '../src/send.js';
import { startFakeProvider, type FakeReply } from './fake-provider.js';
import { tempHome } from './mods-harness.js';

const KEY = 'sk-ant-test-0123456789abcdef';
const HIDDEN = 'The request failed and its details were hidden.';
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
  wire = (mods.registry.get<Protocol>('protocol-impl', 'anthropic-messages') as Extract<Protocol, { conversation: 'reins' }>).wire;
  urls = [];
});
afterEach(async () => {
  mods.dispose();
  await a.close();
  home.cleanup();
});

const manifest = (over: Partial<ProviderManifest> = {}): ProviderManifest => ({
  reins: 1, id: 'p', kind: 'provider', version: '1', label: 'Fake', protocol: 'anthropic-messages', baseUrl: a.url,
  auth: { style: 'header', header: 'x-api-key', keyEnv: ['P_API_KEY'] }, defaultModel: 'm', models: [{ id: 'm' }], ...over,
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
const assistantWith = (blocks: Block[], extra?: Msg['extra']): Msg => ({ role: 'assistant', blocks, ...(extra ? { extra } : {}) });
const result = (id: string, content = 'r', isError?: true): Block => ({ type: 'tool_result', id, content, ...(isError ? { isError } : {}) });
const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({ model: 'm', system: 'be brief', messages: [user('hi')], ...over });

async function run(r: ModelRequest = req(), p = manifest(), h = host(), signal = new AbortController().signal): Promise<WireEvent[]> {
  const out: WireEvent[] = [];
  for await (const e of wire.call(r, p, h, signal)) out.push(e);
  return out;
}
const types = (ev: WireEvent[]) => ev.map((e) => e.type);
const usageOf = (ev: WireEvent[]) => ev.filter((e): e is Extract<WireEvent, { type: 'usage' }> => e.type === 'usage');
const calls = (ev: WireEvent[]) => ev.filter((e): e is Extract<WireEvent, { type: 'tool_call' }> => e.type === 'tool_call');
const sentMessages = (i = 0) => a.requests[i].body.messages;

// Raw Messages streams, for what the fake's own reply shapes cannot say.
const ev = (type: string, o: object = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
const start = (usage: object = { input_tokens: 10, output_tokens: 1 }) => ev('message_start', { message: { id: 'msg_1', role: 'assistant', content: [], usage } });
const open = (index: unknown, block: object) => ev('content_block_start', { index, content_block: block });
const piece = (index: unknown, delta: object) => ev('content_block_delta', { index, delta });
const end = (index: unknown) => ev('content_block_stop', { index });
const fin = (stop = 'end_turn', usage: object = { output_tokens: 5 }) => ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage });
const stopFrame = () => ev('message_stop');
const textBlock = (index: unknown, t: string) => open(index, { type: 'text', text: '' }) + piece(index, { type: 'text_delta', text: t }) + end(index);
const toolOpen = (index: unknown, id: string, name: string, more: object = {}) => open(index, { type: 'tool_use', id, name, input: {}, ...more });
const json = (index: unknown, partial_json: string) => piece(index, { type: 'input_json_delta', partial_json });
const raw = (...frames: string[]): FakeReply => ({ body: frames.join(''), headers: { 'content-type': 'text/event-stream' } });
/** A whole reply: the start, these frames, the final delta and the stop. */
const reply = (...frames: string[]) => raw(start(), ...frames, fin(), stopFrame());

describe('the protocol is registered', () => {
  it('anthropic-messages is a bundled protocol of the reins kind after loadMods, with no problem', () => {
    expect(mods.registry.ids('protocol')).toContain('anthropic-messages');
    const m = mods.mods.find((x) => x.id === 'anthropic-messages')!;
    expect(m).toMatchObject({ kind: 'protocol', source: 'bundled', problems: [], hasCode: true });
    const p = mods.registry.get<Protocol>('protocol-impl', 'anthropic-messages')!;
    expect(p.conversation).toBe('reins');
    expect(typeof (p as { wire: Wire }).wire.call).toBe('function');
    expect(typeof (p as { wire: Wire }).wire.listModels).toBe('function');
  });

  it('its folder holds mod.json and the file main names, and the build has copied both', () => {
    const dir = path.join(BUNDLED_MODS, 'anthropic-messages');
    const mj = JSON.parse(fs.readFileSync(path.join(dir, 'mod.json'), 'utf8')) as { main: string };
    expect(fs.existsSync(path.join(dir, mj.main.replace(/\.js$/, '.ts')))).toBe(true);
    const dist = fileURLToPath(new URL('../dist/mods/anthropic-messages/', import.meta.url));
    // dist exists once `npm run build` ran (the gate builds before it tests)
    if (fs.existsSync(path.dirname(dist))) {
      expect(fs.existsSync(path.join(dist, 'index.js'))).toBe(true);
      expect(fs.existsSync(path.join(dist, 'mod.json'))).toBe(true);
    }
  });
});

describe('the request', () => {
  it('posts to {baseUrl}/v1/messages with the key in x-api-key, the version, json, and a streamed body', async () => {
    a.push({ text: 'ok' });
    await run();
    expect(a.requests).toHaveLength(1);
    const r = a.requests[0];
    expect(r.path).toBe('/v1/messages');
    expect(r.headers['x-api-key']).toBe(KEY);
    expect(r.headers.authorization).toBeUndefined();
    expect(r.headers['anthropic-version']).toBe('2023-06-01');
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.body).toEqual({ model: 'm', stream: true, system: 'be brief', max_tokens: 4096, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  });

  it('a manifest that says header and names none gets x-api-key', async () => {
    a.push({ text: 'ok' });
    await run(req(), manifest({ auth: { style: 'header', keyEnv: ['P_API_KEY'] } }));
    expect(a.requests[0].headers['x-api-key']).toBe(KEY);
    expect(a.requests[0].headers.authorization).toBeUndefined();
  });

  it('a manifest that names another header gets that one, and not x-api-key', async () => {
    a.push({ text: 'ok' });
    await run(req(), manifest({ auth: { style: 'header', header: 'X-Other-Key', keyEnv: ['P_API_KEY'] } }));
    expect(a.requests[0].headers['x-other-key']).toBe(KEY);
    expect(a.requests[0].headers['x-api-key']).toBeUndefined();
  });

  it('Authorization carries the key only when the manifest says bearer', async () => {
    a.push({ text: 'ok' });
    await run(req(), manifest({ auth: { style: 'bearer', keyEnv: ['P_API_KEY'] } }));
    expect(a.requests[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(a.requests[0].headers['x-api-key']).toBeUndefined();
  });

  it('a keyless provider sends no key header at all', async () => {
    a.push({ text: 'ok' });
    await run(req(), manifest({ auth: { style: 'none', keyEnv: [] } }));
    expect(Object.keys(a.requests[0].headers).filter((k) => /auth|key/i.test(k))).toEqual([]);
  });

  it('a base address with or without /v1, and with trailing slashes, gives one /v1', async () => {
    a.push({ text: 'ok' }, { text: 'ok' }, { text: 'ok' }, { text: 'ok' });
    for (const base of [a.url, `${a.url}/`, `${a.url}/v1`, `${a.url}/v1/`]) await run(req(), manifest({ baseUrl: base }));
    expect(a.requests.map((r) => r.path)).toEqual(['/v1/messages', '/v1/messages', '/v1/messages', '/v1/messages']);
    expect(urls).toEqual(Array(4).fill(`${a.url}/v1/messages`));
  });

  it('manifest headers are added, and one may replace anthropic-version', async () => {
    a.push({ text: 'ok' }, { text: 'ok' });
    await run(req(), manifest({ headers: { 'anthropic-beta': 'tools-2026-01-01' } }));
    await run(req(), manifest({ headers: { 'anthropic-version': '2099-01-01' } }));
    expect(a.requests[0].headers['anthropic-beta']).toBe('tools-2026-01-01');
    expect(a.requests[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(a.requests[1].headers['anthropic-version']).toBe('2099-01-01');
  });

  it('the key is in the header and nowhere in the address or the body', async () => {
    a.push({ text: 'ok' });
    await run();
    for (const u of urls) expect(decodeURIComponent(u)).not.toContain(KEY);
    expect(JSON.stringify(a.requests[0].body)).not.toContain(KEY);
  });

  it('max_tokens: the request, else the model, else 4096', async () => {
    a.push({ text: 'ok' }, { text: 'ok' }, { text: 'ok' }, { text: 'ok' });
    const p = manifest({ models: [{ id: 'm', maxOutput: 8192 }, { id: 'n' }] });
    await run(req(), p);
    await run(req({ model: 'n' }), p);
    await run(req({ maxOutput: 1000 }), p);
    await run(req({ maxOutput: 0 }), p);
    expect(a.requests.map((r) => r.body.max_tokens)).toEqual([8192, 4096, 1000, 8192]);
  });

  it('system is a top-level string and is left out when empty; tools become name, description, input_schema', async () => {
    a.push({ text: 'ok' }, { text: 'ok' });
    const schema = { type: 'object', properties: { path: { type: 'string' } } };
    await run(req({ tools: [{ name: 'read', description: 'Read a file', schema }] }));
    await run(req({ system: '' }));
    expect(a.requests[0].body.system).toBe('be brief');
    expect(a.requests[0].body.tools).toEqual([{ name: 'read', description: 'Read a file', input_schema: schema }]);
    expect(sentMessages(0).some((m: { role: string }) => m.role === 'system')).toBe(false);
    expect('system' in a.requests[1].body).toBe(false);
    expect('tools' in a.requests[1].body).toBe(false);
  });

  it('the body is merged: manifest, then the model, then the effort; later wins, objects merge, arrays are replaced', async () => {
    a.push({ text: 'ok' });
    const p = manifest({
      body: { thinking: { type: 'enabled', budget_tokens: 1 }, stop_sequences: ['a', 'b'], level: 'manifest', only: { manifest: true } },
      models: [{ id: 'm', body: { thinking: { budget_tokens: 2 }, stop_sequences: ['c'], level: 'model' } }],
      efforts: [{ id: 'high', label: 'High', body: { thinking: { extra: 3 }, level: 'effort' } }],
    });
    await run(req({ effort: 'high' }), p);
    expect(a.requests[0].body).toMatchObject({
      model: 'm', stream: true,
      thinking: { type: 'enabled', budget_tokens: 2, extra: 3 },
      stop_sequences: ['c'], level: 'effort', only: { manifest: true },
    });
    expect(p.body).toEqual({ thinking: { type: 'enabled', budget_tokens: 1 }, stop_sequences: ['a', 'b'], level: 'manifest', only: { manifest: true } });
  });

  it('a manifest layer can set max_tokens, but stream stays true', async () => {
    a.push({ text: 'ok' });
    await run(req(), manifest({ body: { max_tokens: 99, stream: false } }));
    expect(a.requests[0].body).toMatchObject({ max_tokens: 99, stream: true });
  });

  it('a __proto__ key in a body layer is data, not a prototype', async () => {
    a.push({ text: 'ok' });
    const poisoned = JSON.parse('{"__proto__":{"polluted":true},"nested":{"__proto__":{"polluted":true}}}') as Record<string, unknown>;
    await run(req(), manifest({ body: poisoned, models: [{ id: 'm', body: JSON.parse('{"__proto__":{"also":1}}') as Record<string, unknown> }] }));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).also).toBeUndefined();
    expect(a.requests[0].body.model).toBe('m');
    expect(a.requests[0].body.stream).toBe(true);
  });

  it('a host with no send fails in plain words, and nothing is sent', async () => {
    await expect(run(req(), manifest(), host({ withSend: false }))).rejects.toThrow('This host cannot send requests to a provider.');
    expect(a.requests).toEqual([]);
  });

  it('an error status is an error through send: the status, and the key the provider echoed is redacted', async () => {
    a.push({ status: 429, body: `slow down ${KEY}` }, { status: 500, body: JSON.stringify({ type: 'error', error: { message: `boom ${KEY}` } }) });
    for (const status of ['429', '500']) {
      const e = await run().then(() => undefined, (x: Error) => x);
      expect(e?.message).toContain(status);
      for (const t of [e?.message, e?.stack ?? '']) expect(t).not.toContain(KEY);
      expect(e?.message).toContain('[key Reins]');
    }
  });
});

describe('the stream', () => {
  it("the fake's own reply: text, usage and done", async () => {
    a.push({ text: 'Hello' });
    expect(await run()).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'usage', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
      { type: 'done', stop: 'end_turn' },
    ]);
  });

  it('text arrives piece by piece, then usage, then done', async () => {
    a.push(reply(open(0, { type: 'text', text: '' }), piece(0, { type: 'text_delta', text: 'Hel' }), piece(0, { type: 'text_delta', text: 'lo' }), end(0)));
    expect(await run()).toEqual([
      { type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' },
      { type: 'usage', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
      { type: 'done', stop: 'end_turn' },
    ]);
  });

  it('two tool_use blocks, their json split in many pieces and interleaved, are joined by index', async () => {
    a.push(reply(
      toolOpen(1, 'toolu_b', 'write'), toolOpen(0, 'toolu_a', 'read'),
      json(1, '{"pa'), json(0, '{"x"'), json(1, 'th":'), json(0, ':'), json(1, '"b'), json(0, '1}'), json(1, '.txt"}'),
      end(0), end(1),
    ));
    const out = await run();
    expect(calls(out)).toEqual([
      { type: 'tool_call', id: 'toolu_a', name: 'read', args: '{"x":1}' },
      { type: 'tool_call', id: 'toolu_b', name: 'write', args: '{"path":"b.txt"}' },
    ]);
    expect(types(out)).toEqual(['tool_call', 'tool_call', 'usage', 'done']);
    expect(out.at(-1)).toEqual({ type: 'done', stop: 'end_turn' });
  });

  it("the fake's tool calls, split in pieces, with a stop reason of tool_use", async () => {
    a.push({ toolCalls: [{ id: 'one', name: 'read', args: '{"path":"alpha.txt"}' }, { id: 'two', name: 'ls', args: '{"dir":"."}' }], split: 5 });
    const out = await run();
    expect(calls(out).map((c) => [c.id, c.name, c.args])).toEqual([['one', 'read', '{"path":"alpha.txt"}'], ['two', 'ls', '{"dir":"."}']]);
    expect(out.at(-1)).toEqual({ type: 'done', stop: 'tool_use' });
  });

  it('a call with no pieces hands over {}; a whole input in the start block is used; a call with no id gets one', async () => {
    a.push(reply(toolOpen(0, 'x', 'pwd') + end(0), open(1, { type: 'tool_use', id: 'y', name: 'ls', input: { dir: '.' } }) + end(1), open(2, { type: 'tool_use', name: 'z' }) + end(2)));
    const out = calls(await run());
    expect(out.map((c) => c.args)).toEqual(['{}', '{"dir":"."}', '{}']);
    expect(out[2].id).toMatch(/^toolu_/);
  });

  it('thinking text streams, and the signature is kept whole, even when it comes in pieces', async () => {
    a.push(reply(
      open(0, { type: 'thinking', thinking: '' }), piece(0, { type: 'thinking_delta', thinking: 'let me ' }), piece(0, { type: 'thinking_delta', thinking: 'think' }),
      piece(0, { type: 'signature_delta', signature: 'EqQBCg' }), piece(0, { type: 'signature_delta', signature: 'IYAhgB==' }), end(0),
      textBlock(1, 'answer'),
    ));
    const out = await run();
    expect(out.filter((e) => e.type === 'thinking')).toEqual([
      { type: 'thinking', text: 'let me ' }, { type: 'thinking', text: 'think' }, { type: 'thinking', text: '', signature: 'EqQBCgIYAhgB==' },
    ]);
    expect(types(out)).toEqual(['thinking', 'thinking', 'thinking', 'text', 'usage', 'done']);
  });

  it("the fake's thinking block with its signature", async () => {
    a.push({ thinking: { text: 'hmm', signature: 'sig-1' }, text: 'x' });
    expect((await run()).filter((e) => e.type === 'thinking')).toEqual([{ type: 'thinking', text: 'hmm' }, { type: 'thinking', text: '', signature: 'sig-1' }]);
  });

  it('a thinking block with no signature gives no signature event', async () => {
    a.push(reply(open(0, { type: 'thinking', thinking: '' }), piece(0, { type: 'thinking_delta', thinking: 'hm' }), end(0)));
    expect((await run()).filter((e) => e.type === 'thinking')).toEqual([{ type: 'thinking', text: 'hm' }]);
  });

  it('ping and events Reins does not know are ignored, and a line that is not json is skipped', async () => {
    a.push({ text: 'still here', badLine: true });
    expect(types(await run())).toEqual(['text', 'usage', 'done']);
    a.push(raw(start(), ev('ping'), 'event: content_block_delta\ndata: {"half":\n\n', 'data: 42\n\n', ev('future_event', { a: 1 }), textBlock(0, 'a'), ev('ping'), textBlock(1, 'b'), fin(), stopFrame()));
    expect((await run()).filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
  });

  it('the event name is used when the data holds no type', async () => {
    a.push(raw('event: message_start\ndata: {"message":{"usage":{"input_tokens":7}}}\n\n', 'event: message_stop\ndata: {}\n\n'));
    expect(usageOf(await run())[0].usage.input).toBe(7);
  });

  it('message_stop ends the stream: what follows is not read', async () => {
    a.push(raw(start(), textBlock(0, 'a'), fin(), stopFrame(), textBlock(1, 'after')));
    expect((await run()).filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'a' }]);
  });

  it('a stream that ends without message_stop is an error, not a done', async () => {
    a.push(raw(start(), textBlock(0, 'a'), fin()));
    const got: WireEvent[] = [];
    const e = await (async () => { for await (const x of wire.call(req(), manifest(), host(), new AbortController().signal)) got.push(x); })().then(() => undefined, (x: Error) => x);
    expect(e?.message).toBe("Fake's reply ended before it was complete.");
    expect(types(got)).toEqual(['text']);
  });

  it('a stream with no events at all is an error too', async () => {
    a.push(raw(''));
    await expect(run()).rejects.toThrow('ended before it was complete');
  });

  it('a connection that drops mid-stream is an error, not a finished reply', async () => {
    a.push({ text: 'x'.repeat(500), dropAfter: 400 });
    await expect(run()).rejects.toThrow();
  });

  it('an error event is an error with the provider text, redacted', async () => {
    a.push(raw(start(), ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })));
    await expect(run()).rejects.toThrow('Fake reported an error: Overloaded');
  });

  it('an error event that holds the key is redacted in message and stack', async () => {
    a.push(raw(start(), textBlock(0, 'a'), ev('error', { error: { type: 'api_error', message: `bad key ${KEY} here` } })));
    const e = await run().then(() => undefined, (x: Error) => x);
    expect(e?.message).toBe('Fake reported an error: bad key [key Reins] here');
    for (const t of [e?.message, e?.stack ?? '']) expect(t).not.toContain(KEY);
  });

  it('an abort mid-stream stops cleanly: no more events, no done, no error, and the read is let go', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode(start() + open(0, { type: 'text', text: '' }) + piece(0, { type: 'text_delta', text: 'first' }))); }, // then it stays open
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

  it('blocks of a kind Reins does not know are kept on the message, with their pieces, in index order', async () => {
    a.push(reply(
      open(2, { type: 'weird', a: 'x', n: null }), piece(2, { type: 'weird_delta', a: 'y', list: [1] }), end(2),
      open(0, { type: 'redacted_thinking', data: 'ENC' }), end(0),
      textBlock(1, 'hi'),
    ));
    const out = await run();
    expect(out.at(-1)).toEqual({ type: 'done', stop: 'end_turn', extra: { unknownBlocks: [{ type: 'redacted_thinking', data: 'ENC' }, { type: 'weird', a: 'xy', n: null, list: [1] }] } });
  });
});

describe('usage', () => {
  const usageFor = async (startUsage: Record<string, unknown>, delta: Record<string, unknown> = { output_tokens: 5 }): Promise<Usage> => {
    a.push(raw(start(startUsage), textBlock(0, 'x'), fin('end_turn', delta), stopFrame()));
    const u = usageOf(await run());
    expect(u).toHaveLength(1);
    return u[0].usage;
  };

  it('the start gives the input and the cache counts, the last delta gives the output; the cache is NOT taken out of the input', async () => {
    expect(await usageFor({ input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 60, cache_creation_input_tokens: 20 }, { output_tokens: 30 }))
      .toEqual({ input: 100, output: 30, cacheRead: 60, cacheWrite: 20, reasoning: 0 });
  });

  it('cache counts absent are 0', async () => {
    expect(await usageFor({ input_tokens: 12, output_tokens: 1 }, { output_tokens: 3 })).toEqual({ input: 12, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    expect(await usageFor({ input_tokens: 12 }, { output_tokens: 3, cache_read_input_tokens: 4 })).toEqual({ input: 12, output: 3, cacheRead: 4, cacheWrite: 0, reasoning: 0 });
  });

  it('the output is the cumulative count of the LAST delta; with no delta usage the start count stands', async () => {
    a.push(raw(start({ input_tokens: 1, output_tokens: 1 }), textBlock(0, 'x'), fin('end_turn', { output_tokens: 5 }), fin('end_turn', { output_tokens: 9 }), stopFrame()));
    expect(usageOf(await run())[0].usage.output).toBe(9);
    a.push(raw(start({ input_tokens: 1, output_tokens: 4 }), textBlock(0, 'x'), ev('message_delta', { delta: { stop_reason: 'end_turn' } }), stopFrame()));
    expect(usageOf(await run())[0].usage.output).toBe(4);
  });

  it('no usage at all gives one usage event marked unknown (zeros that mean nothing), never a known 0', async () => {
    a.push(raw(textBlock(0, 'x'), stopFrame()));
    expect(usageOf(await run())).toEqual([{ type: 'usage', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, unknown: true }]);
    // an empty usage object, or one without the input or the output counter, is still unknown
    a.push(raw(start({}), textBlock(0, 'x'), stopFrame()));
    expect(usageOf(await run())[0]!.unknown).toBe(true);
    a.push(raw(start({ input_tokens: 10 }), textBlock(0, 'x'), fin('end_turn', {}), stopFrame()));
    expect(usageOf(await run())[0]!.unknown).toBe(true);
    a.push(raw(start({}), textBlock(0, 'x'), fin('end_turn', { output_tokens: 5 }), stopFrame()));
    expect(usageOf(await run())[0]!.unknown).toBe(true);
    // both counters, an explicit zero included, are known accounting
    a.push(raw(start({ input_tokens: 0 }), textBlock(0, 'x'), fin('end_turn', { output_tokens: 0 }), stopFrame()));
    expect(usageOf(await run())[0]!.unknown).toBeUndefined();
  });

  it('counts are whole numbers: a fraction is cut down, negative, odd and unsafe values are 0', async () => {
    expect(await usageFor({ input_tokens: 10.9, cache_read_input_tokens: 3.5, cache_creation_input_tokens: 0.9 }, { output_tokens: 2.2 }))
      .toEqual({ input: 10, output: 2, cacheRead: 3, cacheWrite: 0, reasoning: 0 });
    expect(await usageFor({ input_tokens: -4, cache_read_input_tokens: -3, cache_creation_input_tokens: 1e300 }, { output_tokens: -1 }))
      .toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    expect(await usageFor({ input_tokens: '12', cache_read_input_tokens: null }, { output_tokens: 2 ** 60 }))
      .toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  });
});

describe('messages', () => {
  it('consecutive user content is ONE user message: the tool results first, then the stubs, cards and the new turn; the strict fake accepts it', async () => {
    const strict = await startFakeProvider({ strictPairs: true });
    try {
      strict.push({ text: 'done' });
      const history: Msg[] = [
        user('go'),
        assistantWith([{ type: 'text', text: 'on it' }, { type: 'tool_call', id: 'c1', name: 'read', args: { path: 'a' } }, { type: 'tool_call', id: 'c2', name: 'read', args: '{"path":"b"}' }]),
        user('stub A'),
        { role: 'user', blocks: [{ type: 'text', text: 'card' }, result('c1', 'A'), result('c2', 'B', true)] },
        user('and then?'),
      ];
      await run(req({ messages: history }), manifest({ baseUrl: strict.url }));
      expect(strict.requests[0].body.messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [
          { type: 'text', text: 'on it' },
          { type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a' } },
          { type: 'tool_use', id: 'c2', name: 'read', input: { path: 'b' } },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'c1', content: 'A', is_error: false },
          { type: 'tool_result', tool_use_id: 'c2', content: 'B', is_error: true },
          { type: 'text', text: 'stub A' }, { type: 'text', text: 'card' }, { type: 'text', text: 'and then?' },
        ] },
      ]);
    } finally {
      await strict.close();
    }
  });

  it('no two messages of one role in a row, whatever the history: assistants merge, and a dropped assistant lets the users meet', async () => {
    a.push({ text: 'x' });
    await run(req({ messages: [
      user('a'), user('b'),
      assistantWith([{ type: 'text', text: 'c' }]), assistantWith([{ type: 'text', text: 'd' }, { type: 'tool_call', id: 't', name: 'ls', args: {} }]),
      { role: 'user', blocks: [result('t')] },
      assistantWith([{ type: 'thinking', text: 'only thinking', signature: '' }]), // nothing to send: left out
      user('e'),
    ] }));
    const m = sentMessages();
    expect(m.map((x: { role: string }) => x.role)).toEqual(['user', 'assistant', 'user']);
    expect(m[0].content).toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
    expect(m[1].content).toEqual([{ type: 'text', text: 'c' }, { type: 'text', text: 'd' }, { type: 'tool_use', id: 't', name: 'ls', input: {} }]);
    expect(m[2].content).toEqual([{ type: 'tool_result', tool_use_id: 't', content: 'r', is_error: false }, { type: 'text', text: 'e' }]);
  });

  it('empty text is not sent, and a message left empty is left out', async () => {
    a.push({ text: 'x' });
    await run(req({ messages: [user(''), user('hi'), assistantWith([{ type: 'text', text: '' }])] }));
    expect(sentMessages()).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('a thinking block keeps its signature on the way back, unchanged', async () => {
    a.push({ text: 'x' });
    const sig = 'EqQB+/==\n signature with odd bytes';
    await run(req({ messages: [user('q'), assistantWith([{ type: 'thinking', text: 'hm', signature: sig }, { type: 'tool_call', id: 'c', name: 'ls', args: {} }]), { role: 'user', blocks: [result('c')] }] }));
    expect(sentMessages()[1].content[0]).toEqual({ type: 'thinking', thinking: 'hm', signature: sig });
  });

  it('a thinking block with no signature is not sent', async () => {
    a.push({ text: 'x' });
    await run(req({ messages: [user('q'), assistantWith([
      { type: 'thinking', text: 'unsigned' }, { type: 'thinking', text: 'empty', signature: '' }, { type: 'thinking', text: 'signed', signature: 'S' },
      { type: 'tool_call', id: 'c', name: 'ls', args: {} },
    ]), { role: 'user', blocks: [result('c')] }] }));
    expect(sentMessages()[1].content).toEqual([{ type: 'thinking', thinking: 'signed', signature: 'S' }, { type: 'tool_use', id: 'c', name: 'ls', input: {} }]);
  });

  it('thinking goes back only within the turn being continued, not from older turns', async () => {
    a.push({ text: 'x' }, { text: 'x' });
    const old = assistantWith([{ type: 'thinking', text: 'old', signature: 'S0' }, { type: 'text', text: 'a1' }]);
    const cur = assistantWith([{ type: 'thinking', text: 'cur', signature: 'S1' }, { type: 'tool_call', id: 'c1', name: 'ls', args: {} }]);
    // after a tool result: the turn started at q2, so S1 goes and S0 does not
    await run(req({ messages: [user('q1'), old, user('q2'), cur, { role: 'user', blocks: [result('c1'), { type: 'text', text: 'card' }] }] }));
    const m = sentMessages(0);
    expect(m[1].content).toEqual([{ type: 'text', text: 'a1' }]);
    expect(m[3].content[0]).toEqual({ type: 'thinking', thinking: 'cur', signature: 'S1' });
    // a new user turn: nothing before it is continued
    await run(req({ messages: [user('q1'), old, user('q2')] }));
    expect(JSON.stringify(sentMessages(1))).not.toContain('thinking');
  });

  it('tool arguments that are not an object become {}; JSON text and objects are sent as the object', async () => {
    a.push({ text: 'x' });
    const argsList: unknown[] = ['not json', '', '[1,2]', '42', '"s"', 'null', 7, null, undefined, [1], '{"a":1}', { b: 2 }];
    const blocks: Block[] = argsList.map((args, i) => ({ type: 'tool_call', id: `c${i}`, name: 'f', args }));
    await run(req({ messages: [user('q'), assistantWith(blocks), { role: 'user', blocks: blocks.map((b) => result((b as { id: string }).id)) }] }));
    expect(sentMessages()[1].content.map((b: { input: unknown }) => b.input)).toEqual([{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, { a: 1 }, { b: 2 }]);
  });

  it('unknown fields of a tool_use come back unchanged on the next request (S20), those of the stream included', async () => {
    const cache_control = { type: 'ephemeral' };
    a.push({ toolCalls: [{ id: 'g1', name: 'read', args: '{"path":"a"}', extra: { cache_control } }, { id: 'g2', name: 'ls', args: '{}' }], split: 3 });
    const got = calls(await run());
    expect(got[0].extra).toEqual({ cache_control });
    expect(got[1].extra).toBeUndefined();
    const blocks: Block[] = got.map((c) => ({ type: 'tool_call', id: c.id, name: c.name, args: c.args, ...(c.extra ? { extra: c.extra } : {}) }));
    a.push({ text: 'done' });
    await run(req({ messages: [user('go'), assistantWith(blocks), { role: 'user', blocks: got.map((c) => result(c.id)) }] }));
    expect(sentMessages(1)[1].content).toEqual([
      { type: 'tool_use', id: 'g1', name: 'read', input: { path: 'a' }, cache_control },
      { type: 'tool_use', id: 'g2', name: 'ls', input: {} },
    ]);
  });

  it('extra cannot overwrite the core fields: type, id, name, input of a block and role, content of a message', async () => {
    a.push({ text: 'x' });
    const extra = { type: 'forged', id: 'forged', name: 'forged', input: 'forged', keep: 1 };
    const blocks: Block[] = [{ type: 'tool_call', id: 'real', name: 'read', args: { p: 1 }, extra }, { type: 'thinking', text: 't', signature: 'S', extra: { type: 'forged', thinking: 'forged', signature: 'forged' } }];
    await run(req({ messages: [
      user('q'),
      assistantWith(blocks, { role: 'user', content: 'forged', note: 'n' }),
      { role: 'user', blocks: [result('real')], extra: { role: 'assistant', content: 'forged', ucustom: 1 } },
    ] }));
    const m = sentMessages();
    expect(m[1]).toEqual({ note: 'n', role: 'assistant', content: [
      { type: 'tool_use', id: 'real', name: 'read', input: { p: 1 }, keep: 1 },
      { type: 'thinking', thinking: 't', signature: 'S' },
    ] });
    expect(m[2]).toEqual({ ucustom: 1, role: 'user', content: [{ type: 'tool_result', tool_use_id: 'real', content: 'r', is_error: false }] });
  });

  it('unknown blocks of a reply go back first in that assistant message, inside the turn, and the key that carried them is gone', async () => {
    a.push(reply(open(0, { type: 'redacted_thinking', data: 'ENC' }), end(0), toolOpen(1, 'c1', 'ls') + json(1, '{}') + end(1)));
    const out = await run();
    const done = out.at(-1) as { extra?: Record<string, unknown> };
    const got = calls(out)[0];
    a.push({ text: 'x' });
    await run(req({ messages: [user('q'), assistantWith([{ type: 'tool_call', id: got.id, name: got.name, args: got.args }], done.extra), { role: 'user', blocks: [result('c1')] }] }));
    expect(sentMessages(1)[1]).toEqual({ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'ENC' }, { type: 'tool_use', id: 'c1', name: 'ls', input: {} }] });
  });

  it('a __proto__ field in an unknown block or an extra is data and pollutes nothing', async () => {
    a.push(raw(start(), `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"n","input":{},"__proto__":{"polluted":true}}}\n\n`, end(0), fin(), stopFrame()));
    const out = await run();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(calls(out)[0].extra ?? {})).toEqual(['__proto__']);
  });
});

describe('listModels', () => {
  const listed = (p = manifest(), h = host(), signal = new AbortController().signal) => wire.listModels!(p, h, signal);
  const jsonFetch = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('reads { data: [{ id }] } through send: ids sorted, key in x-api-key, the /v1/models address', async () => {
    expect(await listed()).toEqual(['fake-model-1', 'fake-model-2']);
    expect(a.requests[0]).toMatchObject({ path: '/v1/models', headers: { 'x-api-key': KEY } });
    expect(a.requests[0].headers.authorization).toBeUndefined();
  });

  it('a base address with /v1 is not given a second one', async () => {
    expect(await listed(manifest({ baseUrl: `${a.url}/v1/` }))).toEqual(['fake-model-1', 'fake-model-2']);
    expect(a.requests[0].path).toBe('/v1/models');
  });

  it('sorts, drops what has no id, and drops repeats', async () => {
    expect(await listed(manifest(), host({ fetch: jsonFetch({ data: [{ id: 'zeta' }, { id: 'alpha' }, { name: 'no id' }, { id: 'alpha' }, 7] }) }))).toEqual(['alpha', 'zeta']);
  });

  it('modelsUrl is used when the manifest has one', async () => {
    await listed(manifest({ modelsUrl: `${a.url}/v1/models?limit=5` }));
    expect(urls).toEqual([`${a.url}/v1/models?limit=5`]);
  });

  it('any failure is undefined and never throws', async () => {
    expect(await listed(manifest({ modelsUrl: `${a.url}/v1/nowhere` }))).toBeUndefined(); // 404 from the fake
    expect(await listed(manifest(), host({ fetch: jsonFetch({ error: 'x' }, 401) }))).toBeUndefined();
    expect(await listed(manifest(), host({ fetch: (async () => new Response('not json')) as unknown as typeof fetch }))).toBeUndefined();
    expect(await listed(manifest(), host({ fetch: jsonFetch({ data: [] }) }))).toBeUndefined();
    expect(await listed(manifest(), host({ fetch: jsonFetch('text') }))).toBeUndefined();
    expect(await listed(manifest(), host({ fetch: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch }))).toBeUndefined();
    expect(await listed(manifest(), host({ withSend: false }))).toBeUndefined();
    expect(await listed(manifest(), host({ consent: false }))).toBeUndefined();
    expect(a.requests.filter((r) => r.path === '/v1/models')).toHaveLength(0);
  });

  it('is bounded: 1 MiB of body is read; one byte more is undefined, and the download is cancelled', async () => {
    const MIB = 1024 * 1024;
    const sized = (n: number) => (async () => new Response(JSON.stringify({ data: [{ id: 'a'.repeat(n - '{"data":[{"id":""}]}'.length) }] }))) as unknown as typeof fetch;
    expect((await listed(manifest(), host({ fetch: sized(MIB) })))?.[0]).toHaveLength(MIB - 20);
    expect(await listed(manifest(), host({ fetch: sized(MIB + 1) }))).toBeUndefined();
    let pulls = 0;
    let cancelled = false;
    const chunk = enc.encode('x'.repeat(64 * 1024));
    const f = (async () => new Response(new ReadableStream<Uint8Array>({ pull(c) { if (++pulls > 1000) c.close(); else c.enqueue(chunk); }, cancel() { cancelled = true; } }))) as unknown as typeof fetch;
    expect(await listed(manifest(), host({ fetch: f }))).toBeUndefined();
    expect(pulls).toBeLessThan(30);
    expect(cancelled).toBe(true);
  });
});

describe('caps on one reply', () => {
  const KIB = 1024;
  const chars = (n: number) => 'a'.repeat(n);

  it('tool call arguments: 4 MiB work, one character more is an error', async () => {
    const piece512 = 512 * KIB;
    const big = (extra = '') => reply(toolOpen(0, 'c', 'f'), ...Array.from({ length: 8 }, () => json(0, chars(piece512))), ...(extra ? [json(0, extra)] : []), end(0));
    a.push(big());
    expect(calls(await run())[0].args).toHaveLength(8 * piece512);
    a.push(big('x'));
    await expect(run()).rejects.toThrow('Fake sent a tool call with more arguments than Reins accepts.');
  });

  it('a whole input in the start block is held to the same limit', async () => {
    a.push(reply(open(0, { type: 'tool_use', id: 'c', name: 'f', input: { v: chars(4 * 1024 * 1024) } })));
    await expect(run()).rejects.toThrow('more arguments than Reins accepts');
  });

  it('tool calls: 128 work, 129 is an error', async () => {
    const many = (n: number) => reply(...Array.from({ length: n }, (_, i) => toolOpen(i, `c${i}`, 'f') + json(i, '{}')));
    a.push(many(128));
    expect(calls(await run())).toHaveLength(128);
    a.push(many(129));
    await expect(run()).rejects.toThrow('more than 128 tool calls');
  });

  it('blocks that never stop are bounded too', async () => {
    a.push(reply(...Array.from({ length: 129 }, (_, i) => open(i, { type: 'text', text: '' }))));
    await expect(run()).rejects.toThrow('more content blocks than Reins keeps');
    a.push(reply(...Array.from({ length: 1000 }, (_, i) => textBlock(i, 'x'))));
    expect(await run()).toHaveLength(1000 + 2); // stopped blocks are let go
  });

  it('extra fields: 256 KiB in all work, one character more is an error (a tool call, a signature, an unknown block, and the total)', async () => {
    const max = 256 * KIB;
    a.push(reply(toolOpen(0, 'c', 'f', { blob: chars(max - 'blob'.length) }) + end(0)));
    expect(calls(await run())[0].extra?.blob).toHaveLength(max - 4);
    a.push(reply(toolOpen(0, 'c', 'f', { blob: chars(max - 'blob'.length + 1) }) + end(0)));
    await expect(run()).rejects.toThrow('more extra fields than Reins keeps');
    a.push(reply(open(0, { type: 'thinking', thinking: '' }), piece(0, { type: 'signature_delta', signature: chars(max + 1) })));
    await expect(run()).rejects.toThrow('more extra fields than Reins keeps');
    a.push(reply(open(0, { type: 'weird', v: chars(max) })));
    await expect(run()).rejects.toThrow('more extra fields than Reins keeps');
    a.push(reply(open(0, { type: 'thinking', thinking: '', signature: chars(max - 10) }), toolOpen(1, 'c', 'f', { blob: chars(10) })));
    await expect(run()).rejects.toThrow('more extra fields than Reins keeps'); // the total, not each part
  });

  it('text and thinking are streamed on and not capped', async () => {
    const big = chars(900 * KIB);
    a.push(reply(open(0, { type: 'text', text: '' }), ...Array.from({ length: 6 }, () => piece(0, { type: 'text_delta', text: big }) + piece(1, { type: 'thinking_delta', thinking: big })), open(1, { type: 'thinking', thinking: '' })));
    const out = await run();
    expect(out.filter((e) => e.type === 'text')).toHaveLength(6);
    expect(out.filter((e) => e.type === 'thinking')).toHaveLength(6);
  });

  it('an error from a cap passes no provider text and no key even without a host sanitizer', async () => {
    a.push(reply(...Array.from({ length: 129 }, (_, i) => toolOpen(i, `c${i}`, 'f'))));
    const e = await run(req(), manifest({ label: KEY }), host({ noRedact: true })).then(() => undefined, (x: Error) => x);
    expect(e?.message).toBe('The provider sent more than 128 tool calls in one reply.');
  });

  it('a block index that is not a whole number from 0 is no block: the exact calls that result, and nothing big is made', async () => {
    const one = (index: unknown, id: string, args: string) => toolOpen(index, id, `f${id}`) + json(index, args) + end(index);
    a.push(reply(
      one(5, 'a', '1'), one(-1, 'b', '2'), one(1.5, 'c', '3'), one('2', 'd', '4'), one(1e9, 'e', '5'), one(0, 'f', '6'), one(null, 'g', '7'),
      one(Number.MAX_SAFE_INTEGER, 'h', '8'), one(2 ** 60, 'i', '9'), one(-0.5, 'j', '10'),
      json(-1, 'X'), json('5', 'Y'), json(5.5, 'Z'), json(7, 'W'), // pieces of no call
      textBlock(-3, 'dropped?'),
    ));
    const t0 = performance.now();
    const out = await run();
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(calls(out).map((c) => [c.id, c.name, c.args])).toEqual([['f', 'ff', '6'], ['a', 'fa', '1'], ['e', 'fe', '5'], ['h', 'fh', '8']]);
    expect(out.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'dropped?' }]); // text has no index to join on
  });
});

describe('errors the wire builds', () => {
  const failure = (h: EngineHost, p = manifest()) => run(req(), p, h).then(() => undefined, (x: Error) => x);
  const noKey = (e?: Error) => { for (const t of [e?.message, e?.stack, e?.name]) expect(t ?? '').not.toContain(KEY); };
  const streamFetch = (frames: string[], err?: unknown) => (async () => new Response(new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      if (err !== undefined) c.error(err);
      else c.close();
    },
  }), { status: 200 })) as unknown as typeof fetch;
  const errorReply = (message: string) => raw(start(), ev('error', { error: { type: 'api_error', message } }));

  it('a key inside the provider message is redacted, and the label as well', async () => {
    a.push(errorReply(KEY));
    const e = await failure(host(), manifest({ label: KEY }));
    expect(e?.message).toBe('[key Reins] reported an error: [key Reins]');
    noKey(e);
  });

  it('a read that fails with the key in its message becomes a new redacted error', async () => {
    const e = await failure(host({ fetch: streamFetch([start()], new Error(`socket reset ${KEY}`)) }));
    expect(e?.message).toBe("Fake's reply was cut off: socket reset [key Reins]");
    expect(e?.cause).toBeUndefined();
    noKey(e);
  });

  it('with no host sanitizer the provider text is left out altogether', async () => {
    a.push(errorReply(`overloaded ${KEY}`));
    const e = await failure(host({ noRedact: true }));
    expect(e?.message).toBe('The provider reported an error');
    const e2 = await failure(host({ noRedact: true, fetch: streamFetch([], new Error(`socket ${KEY}`)) }), manifest({ label: KEY }));
    expect(e2?.message).toBe("The provider's reply was cut off");
    noKey(e);
    noKey(e2);
  });

  it('a long provider message with the key near the cut leaves no prefix of it', async () => {
    a.push(errorReply('x'.repeat(490) + KEY));
    const e = await failure(host());
    expect(e?.message).not.toContain('sk-ant-');
    expect(e?.message.length).toBeLessThanOrEqual('Fake reported an error'.length + 2 + 500);
  });

  it('an error of an earlier call, polluted with the key, thrown by a later stream is rebuilt, not passed on', async () => {
    a.push(errorReply('first'));
    const first = await failure(host());
    expect(first?.message).toBe('Fake reported an error: first');
    first!.message = `leak ${KEY}`;
    first!.stack = `Error: ${KEY}`;
    const e = await failure(host({ fetch: streamFetch([start()], first) }));
    expect(e?.message).toBe("Fake's reply was cut off: leak [key Reins]");
    expect(e).not.toBe(first);
    noKey(e);
  });

  it('a host redact that throws Error(key) gives the constant: the provider error, a cut-off read, a cap, a missing stop and no body', async () => {
    const boom = () => { throw new Error(KEY); };
    a.push(errorReply('x'), raw(start(), textBlock(0, 'a')), reply(...Array.from({ length: 129 }, (_, i) => toolOpen(i, `c${i}`, 'f'))));
    const all = [
      await failure(host({ redact: boom })),
      await failure(host({ redact: boom })),
      await failure(host({ redact: boom })),
      await failure(host({ redact: boom, fetch: streamFetch([], new Error('socket')) })),
      await failure(host({ redact: boom, fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch })),
    ];
    for (const e of all) {
      expect(e?.message).toBe(HIDDEN);
      noKey(e);
    }
    expect((await failure(host({ fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch })))?.message).toBe('Fake sent no reply.');
  });

  it('a sanitizer that ignores max and returns 20000 characters gives the constant', async () => {
    a.push(errorReply('x'));
    expect((await failure(host({ redact: () => 'x'.repeat(20_000) })))?.message).toBe(HIDDEN);
  });

  it('a sanitizer that returns something that is not a string gives the constant, whatever the thing holds', async () => {
    for (const bad of [42, null, undefined, { toString: () => KEY }, [KEY], new String(KEY)]) {
      a.push(errorReply('x'));
      const e = await failure(host({ redact: (() => bad) as unknown as EngineHost['redact'] }));
      expect(e?.message).toBe(HIDDEN);
      noKey(e);
    }
  });

  it('exactly max characters is accepted, one more is not', async () => {
    const MAX = 'Fake reported an error'.length + 2 + 500;
    a.push(errorReply('x'), errorReply('x'));
    expect((await failure(host({ redact: () => 'y'.repeat(MAX) })))?.message).toBe('y'.repeat(MAX));
    expect((await failure(host({ redact: () => 'y'.repeat(MAX + 1) })))?.message).toBe(HIDDEN);
  });

  it('a hostile value that fails the read (a Proxy whose prototype lookup throws, a message getter that throws) gives the constant', async () => {
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error(KEY); } });
    const e = await failure(host({ fetch: streamFetch([], hostile) }));
    expect(e?.message).toBe(HIDDEN);
    noKey(e);
    const getter = Object.defineProperty(new Error('x'), 'message', { get() { throw new Error(KEY); } });
    const e2 = await failure(host({ fetch: streamFetch([], getter) }));
    expect(e2?.message).toBe(HIDDEN);
    noKey(e2);
  });
});
