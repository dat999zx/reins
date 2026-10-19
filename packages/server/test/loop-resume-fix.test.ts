// Task 14 fix round: accounting that cannot be trusted, the save-failure signal, the lock, ids, the retry that changes the request, the
// permissions of an existing path, and the test gaps the review named.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent } from '@reins/core';
import { loopEngine } from '../src/loop/engine.js';
import { BUSY, COST_MAX, COUNTER_MAX, openConversation, type StoreFs } from '../src/loop/store.js';
import { openSession } from '../src/session.js';
import { openStore } from '../src/store.js';
import { COST_120, KEY, MISSING_RESULT, USAGE_120, WIRES, rig, toolReply, types, type Rig } from './loop-harness.js';

const rigs: Rig[] = [];
const dirs: string[] = [];
const make = async (...a: Parameters<typeof rig>) => {
  const r = await rig(...a);
  rigs.push(r);
  return r;
};
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-fix-')));
  dirs.push(d);
  return d;
};
const call = (id: string, name: string, args: unknown) => ({ id, name, args: typeof args === 'string' ? args : JSON.stringify(args) });
const u = (t: string) => ({ t: 'msg', role: 'user', blocks: [{ type: 'text', text: t }] });
const USE = (cost?: unknown, more: object = {}) => ({ model: 'm', input: 60, output: 20, cacheRead: 30, cacheWrite: 10, ...(cost !== undefined ? { cost } : {}), ...more });
const a = (t: string, usage?: object, protocol = 'openai-chat') => ({ t: 'msg', role: 'assistant', protocol, blocks: [{ type: 'text', text: t }], ...(usage ? { usage } : {}) });
const put = (home: string, id: string, lines: Array<object | string | Buffer>, end = true) => {
  fs.mkdirSync(path.join(home, 'conversations'), { recursive: true });
  const chunks = lines.map((l) => (Buffer.isBuffer(l) ? l : Buffer.from(typeof l === 'string' ? l : JSON.stringify(l))));
  const out: Buffer[] = [];
  chunks.forEach((c, i) => { out.push(c); if (i < chunks.length - 1 || end) out.push(Buffer.from('\n')); });
  fs.writeFileSync(path.join(home, 'conversations', `${id}.jsonl`), Buffer.concat(out));
};
const load = (home: string, id: string) => openConversation(home, id).load('openai-chat');
const saveHooks = (ev: EngineEvent[]) => ev.filter((e) => e.type === 'hook' && e.event === 'conversation-save');

