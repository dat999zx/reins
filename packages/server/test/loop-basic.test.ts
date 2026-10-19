import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent } from '@reins/core';
import { ConsentNeeded } from '../src/send.js';
import { makeEngineFrom, probeFrom, startMods } from '../src/engines.js';
import { readSetting } from '../src/settings.js';
import type { Store } from '../src/store.js';
import { setKey } from '../src/secrets.js';
import { pairUp } from '../src/loop/engine.js';
import type { Msg } from '../src/loop/types.js';
import { COST_120, KEY, USAGE_120, WIRES, rig, toolReply, toolResults, types, type Rig } from './loop-harness.js';
import { tempHome } from './mods-harness.js';

const INTERRUPTED = 'Interrupted; the tool did not finish.';
const STUB = 'Tools come in a later build.';
const rigs: Rig[] = [];
const make = async (...a: Parameters<typeof rig>) => {
  const r = await rig(...a);
  rigs.push(r);
  return r;
};
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});
const thinkingReply = { reasoning: 'let me think about it', thinking: { text: 'let me think about it', signature: 'SIG' } };

describe.each(WIRES)('one turn on %s', (wireId) => {
  it('text, thinking, exactly one usage last, cost, total, models, totals', async () => {
    const r = await make(wireId);
    r.push({ text: 'hello there', ...thinkingReply, usage: USAGE_120[wireId] });
    const s = await r.open();
    const res = await s.turn('hi');
    expect(res.text).toBe('hello there');
    expect(res.isError).toBeUndefined();
    expect(types(res.events)).toEqual(['thinking', 'text', 'usage']);
    expect(res.events).toContainEqual({ type: 'thinking', tokens: Math.ceil('let me think about it'.length / 4), text: 'let me think about it' });
    expect(res.events!.at(-1)).toEqual({ type: 'usage', model: 'm', used: 120, window: 1000 });
    expect(r.live).toEqual(res.events);
    expect(res.cost).toBeCloseTo(COST_120, 12);
    expect(res.total).toBeCloseTo(COST_120, 12);
    expect(res.models!.m).toBeCloseTo(COST_120, 12);
    expect(res.totals!.m).toBeCloseTo(COST_120, 12);
    expect(r.fake.requests[0]!.body.model).toBe('m');
  });

  it('a turn with tool rounds has one usage, the last call\'s, as the last event', async () => {
    const r = await make(wireId);
    r.push({ ...toolReply(0), usage: USAGE_120[wireId] }, { text: 'done', usage: wireId === 'openai-chat' ? { prompt_tokens: 7, completion_tokens: 3 } : { input_tokens: 7, output_tokens: 3 } });
    const res = await (await r.open()).turn('go');
    expect(types(res.events).filter((t) => t === 'usage')).toHaveLength(1);
    expect(res.events!.at(-1)).toEqual({ type: 'usage', model: 'm', used: 10, window: 1000 });
    expect(res.text).toBe('done');
  });

  it('the request carries the system prompt, the effort and the model\'s max output', async () => {
    const r = await make(wireId, { manifest: { efforts: [{ id: 'high', label: 'High' }], defaultEffort: 'high' } });
    r.push({ text: 'ok' });
    await (await r.open({ cwd: 'D:/work' })).turn('hi');
    const body = r.fake.requests[0]!.body;
    expect(JSON.stringify(body)).toContain('D:/work');
    if (wireId === 'anthropic-messages') expect(body.max_tokens).toBe(100);
  });
});

