// Spec 4.12b: the shared pairing function, on its own.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { flattenRounds, INTERRUPTED, pairUp } from '../src/loop/pairs.js';
import { pairUp as fromEngine } from '../src/loop/engine.js';
import type { Block, Msg } from '../src/loop/types.js';
import { startFakeProvider } from './fake-provider.js';
import { MISSING_RESULT, WIRES, rig, toolReply, toolResults, type Rig } from './loop-harness.js';

const text = (role: Msg['role'], t: string): Msg => ({ role, blocks: [{ type: 'text', text: t }] });
const call = (id: string): Block => ({ type: 'tool_call', id, name: 'Read', args: {} });
const res = (id: string, content = `r-${id}`): Block => ({ type: 'tool_result', id, content });
const stub = (id: string): Block => ({ type: 'tool_result', id, content: INTERRUPTED, isError: true });
const A = (...blocks: Block[]): Msg => ({ role: 'assistant', blocks });
const U = (...blocks: Block[]): Msg => ({ role: 'user', blocks });

const CASES: Array<{ name: string; input: Msg[]; out: Msg[]; stubbed: string[] }> = [
  { name: 'a well paired history is untouched', input: [text('user', 'q'), A(call('a')), U(res('a')), text('assistant', 'done')], out: [text('user', 'q'), A(call('a')), U(res('a')), text('assistant', 'done')], stubbed: [] },
  { name: 'an orphan result (no call) is dropped, with the message it empties', input: [text('user', 'q'), U(res('x')), text('assistant', 'hi')], out: [text('user', 'q'), text('assistant', 'hi')], stubbed: [] },
  { name: 'an orphan result next to text keeps the text', input: [U(res('x'), { type: 'text', text: 'hello' })], out: [text('user', 'hello')], stubbed: [] },
  { name: 'an orphan call gets the stub in a new message at the end', input: [text('user', 'q'), A(call('a'))], out: [text('user', 'q'), A(call('a')), U(stub('a'))], stubbed: ['a'] },
  { name: 'an orphan call before a user message gets the stub in that message, first', input: [A(call('a')), text('user', 'next')], out: [A(call('a')), U(stub('a'), { type: 'text', text: 'next' })], stubbed: ['a'] },
  { name: 'half answered: only the missing call is stubbed', input: [A(call('a'), call('b')), U(res('a'))], out: [A(call('a'), call('b')), U(res('a'), stub('b'))], stubbed: ['b'] },
  { name: 'the same id in two rounds is two calls: both outputs stay and nothing is stubbed', input: [A(call('a')), U(res('a', 'one')), A(call('a')), U(res('a', 'two')), text('assistant', 'end')], out: [A(call('a')), U(res('a', 'one')), A(call('a')), U(res('a', 'two')), text('assistant', 'end')], stubbed: [] },
  { name: 'ids numbered from 0 in every reply keep every output', input: [A(call('0'), call('1')), U(res('0', 'a0'), res('1', 'a1')), A(call('0'), call('1')), U(res('1', 'b1'), res('0', 'b0'))], out: [A(call('0'), call('1')), U(res('0', 'a0'), res('1', 'a1')), A(call('0'), call('1')), U(res('0', 'b0'), res('1', 'b1'))], stubbed: [] },
  { name: 'a result for a call of ANOTHER round is dropped, and the call of its own round is stubbed', input: [A(call('a')), U(res('a', 'one')), A(call('b')), U(res('a', 'late'))], out: [A(call('a')), U(res('a', 'one')), A(call('b')), U(stub('b'))], stubbed: ['b'] },
  { name: 'a duplicate call id inside one assistant message: the second call goes', input: [A(call('a'), call('a')), U(res('a'))], out: [A(call('a')), U(res('a'))], stubbed: [] },
  { name: 'results first (in the order of the calls), then card and user text, in ONE user message', input: [A(call('a'), call('b')), U(res('b'), { type: 'text', text: 'card' }), U(res('a'), { type: 'text', text: 'typed' })], out: [A(call('a'), call('b')), U(res('a'), res('b'), { type: 'text', text: 'card' }, { type: 'text', text: 'typed' })], stubbed: [] },
  { name: 'assistant(calls a,b), user(result a, card text), user(result b) becomes [result a, result b, card text]', input: [A(call('a'), call('b')), U(res('a'), { type: 'text', text: 'card' }), U(res('b'))], out: [A(call('a'), call('b')), U(res('a'), res('b'), { type: 'text', text: 'card' })], stubbed: [] },
  { name: 'two results for one call in one message: the first stays', input: [A(call('a')), U(res('a', 'one'), res('a', 'two'))], out: [A(call('a')), U(res('a', 'one'))], stubbed: [] },
  { name: 'a result before its call is dropped and the call is stubbed', input: [U(res('a')), text('user', 'q'), A(call('a'))], out: [text('user', 'q'), A(call('a')), U(stub('a'))], stubbed: ['a'] },
  { name: 'a result in an assistant message is dropped', input: [text('user', 'q'), A(res('a'), { type: 'text', text: 'hm' })], out: [text('user', 'q'), text('assistant', 'hm')], stubbed: [] },
  { name: 'an assistant message with calls followed by an assistant message gets the stub user message between', input: [text('user', 'q'), A(call('a')), text('assistant', 'again')], out: [text('user', 'q'), A(call('a')), U(stub('a')), text('assistant', 'again')], stubbed: ['a'] },
  { name: 'a result that is not in the message after its call is dropped; the call is stubbed', input: [A(call('a')), text('assistant', 'x'), U(res('a'))], out: [A(call('a')), U(stub('a')), text('assistant', 'x')], stubbed: ['a'] },
  { name: 'two user messages in a row after the calls become one message', input: [A(call('a'), call('b')), U(res('a')), U(res('b'))], out: [A(call('a'), call('b')), U(res('a'), res('b'))], stubbed: [] },
  { name: 'an empty message is dropped and does not break the pair around it', input: [A(call('a')), { role: 'assistant', blocks: [] }, U(res('a'))], out: [A(call('a')), U(res('a'))], stubbed: [] },
  { name: 'an empty history stays empty', input: [], out: [], stubbed: [] },
];

