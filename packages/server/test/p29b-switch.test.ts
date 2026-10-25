// Milestone P, Task 29 phase B4: the extras of a provider (tool-call extras, message extras, signatures) go back to the provider that sent them
// and to no other, even when the other one speaks the same protocol.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loopEngine } from '../src/loop/engine.js';
import { setKey } from '../src/secrets.js';
import { rig, KEY, WIRES, toolReply, type Rig, type WireId } from './loop-harness.js';
import type { FakeReply } from './fake-provider.js';

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});

const policy = () => ({}) as never;
const sse = (o: unknown) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`;
const chat = (delta: object, finish: string | null = null) => sse({ choices: [{ index: 0, delta, finish_reason: finish }] });
/** An openai reply whose message carries a field of its own that Reins does not know. */
const withMessageExtra = (blob: string): FakeReply => ({
  body: chat({ content: 'done', vendor_blob: blob }) + chat({}, 'stop') + sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } }) + 'data: [DONE]\n\n',
  headers: { 'content-type': 'text/event-stream' },
});
const lastBody = (r: Rig) => JSON.stringify(r.fake.requests.at(-1)!.body.messages);

describe.each(WIRES)('B4: extras are sent only to the provider they came from (%s)', (wire: WireId) => {
  async function twoProviders() {
    const r = await rig(wire);
    rigs.push(r);
    setKey(r.host.home, 'q', KEY);
    const other = loopEngine({ ...r.p, id: 'q', label: 'Other' }, r.wire, r.host, { sleep: async () => {}, random: () => 0 });
    return { r, other };
  }
  const callWithExtra = (): FakeReply => ({ ...toolReply(0), toolCalls: [{ id: 'c0', name: 'Read', args: JSON.stringify({ file_path: 'reins-no-such-file.txt' }), extra: { vendor_note: 'SIG-TOOL' } }] });

  it('a switch to another provider of the same protocol sends none of them, and a switch back restores them', async () => {
    const { r, other } = await twoProviders();
    r.push(callWithExtra(), wire === 'openai-chat' ? withMessageExtra('SIG-MSG') : { text: 'done' });
    const a = await r.open();
    await a.turn('one');
    expect(JSON.stringify(r.fake.requests.at(-1)!.body.messages)).toContain('SIG-TOOL'); // within A's own turn they go back
    const sid = a.sessionId;
    await a.close();

    r.push({ text: 'from the other' });
    const b = await other.open({ sessionId: sid, policy, costBase: 0 });
    await b.turn('two');
    expect(lastBody(r)).not.toContain('SIG-TOOL');
    expect(lastBody(r)).not.toContain('SIG-MSG');
    await b.close();

    r.push({ text: 'back on A' });
    const back = await r.open({ sessionId: sid, costBase: 0 });
    await back.turn('three');
    // The file kept them: the provider that wrote them gets them again (decision: dropped for the other provider at read, never deleted).
    expect(lastBody(r)).toContain('SIG-TOOL');
    if (wire === 'openai-chat') expect(lastBody(r)).toContain('SIG-MSG');
  });

  it('every assistant line records which provider wrote it', async () => {
    const { r, other } = await twoProviders();
    r.push({ text: 'one' });
    const a = await r.open();
    await a.turn('go');
    const sid = a.sessionId;
    await a.close();
    r.push({ text: 'two' });
    const b = await other.open({ sessionId: sid, policy, costBase: 0 });
    await b.turn('again');
    await b.close();
    const file = path.join(r.host.home, 'conversations', `${sid}.jsonl`);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { role?: string; provider?: string });
    expect(lines.filter((l) => l.role === 'assistant').map((l) => l.provider)).toEqual(['p', 'q']);
  });

  it('a line with no provider recorded (an older file) keeps none of its private extras: who wrote them cannot be shown', async () => {
    const { r } = await twoProviders();
    r.push(callWithExtra(), { text: 'done' });
    const a = await r.open();
    await a.turn('one');
    const sid = a.sessionId;
    await a.close();
    const file = path.join(r.host.home, 'conversations', `${sid}.jsonl`);
    const old = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { const o = JSON.parse(l); delete o.provider; return JSON.stringify(o); }).join('\n') + '\n';
    fs.writeFileSync(file, old);
    r.push({ text: 'again' });
    const again = await r.open({ sessionId: sid, costBase: 0 });
    await again.turn('two');
    expect(lastBody(r)).not.toContain('SIG-TOOL');
    expect(lastBody(r)).toContain('reins-no-such-file.txt'); // the call itself is still in the history
  });

  it('D7: a legacy line (no provider recorded) never reaches another provider either: its private tool-call field stays out of the request', async () => {
    const { r, other } = await twoProviders();
    r.push(callWithExtra(), wire === 'openai-chat' ? withMessageExtra('SIG-MSG') : { text: 'done' });
    const a = await r.open();
    await a.turn('one');
    const sid = a.sessionId;
    await a.close();
    const file = path.join(r.host.home, 'conversations', `${sid}.jsonl`);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { const o = JSON.parse(l); delete o.provider; return JSON.stringify(o); }).join('\n') + '\n');
    r.push({ text: 'from the other' });
    const b = await other.open({ sessionId: sid, policy, costBase: 0 });
    await b.turn('two');
    expect(lastBody(r)).not.toContain('SIG-TOOL');
    expect(lastBody(r)).not.toContain('SIG-MSG');
    await b.close();
  });
});