describe('interrupt (4.10)', () => {
  it('a second turn while one is running is refused, and the first one is not disturbed', async () => {
    const r = await make('openai-chat');
    r.push({ text: 'first', hangMs: 400 });
    const s = await r.open();
    const first = s.turn('one');
    while (r.fake.requests.length < 1) await new Promise((ok) => setTimeout(ok, 10));
    await expect(s.turn('two')).rejects.toThrow('a turn is already running');
    expect((await first).text).toBe('first');
    expect(r.fake.requests).toHaveLength(1);
  });

  it.each(WIRES)('a turn that got no reply at all leaves no trace: the same text sent again is in the history once, on %s', async (wireId) => {
    const r = await make(wireId);
    r.push(...Array.from({ length: 4 }, () => ({ status: 500, body: 'boom' })), { text: 'ok' });
    const s = await r.open();
    await expect(s.turn('only once')).rejects.toThrow('server error');
    expect((await s.turn('only once')).text).toBe('ok');
    const sent = JSON.stringify(r.fake.requests.at(-1)!.body.messages);
    expect(sent.match(/only once/g)).toHaveLength(1);
  });

  it('pairUp puts the stubs of unanswered calls before the user text that follows them', () => {
    const history: Msg[] = [
      { role: 'user', blocks: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', blocks: [{ type: 'tool_call', id: 'c1', name: 'read_file', args: {} }] },
      { role: 'user', blocks: [{ type: 'text', text: 'next' }] },
    ];
    const { msgs, stubbed } = pairUp(history);
    expect(stubbed.map((c) => c.id)).toEqual(['c1']);
    expect(msgs).toHaveLength(3);
    expect(msgs[2]!.blocks.map((b) => b.type)).toEqual(['tool_result', 'text']);
  });

  it('resolves within 1 s with empty text, not isError; the next turn works', async () => {
    const r = await make('openai-chat');
    r.push({ text: 'never', hangMs: 30_000 });
    const s = await r.open();
    const t = s.turn('hi');
    while (r.fake.requests.length < 1) await new Promise((ok) => setTimeout(ok, 10));
    const started = Date.now();
    await s.interrupt();
    const res = await t;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.text).toBe('');
    expect(res.isError).toBeUndefined();
    expect(types(res.events)).not.toContain('usage');
    expect(res.cost).toBe(0);
    r.push({ text: 'again' });
    expect((await s.turn('hello')).text).toBe('again');
    // the aborted turn's user message stays, then the new one; both are sent
    expect(r.fake.requests).toHaveLength(2);
  });
});

describe('missing key (8.2)', () => {
  it('sends nothing and says exactly what to do', async () => {
    const r = await make('openai-chat', { noKey: true });
    const s = await r.open();
    await expect(s.turn('hi')).rejects.toThrow('Fake has no key. Set P_API_KEY, or add a key in Settings > Providers.');
    expect(r.fake.requests).toHaveLength(0);
    expect(await r.engine.probe()).toMatchObject({ installed: true, loggedIn: false, problems: [] });
  });

  it('a manifest with no env name says "a key"', async () => {
    const r = await make('openai-chat', { noKey: true, manifest: { auth: { style: 'bearer', keyEnv: [] } } });
    await expect((await r.open()).turn('hi')).rejects.toThrow('Fake has no key. Set a key, or add a key in Settings > Providers.');
  });

  it('a keyless provider works with no key, and probe makes no request', async () => {
    const r = await make('openai-chat', { noKey: true, keyless: true });
    expect(await r.engine.probe()).toMatchObject({ loggedIn: true, capabilities: { midTurnSteer: 'none', preToolDeny: true, resume: true } });
    r.push({ text: 'ok' });
    expect((await (await r.open()).turn('hi')).text).toBe('ok');
    expect(r.fake.requests).toHaveLength(1);
    expect(r.fake.requests[0]!.headers.authorization).toBeUndefined();
  });

  it('probe with a key says logged in and makes no request', async () => {
    const r = await make('openai-chat');
    expect(await r.engine.probe()).toMatchObject({ loggedIn: true });
    expect(r.fake.requests).toHaveLength(0);
  });
});

describe('call cap (4.1)', () => {
  it.each(WIRES)('maxCallsPerTurn 3 and a model that always calls a tool, on %s', async (wireId) => {
    const r = await make(wireId, { max: 3, strictPairs: true });
    r.push(toolReply(0), toolReply(1), toolReply(2), toolReply(3), { text: 'unused' });
    const s = await r.open();
    const res = await s.turn('go');
    const words = 'Reins stopped this reply after 3 model calls (the per-reply limit in Settings).';
    expect(r.fake.requests).toHaveLength(3);
    expect(res.isError).toBe(true);
    expect(res.text).toBe(words);
    expect(res.events).toContainEqual({ type: 'error', message: words });
    expect(types(res.events).filter((t) => t === 'usage')).toHaveLength(1);
    expect(res.events!.at(-1)!.type).toBe('usage');
    // every call has a result: the next request (limit raised) is accepted by the strict fake
    r.state.max = 10;
    const before = r.fake.requests.length;
    const next = await s.turn('again');
    expect(next.isError).toBeUndefined();
    const sent = r.fake.requests[before]!.body;
    expect(toolResults(sent).map((x) => x.id)).toEqual(['c0', 'c1', 'c2']);
  });
});