describe('pairUp (spec 4.12b)', () => {
  it.each(CASES)('$name', ({ input, out, stubbed }) => {
    const r = pairUp(input);
    expect(r.msgs).toEqual(out);
    expect(r.stubbed.map((c) => c.id)).toEqual(stubbed);
  });

  it.each(CASES)('is idempotent, and stubs nothing the second time: $name', ({ input }) => {
    const once = pairUp(input);
    const twice = pairUp(once.msgs);
    expect(twice.msgs).toEqual(once.msgs);
    expect(twice.stubbed).toEqual([]);
  });

  it('does not change what it is given', () => {
    const input = [A(call('a')), text('user', 'next'), U(res('zz'))];
    const copy = JSON.parse(JSON.stringify(input));
    pairUp(input);
    expect(input).toEqual(copy);
  });

  it('keeps the message extra of a message it changes', () => {
    const r = pairUp([{ role: 'assistant', blocks: [call('a')], extra: { k: 1 } }, U(res('a'), res('a'))]);
    expect(r.msgs[0]).toMatchObject({ extra: { k: 1 } });
  });

  it('engine.ts still exports the same function', () => {
    expect(fromEngine).toBe(pairUp);
  });

  it('keeps the message extra of the users it merges (first wins on a key)', () => {
    const r = pairUp([A(call('a')), { role: 'user', blocks: [res('a')], extra: { x: 1 } }, { role: 'user', blocks: [{ type: 'text', text: 'hi' }], extra: { y: 2 } }]);
    expect(r.msgs[1]).toEqual({ role: 'user', blocks: [res('a'), { type: 'text', text: 'hi' }], extra: { x: 1, y: 2 } });
  });
});