describe('accounting that is missing or damaged makes the total UNKNOWN (never zero, never smaller)', () => {
  it('complete replies sum, in the new format (usage inside the assistant line)', () => {
    const home = tmp();
    const id = randomUUID();
    put(home, id, [u('q1'), a('a1', USE(0.5)), u('q2'), a('a2', USE(0.25))]);
    const l = load(home, id);
    expect(l.total).toBe(0.75);
    expect(l.totals).toEqual({ m: 0.75 });
    expect(l.skipped).toBe(0);
  });

  it('a crash between the user line and the assistant line (a user line last) is fine: the sum of complete replies', () => {
    const home = tmp();
    const id = randomUUID();
    put(home, id, [u('q1'), a('a1', USE(0.5)), u('q2 and the reply never came')]);
    expect(load(home, id).total).toBe(0.5);
  });

  it('a torn last assistant line: the total is unknown', () => {
    const home = tmp();
    const id = randomUUID();
    const torn = JSON.stringify(a('a2', USE(0.25))).slice(0, 60);
    put(home, id, [u('q1'), a('a1', USE(0.5)), u('q2'), torn], false);
    const l = load(home, id);
    expect(l.skipped).toBe(1);
    expect(l.total).toBeUndefined();
    expect(l.totals).toEqual({});
  });

  it('an assistant line with no usage: unknown', () => {
    const home = tmp();
    const id = randomUUID();
    put(home, id, [u('q1'), a('a1', USE(0.5)), u('q2'), a('a2')]);
    const l = load(home, id);
    expect(l.total).toBeUndefined();
    expect(l.totals).toEqual({});
    expect(l.skipped).toBe(0);
  });

  it('a usage with no cost (an unpriced call): unknown, and that model is left out', () => {
    const home = tmp();
    const id = randomUUID();
    put(home, id, [u('q'), a('a1', USE(0.5)), a('a2', USE(undefined, { model: 'n' }))]);
    const l = load(home, id);
    expect(l.total).toBeUndefined();
    expect(l.totals).toEqual({ m: 0.5 });
  });

  it('any skipped line (damaged, an unknown `t`) makes it unknown: a paid reply may have been in it', () => {
    for (const bad of ['{"t":"mystery"}', 'not json', '{"t":"msg","role":"assistant","blocks":[{"type":"image"}]}']) {
      const home = tmp();
      const id = randomUUID();
      put(home, id, [u('q'), a('a1', USE(0.5)), bad]);
      const l = load(home, id);
      expect(l.skipped, bad).toBe(1);
      expect(l.total, bad).toBeUndefined();
    }
  });

  it('the old format (usage lines of their own, hand-made or from an older file) still sums', () => {
    const home = tmp();
    const id = randomUUID();
    const line = (cost: number) => ({ t: 'usage', ...USE(cost) });
    put(home, id, [u('q1'), a('a1'), line(0.5), u('q2'), a('a2'), line(0.25)]);
    const l = load(home, id);
    expect(l.total).toBe(0.75);
    expect(l.totals).toEqual({ m: 0.75 });
    // But a reply that has neither is not covered by the other's line.
    put(home, id, [u('q1'), a('a1'), a('a2'), line(0.5)]);
    expect(load(home, id).total).toBeUndefined();
  });

  it('what a summary boundary drops still counts, and a dropped reply without usage still makes it unknown', () => {
    const home = tmp();
    const id = randomUUID();
    const summary = { t: 'msg', role: 'user', blocks: [{ type: 'summary', text: 'S' }] };
    put(home, id, [u('old'), a('old a', USE(1)), summary, u('new'), a('new a', USE(2))]);
    const l = load(home, id);
    expect(l.msgs).toHaveLength(3);
    expect(l.total).toBe(3);
    put(home, id, [u('old'), a('old a'), summary, u('new'), a('new a', USE(2))]);
    expect(load(home, id).total).toBeUndefined();
  });

  it('the engine writes the usage inside the assistant line and none of its own', async () => {
    const r = await make('openai-chat');
    r.push({ text: 'a', usage: USAGE_120['openai-chat'] });
    const s = await r.open();
    await s.turn('q');
    await s.close();
    const lines = fs.readFileSync(path.join(r.host.home, 'conversations', `${s.sessionId}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.map((l) => l.t)).toEqual(['msg', 'msg']);
    expect(lines[1].usage.cost).toBeCloseTo(COST_120, 12);
    expect(load(r.host.home, s.sessionId).total).toBeCloseTo(COST_120, 12);
  });
});

describe('accounting is validated: counters 0..1e12 whole, cost 0..1e6 (a bound, not a price)', () => {
  const BAD: Array<[string, object]> = [
    ['a negative cost', USE(-100)],
    ['a huge cost', USE(1e308)],
    ['a cost over the bound', USE(COST_MAX + 1)],
    ['a string cost', USE('0.5')],
    ['a NaN-like string cost', USE('NaN')],
    ['an Infinity-like string cost', USE('Infinity')],
    ['a null cost', USE(null)],
    ['negative tokens', USE(0.5, { input: -1 })],
    ['a fractional token count', USE(0.5, { output: 1.5 })],
    ['tokens over the bound', USE(0.5, { cacheRead: COUNTER_MAX + 1 })],
    ['string tokens', USE(0.5, { cacheWrite: '10' })],
    ['negative reasoning tokens', USE(0.5, { reasoning: -2 })],
    ['no model', { ...USE(0.5), model: undefined }],
  ];

  it.each(BAD)('%s: a damaged line, the total unknown, never negative or infinite, and nothing throws', (_name, usage) => {
    const home = tmp();
    const id = randomUUID();
    put(home, id, [u('q'), a('a1', USE(0.5)), a('a2', usage)]);
    const l = load(home, id);
    expect(l.skipped).toBe(1);
    expect(l.total).toBeUndefined();
    expect(l.totals).toEqual({});
  });

  it('two valid costs of 1e6 add up; the bound is the top of the range', () => {
    const home = tmp();
    const id = randomUUID();
    put(home, id, [u('q'), a('a1', USE(COST_MAX)), a('a2', USE(COST_MAX)), a('a3', USE(0, { input: COUNTER_MAX }))]);
    expect(load(home, id).total).toBe(2 * COST_MAX);
  });

  it('the same bounds hold for the old usage lines', () => {
    const home = tmp();
    const id = randomUUID();
    put(home, id, [u('q'), a('a1'), { t: 'usage', ...USE(-100) }, a('a2'), { t: 'usage', ...USE(1e308) }, { t: 'usage', ...USE(1e308) }]);
    const l = load(home, id);
    expect(l.skipped).toBe(3);
    expect(l.total).toBeUndefined();
  });
});

describe('a save that fails is a `hook` event, and the session keeps its engine (session.ts treats `error` as fatal)', () => {
  const failing: StoreFs = { ...fs, appendFileSync: (() => { throw new Error('ENOSPC: no space left on device'); }) as typeof fs.appendFileSync };

  it('through the real session code: the engine stays open, its session id is stored after the reply, and the next message goes on', async () => {
    const r = await make('openai-chat', { deps: { convFs: failing } });
    r.push({ text: 'first reply' }, { text: 'second reply' });
    const store = openStore(':memory:');
    const row = store.createSession({ id: 's1', cwd: tmp(), engine: 'p' });
    let opened = 0;
    const s = openSession({
      store, dir: r.host.home,
      makeEngine: ({ onApprove, onLive }) => {
        opened++;
        return loopEngine(r.p, r.wire, { ...r.host, onApprove, onLive }, { sleep: async () => {}, random: () => 0, convFs: failing });
      },
    }, row, true);
    try {
      s.message('hi');
      await s.idle();
      const log = () => store.readLog('s1');
      expect(log().some((x) => x.type === 'turn_ended')).toBe(true);
      expect(log().filter((x) => x.type === 'note' && JSON.stringify(x.data).includes('dropped'))).toEqual([]);
      expect(store.getSession('s1')!.engineSessionId).toMatch(/^[0-9a-f-]{36}$/);
      s.message('again');
      await s.idle();
      expect(r.fake.requests).toHaveLength(2);
      expect(opened).toBe(1);
      expect(JSON.stringify(r.fake.requests[1]!.body.messages)).toContain('first reply');
      // The session logs the hook event as a row the UI keeps silent (app rows/hidden.ts lists `hook`); it does nothing else with it.
      const rows = log().filter((x) => JSON.stringify(x.data).includes('conversation-save'));
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).toContain('"type":"hook"');
    } finally {
      store.close();
    }
  });

  it('the event is a hook with the reason redacted, once, and never an error', async () => {
    const r = await make('openai-chat', { deps: { convFs: failing } });
    r.push({ text: 'one' }, { text: 'two' });
    const s = await r.open();
    const first = await s.turn('hi');
    expect(types(first.events)).not.toContain('error');
    expect(saveHooks(first.events!)).toEqual([{ type: 'hook', event: 'conversation-save', decision: 'failed', reason: 'ENOSPC: no space left on device' }]);
    expect(saveHooks((await s.turn('more')).events!)).toEqual([]);
  });
});

describe('one session at a time owns a conversation (a lock file for the life of the session)', () => {
  const lockOf = (r: Rig, id: string) => path.join(r.host.home, 'conversations', `${id}.lock`);
  const hand = (r: Rig) => {
    const id = randomUUID();
    put(r.host.home, id, [u('q'), a('a', USE(0.5))]);
    return id;
  };

  it('a second open of the same id is refused with the words, and works after the first is closed', async () => {
    const r = await make('openai-chat');
    const id = hand(r);
    const first = await r.open({ sessionId: id });
    await expect(r.open({ sessionId: id })).rejects.toThrow('This conversation is open in another Reins session.');
    expect(BUSY).toBe('This conversation is open in another Reins session.');
    await first.close();
    const again = await r.open({ sessionId: id });
    await again.close();
  });

  it('a fresh session takes the lock with its first write, and a resume of it is refused meanwhile', async () => {
    const r = await make('openai-chat');
    r.push({ text: 'ok' });
    const s = await r.open();
    expect(fs.existsSync(path.join(r.host.home, 'conversations'))).toBe(false);
    await s.turn('hi');
    expect(fs.existsSync(lockOf(r, s.sessionId))).toBe(true);
    await expect(r.open({ sessionId: s.sessionId })).rejects.toThrow(BUSY);
    await s.close();
    expect(fs.readdirSync(path.join(r.host.home, 'conversations'))).toEqual([`${s.sessionId}.jsonl`]);
  });

  it('the lock holds {pid, startedAt} and is not left behind after close', async () => {
    const r = await make('openai-chat');
    const id = hand(r);
    const s = await r.open({ sessionId: id });
    expect(JSON.parse(fs.readFileSync(lockOf(r, id), 'utf8'))).toEqual({ pid: process.pid, startedAt: expect.any(Number) });
    await s.close();
    expect(fs.existsSync(lockOf(r, id))).toBe(false);
  });

  it('the lock survives a failed turn', async () => {
    const r = await make('openai-chat');
    const id = hand(r);
    const s = await r.open({ sessionId: id });
    r.push(...Array.from({ length: 4 }, () => ({ status: 500, body: 'boom' })));
    await expect(s.turn('hi')).rejects.toThrow('server error');
    expect(fs.existsSync(lockOf(r, id))).toBe(true);
    await expect(r.open({ sessionId: id })).rejects.toThrow(BUSY);
    await s.close();
  });

  it('a lock of a process that is gone is taken over', async () => {
    const r = await make('openai-chat');
    const id = hand(r);
    fs.writeFileSync(lockOf(r, id), JSON.stringify({ pid: 2147483646, startedAt: 1 }));
    const s = await r.open({ sessionId: id });
    expect(JSON.parse(fs.readFileSync(lockOf(r, id), 'utf8')).pid).toBe(process.pid);
    await s.close();
  });

  it.each(['', 'garbage {{', '{"pid":"x"}', '{"pid":-5}', '[]', 'null'])('a lock file that says nothing usable (%j) is taken over', async (text) => {
    const r = await make('openai-chat');
    const id = hand(r);
    fs.writeFileSync(lockOf(r, id), text);
    await (await r.open({ sessionId: id })).close();
  });

  it('a lock of a process that is alive (another Reins) is refused, and its file is left as it was', async () => {
    const r = await make('openai-chat');
    const id = hand(r);
    const theirs = JSON.stringify({ pid: process.ppid, startedAt: 1 });
    fs.writeFileSync(lockOf(r, id), theirs);
    await expect(r.open({ sessionId: id })).rejects.toThrow(BUSY);
    expect(fs.readFileSync(lockOf(r, id), 'utf8')).toBe(theirs);
  });

  it('a failed load gives the lock back', async () => {
    const r = await make('openai-chat');
    const id = randomUUID();
    await expect(r.open({ sessionId: id })).rejects.toThrow('is gone');
    expect(fs.existsSync(lockOf(r, id))).toBe(false);
  });

  it('with an injected liveness check: alive refuses, dead takes over, and our own pid is stale', () => {
    const home = tmp();
    const id = randomUUID();
    put(home, id, [u('q')]);
    const lockFile = path.join(home, 'conversations', `${id}.lock`);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 4242, startedAt: 1 }));
    expect(() => openConversation(home, id, { alive: () => true }).lock()).toThrow(BUSY);
    const c = openConversation(home, id, { alive: () => false });
    c.lock();
    c.release();
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: 1 }));
    const d = openConversation(home, id, { alive: () => true });
    d.lock();
    d.release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });
});

describe('the unpaired retry sends something different: every tool round as plain text', () => {
  const blocksIn = (body: any): boolean => /"tool_calls"|"role":"tool"|"tool_use"|"tool_result"/.test(JSON.stringify(body.messages));

  it.each(WIRES)('a provider that refuses any request with tool blocks: one retry, with none, the card and the user text kept, on %s', async (wireId) => {
    const r = await make(wireId, { toolBlocksFail: true });
    const cards = ['CARD-NOTE'];
    r.push(toolReply(0), { text: 'recovered' }, { text: 'and on' });
    const s = await r.open({ pendingCards: () => cards.splice(0) });
    const res = await s.turn('USER-WORDS');
    expect(res.text).toBe('recovered');
    expect(res.isError).toBeUndefined();
    // 1: the question (200, a tool call), 2: with the tool round (400), 3: the same history flat (200).
    expect(r.fake.requests).toHaveLength(3);
    expect(blocksIn(r.fake.requests[1]!.body)).toBe(true);
    const flat = r.fake.requests[2]!.body;
    expect(blocksIn(flat)).toBe(false);
    const text = JSON.stringify(flat.messages);
    for (const kept of ['USER-WORDS', 'CARD-NOTE', '[tool call Read', MISSING_RESULT]) expect(text).toContain(kept);
    expect(r.slept).toEqual([]);
    // The session keeps the flat history in memory: the next request carries no tool block either.
    expect((await s.turn('more')).text).toBe('and on');
    expect(blocksIn(r.fake.requests[3]!.body)).toBe(false);
  });

  it('the file is untouched by the repair: it still holds the real tool round', async () => {
    const r = await make('openai-chat', { toolBlocksFail: true });
    r.push(toolReply(0), { text: 'recovered' });
    const s = await r.open();
    await s.turn('go');
    await s.close();
    const raw = fs.readFileSync(path.join(r.host.home, 'conversations', `${s.sessionId}.jsonl`), 'utf8');
    expect(raw).toContain('"type":"tool_call"');
    expect(raw).toContain('"type":"tool_result"');
    expect(raw).not.toContain('[tool call');
  });

  it.each(WIRES)('a second pairing 400: the final error is the body, redacted, after exactly one retry, on %s', async (wireId) => {
    const r = await make(wireId);
    const body = wireId === 'openai-chat'
      ? JSON.stringify({ error: { message: `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. ${KEY}` } })
      : JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `unexpected tool_use_id toolu_1 found in tool_result blocks ${KEY}` } });
    r.push(toolReply(0), { status: 400, body }, { status: 400, body }, { text: 'the next try' });
    const s = await r.open();
    const err = await s.turn('go').catch((e: Error) => e);
    expect((err as Error).message).toContain('[key Reins]');
    expect((err as Error).message).not.toContain(KEY);
    expect(r.fake.requests).toHaveLength(3);
    expect(blocksIn(r.fake.requests[1]!.body)).toBe(true);
    expect(blocksIn(r.fake.requests[2]!.body)).toBe(false);
  });
});

describe('an existing folder or file: ours and private, or not used (POSIX; an injected fs and getuid here)', () => {
  const stat = (o: { uid: number; mode: number; dir?: boolean }) => ({ isSymbolicLink: () => false, isDirectory: () => o.dir === true, isFile: () => o.dir !== true, uid: o.uid, mode: o.mode, size: 0 });
  const rig2 = (folder: { uid: number; mode: number }, file?: { uid: number; mode: number }) => {
    const chmods: Array<[unknown, unknown]> = [];
    const fake: StoreFs = {
      ...fs,
      lstatSync: ((p: string) => {
        if (String(p).endsWith('conversations')) return stat({ ...folder, dir: true });
        if (file && String(p).endsWith('.jsonl')) return stat(file);
        const e = new Error('ENOENT') as Error & { code: string };
        e.code = 'ENOENT';
        throw e;
      }) as unknown as typeof fs.lstatSync,
      mkdirSync: (() => undefined) as unknown as typeof fs.mkdirSync,
      openSync: (() => 99) as unknown as typeof fs.openSync,
      appendFileSync: (() => undefined) as typeof fs.appendFileSync,
      closeSync: (() => undefined) as typeof fs.closeSync,
      chmodSync: ((p: unknown, m: unknown) => void chmods.push([p, m])) as typeof fs.chmodSync,
    };
    return { fake, chmods };
  };
  const msg = { role: 'user' as const, blocks: [{ type: 'text' as const, text: 'x' }] };
  const id = 'abcdefgh-1234';

  it('a folder owned by another user is refused', () => {
    const { fake } = rig2({ uid: 1001, mode: 0o40700 });
    expect(() => openConversation('/h', id, { fs: fake, getuid: () => 1000 }).appendMsg(msg, 'p')).toThrow('The conversation folder belongs to another user, so Reins will not use it.');
  });

  it('a file owned by another user is refused', () => {
    const { fake } = rig2({ uid: 1000, mode: 0o40700 }, { uid: 1001, mode: 0o100600 });
    expect(() => openConversation('/h', id, { fs: fake, getuid: () => 1000 }).appendMsg(msg, 'p')).toThrow('The conversation file belongs to another user, so Reins will not use it.');
  });

  it('ours and wider than 0700 / 0600: tightened before use', () => {
    const { fake, chmods } = rig2({ uid: 1000, mode: 0o40755 }, { uid: 1000, mode: 0o100644 });
    openConversation('/h', id, { fs: fake, getuid: () => 1000 }).appendMsg(msg, 'p');
    expect(chmods.map(([, m]) => m)).toEqual([0o700, 0o600]);
    expect(String(chmods[0]![0])).toMatch(/conversations$/);
    expect(String(chmods[1]![0])).toMatch(/\.jsonl$/);
  });

  it('ours and private already: no chmod', () => {
    const { fake, chmods } = rig2({ uid: 1000, mode: 0o40700 }, { uid: 1000, mode: 0o100600 });
    openConversation('/h', id, { fs: fake, getuid: () => 1000 }).appendMsg(msg, 'p');
    expect(chmods).toEqual([]);
  });

  it('where there is no user id (Windows) nothing is checked or changed', () => {
    const { fake, chmods } = rig2({ uid: 1001, mode: 0o40777 }, { uid: 1001, mode: 0o100666 });
    openConversation('/h', id, { fs: fake, getuid: () => undefined }).appendMsg(msg, 'p');
    expect(chmods).toEqual([]);
  });

  it('a file owned by another user is refused on load too', () => {
    const { fake } = rig2({ uid: 1000, mode: 0o40700 }, { uid: 1001, mode: 0o100600 });
    expect(() => openConversation('/h', id, { fs: fake, getuid: () => 1000 }).load('p')).toThrow(/belongs to another user/);
  });
});

describe('what a file may start with and hold', () => {
  it('one leading UTF-8 byte order mark is not part of the first line', () => {
    const home = tmp();
    const id = randomUUID();
    put(home, id, [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(u('first')))]), a('second', USE(0.5))]);
    const l = load(home, id);
    expect(l.skipped).toBe(0);
    expect(l.msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(l.total).toBe(0.5);
  });

  it('a second byte order mark is not stripped: that line is damaged', () => {
    const home = tmp();
    const id = randomUUID();
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    put(home, id, [Buffer.concat([bom, bom, Buffer.from(JSON.stringify(u('first')))]), a('second', USE(0.5))]);
    expect(load(home, id).skipped).toBe(1);
  });

  it('a line that is not UTF-8 is a damaged line, not a line with replacement characters', () => {
    const home = tmp();
    const id = randomUUID();
    const bad = Buffer.concat([Buffer.from('{"t":"msg","role":"user","blocks":[{"type":"text","text":"a'), Buffer.from([0xff, 0xfe]), Buffer.from('b"}]}')]);
    put(home, id, [u('q'), a('a1', USE(0.5)), bad, u('after')]);
    const l = load(home, id);
    expect(l.skipped).toBe(1);
    expect(JSON.stringify(l.msgs)).not.toContain('�');
    expect(l.msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(l.total).toBeUndefined();
  });

  it('a multi-byte character that is whole stays whole', () => {
    const home = tmp();
    const id = randomUUID();
    put(home, id, [u('héllo \u{1F600} 日本'), a('ok', USE(0.5))]);
    expect(JSON.stringify(load(home, id).msgs[0])).toContain('héllo \u{1F600} 日本');
  });
});

describe('the test gaps of the review', () => {
  it('a key that is an OBJECT KEY in a tool call\'s arguments is hidden, and the line is written', async () => {
    const r = await make('openai-chat');
    r.push({ toolCalls: [call('k1', 'Read', { [KEY]: 'x', file_path: 'nothing.txt' })] }, { text: 'ok' });
    const s = await r.open();
    await s.turn('go');
    const file = path.join(r.host.home, 'conversations', `${s.sessionId}.jsonl`);
    const bytes = fs.readFileSync(file, 'latin1');
    expect(bytes).toContain('"[key Reins]":"x"');
    expect(bytes).not.toContain(KEY.slice(0, 8));
    expect(saveHooks(r.live)).toEqual([]);
  });

  it('a thinking block\'s extra and a resumed tool result\'s isError come back', () => {
    const home = tmp();
    const id = randomUUID();
    put(home, id, [
      u('q'),
      { t: 'msg', role: 'assistant', protocol: 'openai-chat', usage: USE(0.5), blocks: [{ type: 'reasoning', text: 'T', signature: 'S', extra: { redacted: true } }, { type: 'tool_call', id: 'c', name: 'R', args: {} }] },
      { t: 'msg', role: 'user', blocks: [{ type: 'tool_result', id: 'c', content: 'bad', isError: true }] },
    ]);
    const m = load(home, id).msgs;
    expect(m[1]!.blocks[0]).toEqual({ type: 'thinking', text: 'T', signature: 'S', extra: { redacted: true } });
    expect(m[2]!.blocks[0]).toEqual({ type: 'tool_result', id: 'c', content: 'bad', isError: true });
  });

  it.each(WIRES)('the history is sanitized before every request: a broken provider\'s repeated id in one reply reaches the strict fake once, on %s', async (wireId) => {
    const r = await make(wireId, { strictPairs: true });
    r.push({ toolCalls: [call('a', 'Read', { file_path: 'x1' }), call('a', 'Read', { file_path: 'x2' })] }, { text: 'done' });
    const res = await (await r.open()).turn('go');
    expect(res.text).toBe('done');
    // No 400 and no retry: the request after the tools was already clean.
    expect(r.fake.requests).toHaveLength(2);
  });
});