describe('strict pairing (4.12a)', () => {
  it.each(WIRES)('an interrupt right after the model asked for a tool: the next request is accepted, on %s', async (wireId) => {
    const r = await make(wireId, { strictPairs: true });
    r.push(toolReply(0), { text: 'ok' });
    const s = await r.open();
    r.host.onLive = (e) => {
      r.live.push(e);
      if (e.type === 'tool_call') void s.interrupt();
    };
    const res = await s.turn('go');
    expect(res.text).toBe('');
    expect(res.isError).toBeUndefined();
    expect(res.events).toContainEqual({ type: 'tool_result', tool: 'read_file', output: INTERRUPTED });
    r.host.onLive = (e) => void r.live.push(e);
    const next = await s.turn('again');
    expect(next.text).toBe('ok');
    expect(toolResults(r.fake.requests[1]!.body)).toEqual([{ id: 'c0', content: INTERRUPTED }]);
  });

  it.each(WIRES)('a final error that rejects turn() leaves a valid history, on %s', async (wireId) => {
    const r = await make(wireId, { strictPairs: true });
    r.push(toolReply(0), ...Array.from({ length: 4 }, () => ({ status: 500, body: 'boom' })), { text: 'ok' });
    const s = await r.open();
    await expect(s.turn('go')).rejects.toThrow('Fake had a server error (500).');
    expect((await s.turn('again')).text).toBe('ok');
    expect(toolResults(r.fake.requests.at(-1)!.body)).toEqual([{ id: 'c0', content: STUB }]);
  });
});

describe('stubbed tool calls', () => {
  it.each(WIRES)('every call gets the stub; invalid JSON arguments get their own result, on %s', async (wireId) => {
    const r = await make(wireId, { strictPairs: true });
    r.push({ toolCalls: [{ id: 'a', name: 'read_file', args: '{"path":"x"}' }, { id: 'b', name: 'bash', args: '{"cmd":' }] }, { text: 'done' });
    const res = await (await r.open()).turn('go');
    expect(res.text).toBe('done');
    const calls = res.events!.filter((e): e is Extract<EngineEvent, { type: 'tool_call' }> => e.type === 'tool_call');
    expect(calls[0]).toEqual({ type: 'tool_call', tool: 'read_file', input: { path: 'x' } });
    expect(calls[1]).toMatchObject({ tool: 'bash', input: '{"cmd":' });
    const results = res.events!.filter((e): e is Extract<EngineEvent, { type: 'tool_result' }> => e.type === 'tool_result');
    expect(results[0]!.output).toBe(STUB);
    expect(results[1]!.output).toMatch(/^Your arguments were not valid JSON: .+\. Call the tool again\.$/);
    const sent = toolResults(r.fake.requests[1]!.body);
    expect(sent.map((x) => x.id)).toEqual(['a', 'b']);
    expect(sent[0]!.content).toBe(STUB);
  });

  it('a tool call the wire gave no id still gets its result', async () => {
    const r = await make('openai-chat', { strictPairs: true });
    const frame = (d: object, f: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
    r.push({
      headers: { 'content-type': 'text/event-stream' }, status: 200,
      body: frame({ tool_calls: [{ index: 0, function: { name: 't', arguments: '{}' } }] }, 'tool_calls') + 'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
    }, { text: 'ok' });
    expect((await (await r.open()).turn('go')).text).toBe('ok');
    const sent = toolResults(r.fake.requests[1]!.body);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.id).toMatch(/^call_/);
  });
});