describe('flattenRounds (the retry after an unpaired 400)', () => {
  const history: Msg[] = [
    text('user', 'q'),
    A({ type: 'thinking', text: 'secret thoughts', signature: 'S' }, { type: 'text', text: 'looking' }, { type: 'tool_call', id: 'a', name: 'Read', args: { file_path: 'x.txt' }, extra: { k: 1 } }),
    U(res('a', 'the file'), { type: 'text', text: 'a card' }),
    A({ type: 'tool_call', id: 'b', name: 'Bash', args: '{"cmd":' }),
    U({ type: 'tool_result', id: 'b', content: 'boom', isError: true }),
    text('assistant', 'done'),
  ];

  it('turns every call and result into plain text and keeps the user\'s text and the cards', () => {
    const flat = flattenRounds(history);
    expect(JSON.stringify(flat)).not.toMatch(/tool_call"|tool_result"|"thinking"|secret thoughts|"extra"/);
    expect(flat).toEqual([
      text('user', 'q'),
      { role: 'assistant', blocks: [{ type: 'text', text: 'looking' }, { type: 'text', text: '[tool call Read {"file_path":"x.txt"}]' }] },
      { role: 'user', blocks: [{ type: 'text', text: '[tool result the file]' }, { type: 'text', text: 'a card' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: '[tool call Bash {"cmd":]' }] },
      { role: 'user', blocks: [{ type: 'text', text: '[tool result error boom]' }] },
      text('assistant', 'done'),
    ]);
  });

  it('cuts a long call at 1,000 characters and a long result at 2,000', () => {
    const flat = flattenRounds([A({ type: 'tool_call', id: 'a', name: 'W', args: { c: 'x'.repeat(5000) } }), U(res('a', 'y'.repeat(5000)))]);
    const call = (flat[0]!.blocks[0] as { text: string }).text;
    const result = (flat[1]!.blocks[0] as { text: string }).text;
    expect(call.startsWith('[tool call W {"c":"xxx')).toBe(true);
    expect(call.length).toBe('[tool call W '.length + 1000 + '...]'.length);
    expect(result).toBe(`[tool result ${'y'.repeat(2000)}...]`);
  });

  it('is pure', () => {
    const copy = JSON.parse(JSON.stringify(history));
    flattenRounds(history);
    expect(history).toEqual(copy);
  });
});

describe('the strict fake checks PER ROUND (test/fake-provider.ts)', () => {
  const post = async (url: string, wire: 'chat' | 'messages', messages: unknown[]) =>
    (await fetch(`${url}${wire === 'chat' ? '/v1/chat/completions' : '/v1/messages'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }) })).status;
  const asst = (...ids: string[]) => ({ role: 'assistant', content: null, tool_calls: ids.map((id) => ({ id, type: 'function', function: { name: 'R', arguments: '{}' } })) });
  const tool = (id: string) => ({ role: 'tool', tool_call_id: id, content: 'r' });
  const use = (...ids: string[]) => ({ role: 'assistant', content: ids.map((id) => ({ type: 'tool_use', id, name: 'R', input: {} })) });
  const got = (...ids: string[]) => ({ role: 'user', content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'r' })) });
  const txt = (role: string, t: string) => ({ role, content: t });
  const BAD = 400;
  const PASSED = 500; // validation passed; the queue is empty

  it.each([
    ['chat', 'a valid round', [txt('user', 'q'), asst('a', 'b'), tool('a'), tool('b'), txt('user', 'next')], PASSED],
    ['chat', 'the same ids in two rounds', [asst('a'), tool('a'), txt('assistant', 'x'), asst('a'), tool('a')], PASSED],
    ['chat', 'a text between the results', [asst('a', 'b'), tool('a'), txt('user', 'card'), tool('b')], BAD],
    ['chat', 'a result twice in one round', [asst('a'), tool('a'), tool('a')], BAD],
    ['chat', 'a result of another round', [asst('a'), tool('a'), asst('b'), tool('a')], BAD],
    ['chat', 'a call with no result in its round', [asst('a'), txt('user', 'q'), tool('a')], BAD],
    ['messages', 'a valid round', [txt('user', 'q'), use('a', 'b'), got('a', 'b'), txt('assistant', 'x')], PASSED],
    ['messages', 'the same ids in two rounds', [use('a'), got('a'), use('a'), got('a')], PASSED],
    ['messages', 'a result twice in one round', [use('a'), got('a', 'a')], BAD],
    ['messages', 'a text before the result', [use('a'), { role: 'user', content: [{ type: 'text', text: 'card' }, { type: 'tool_result', tool_use_id: 'a', content: 'r' }] }], BAD],
    ['messages', 'a result of another round', [use('a'), got('a'), use('b'), got('a')], BAD],
    ['messages', 'a call with no result', [use('a'), txt('user', 'q')], BAD],
  ] as Array<['chat' | 'messages', string, unknown[], number]>)('%s: %s', async (wire, _name, messages, status) => {
    const fake = await startFakeProvider({ strictPairs: true });
    try {
      expect(await post(fake.url, wire, messages)).toBe(status);
    } finally {
      await fake.close();
    }
  });
});

describe('through the engine: per round, on both wires', () => {
  const rigs: Rig[] = [];
  afterEach(async () => {
    for (const r of rigs.splice(0)) await r.cleanup();
  });
  const make = async (...a: Parameters<typeof rig>) => {
    const r = await rig(...a);
    rigs.push(r);
    return r;
  };

  it.each(WIRES)('two rounds with the same call id: the second request carries both outputs, on %s', async (wireId) => {
    const r = await make(wireId, { strictPairs: true });
    r.push(toolReply(0), toolReply(0), { text: 'done' });
    const res = await (await r.open()).turn('go');
    expect(res.text).toBe('done');
    const last = toolResults(r.fake.requests.at(-1)!.body);
    expect(last.map((x) => x.id)).toEqual(['c0', 'c0']);
    expect(last.map((x) => x.content)).toEqual([MISSING_RESULT, MISSING_RESULT]);
  });

  it('a file with assistant(calls a,b), user(result a, card text), user(result b): the chat wire sends assistant, tool a, tool b, user text', async () => {
    const r = await make('openai-chat', { strictPairs: true });
    const id = randomUUID();
    const line = (o: object) => `${JSON.stringify(o)}\n`;
    fs.mkdirSync(path.join(r.host.home, 'conversations'));
    fs.writeFileSync(path.join(r.host.home, 'conversations', `${id}.jsonl`),
      line({ t: 'msg', role: 'user', blocks: [{ type: 'text', text: 'q' }] })
      + line({ t: 'msg', role: 'assistant', protocol: 'openai-chat', blocks: [{ type: 'tool_call', id: 'a', name: 'Read', args: {} }, { type: 'tool_call', id: 'b', name: 'Read', args: {} }] })
      + line({ t: 'msg', role: 'user', blocks: [{ type: 'tool_result', id: 'a', content: 'ra' }, { type: 'text', text: 'CARD-TEXT' }] })
      + line({ t: 'msg', role: 'user', blocks: [{ type: 'tool_result', id: 'b', content: 'rb' }] }));
    r.push({ text: 'ok' });
    await (await r.open({ sessionId: id })).turn('next');
    const sent = (r.fake.requests[0]!.body.messages as any[]).filter((m) => m.role !== 'system');
    expect(sent.slice(0, 4).map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(sent.slice(2, 4).map((m) => m.tool_call_id)).toEqual(['a', 'b']);
    expect(sent[4].role).toBe('user');
    expect(JSON.stringify(sent[4])).toContain('CARD-TEXT');
  });
});