describe('what comes back is sent back unchanged (S20)', () => {
  it('openai: the message extra, a tool call\'s extra', async () => {
    const r = await make('openai-chat');
    const frame = (d: object, f: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
    r.push({
      status: 200, headers: { 'content-type': 'text/event-stream' },
      body: frame({ role: 'assistant', content: '', note: 'N1', tool_calls: [{ index: 0, id: 'c0', function: { name: 't', arguments: '{}' }, thought_signature: 'TS' }] }, 'tool_calls')
        + 'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
    }, { text: 'ok' });
    await (await r.open()).turn('go');
    const assistant = r.fake.requests[1]!.body.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.note).toBe('N1');
    expect(assistant.tool_calls[0].thought_signature).toBe('TS');
  });

  it('anthropic: the thinking signature, a tool call\'s extra, an unknown block', async () => {
    const r = await make('anthropic-messages');
    const sse = (type: string, o: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
    r.push({
      status: 200, headers: { 'content-type': 'text/event-stream' },
      body: sse('message_start', { message: { usage: { input_tokens: 1, output_tokens: 1 } } })
        + sse('content_block_start', { index: 0, content_block: { type: 'mystery', data: 'D' } }) + sse('content_block_stop', { index: 0 })
        + sse('content_block_start', { index: 1, content_block: { type: 'thinking', thinking: '' } })
        + sse('content_block_delta', { index: 1, delta: { type: 'thinking_delta', thinking: 'hm' } })
        + sse('content_block_delta', { index: 1, delta: { type: 'signature_delta', signature: 'SIG' } }) + sse('content_block_stop', { index: 1 })
        + sse('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'c0', name: 't', input: {}, caller: 'X' } })
        + sse('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } }) + sse('content_block_stop', { index: 2 })
        + sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }) + sse('message_stop', {}),
    }, { text: 'ok' });
    await (await r.open()).turn('go');
    const assistant = r.fake.requests[1]!.body.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.content[0]).toEqual({ type: 'mystery', data: 'D' });
    expect(assistant.content.find((b: any) => b.type === 'thinking')).toMatchObject({ thinking: 'hm', signature: 'SIG' });
    expect(assistant.content.find((b: any) => b.type === 'tool_use')).toMatchObject({ id: 'c0', caller: 'X' });
  });
});

describe('security', () => {
  it.each(WIRES)('nothing the loop emits holds the key when the provider echoes it, on %s', async (wireId) => {
    const r = await make(wireId);
    const frame = wireId === 'openai-chat'
      ? `data: ${JSON.stringify({ error: { message: `bad key ${KEY}` } })}\n\n`
      : `event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: `bad key ${KEY}` } })}\n\n`;
    r.push({ status: 400, body: `refused ${KEY}` }, { status: 200, headers: { 'content-type': 'text/event-stream' }, body: frame }, { status: 200, headers: { 'content-type': 'text/event-stream' }, body: frame }, { status: 200, headers: { 'content-type': 'text/event-stream' }, body: frame }, { status: 200, headers: { 'content-type': 'text/event-stream' }, body: frame });
    const s = await r.open();
    const errs: Error[] = [];
    for (const i of [0, 1]) {
      await s.turn(`go ${i}`).catch((e: Error) => errs.push(e));
    }
    expect(errs).toHaveLength(2);
    for (const e of errs) expect(`${e.message}\n${e.stack}\n${JSON.stringify(e)}`).not.toContain(KEY);
    expect(JSON.stringify(r.live)).not.toContain(KEY);
  });
});

describe('engine registration (3.2)', () => {
  it('a wire protocol gets the loop; the Claude CLI keeps its engine; consent is asked, not assumed', async () => {
    const home = tempHome();
    try {
      home.writeMod('fakeprov', {
        reins: 1, id: 'fakeprov', kind: 'provider', version: '1', label: 'Fake Prov', protocol: 'openai-chat',
        baseUrl: 'http://127.0.0.1:9/v1', auth: { style: 'bearer', keyEnv: ['FAKEPROV_KEY'] }, defaultModel: 'm', models: [{ id: 'm' }],
      });
      const mods = await startMods({ dir: home.home, env: {} });
      try {
        const host = { env: {}, home: home.home };
        const make = makeEngineFrom(mods, host);
        const o = { onApprove: async () => ({ behavior: 'allow' as const }), onLive: () => {} };
        expect(make({ provider: 'fakeprov', ...o }).id).toBe('fakeprov');
        expect(make({ provider: 'claude-code', ...o }).id).toBe('claude');
        expect(await probeFrom(mods, 'fakeprov', host)).toMatchObject({ installed: true, loggedIn: false, problems: [] });
        setKey(home.home, 'fakeprov', KEY);
        expect(await probeFrom(mods, 'fakeprov', host)).toMatchObject({ loggedIn: true });
        const s = await make({ provider: 'fakeprov', ...o }).open({ policy: () => ({}) as never });
        await expect(s.turn('hi')).rejects.toBeInstanceOf(ConsentNeeded);
      } finally {
        mods.dispose();
      }
    } finally {
      home.cleanup();
    }
  });
});

describe('maxCallsPerTurn setting', () => {
  const read = (v: unknown) => readSetting({ getSetting: () => v } as unknown as Store, 'maxCallsPerTurn');
  it('falls back to 200 for anything but a whole number from 1', () => {
    for (const bad of [0, -1, 1.5, '3', Number.NaN, undefined, null]) expect(read(bad)).toBe(200);
    expect(read(1)).toBe(1);
    expect(read(500)).toBe(500);
  });
});
