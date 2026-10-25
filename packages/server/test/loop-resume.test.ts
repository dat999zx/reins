// Task 14: the conversation file, resume, and the tool-call pair rules around them (spec 4.6, 4.9 `unpaired`, 4.12, 8.3).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent, EngineSession, Policy } from '@reins/core';
import { loopEngine } from '../src/loop/engine.js';
import { INTERRUPTED, pairUp } from '../src/loop/pairs.js';
import { HOME_WORDS } from '../src/loop/paths.js';
import { isUnpaired } from '../src/loop/retry.js';
import { HOME_NAMED_WORDS } from '../src/loop/shell.js';
import { APPEND_FLAGS, APPEND_MODE, BAD_ID, MAX_FILE, openConversation, type StoreFs } from '../src/loop/store.js';
import { shellToolName } from '../src/loop/tools.js';
import { openStore, type Store } from '../src/store.js';
import { startServer } from '../src/server.js';
import { until } from './helpers.js';
import { cleanup, PROBE, request, rowsOf, tmpDir } from './http-helpers.js';
import { COST_120, KEY, MISSING, PRICE, USAGE_120, WIRES, rig, toolReply, toolResults, types, type Rig, type WireId } from './loop-harness.js';

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
  await cleanup();
});
const tmp = () => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-resume-')));
  dirs.push(d);
  return d;
};

const WRITE_MODE: Policy = { mode: 'write', guards: [], allowShell: true };
const skip = (t: { skip: (m: string) => void }, why: string) => t.skip(`SKIPPED: ${why}`);
const folder = (r: Rig) => path.join(r.host.home, 'conversations');
const fileOf = (r: Rig, id: string) => path.join(folder(r), `${id}.jsonl`);
const raw = (r: Rig, id: string) => fs.readFileSync(fileOf(r, id), 'utf8');
const parsed = (r: Rig, id: string): any[] => raw(r, id).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const shape = (lines: any[]) => lines.map((l) => (l.t === 'msg' ? `${l.t}:${l.role}` : l.t));
const call = (id: string, name: string, args: unknown) => ({ id, name, args: typeof args === 'string' ? args : JSON.stringify(args) });
const calls = (...c: ReturnType<typeof call>[]) => ({ toolCalls: c });
/** The events that say a save failed (they are `hook` events, never `error`: the session drops an engine that reports an error). */
const saveHooks = (ev: EngineEvent[]) => ev.filter((e) => e.type === 'hook' && e.event === 'conversation-save');

// A file written by hand, as a crash, an old version or a person could leave it.
const L = {
  u: (t: string) => ({ t: 'msg', role: 'user', blocks: [{ type: 'text', text: t }] }),
  a: (t: string, protocol = 'openai-chat', more: object[] = [], extra?: object) => ({ t: 'msg', role: 'assistant', protocol, blocks: [{ type: 'text', text: t }, ...more], ...(extra ? { extra } : {}) }),
  call: (id: string, name = 'Read', args: unknown = { file_path: 'x' }) => ({ type: 'tool_call', id, name, args }),
  res: (id: string, content = `r-${id}`) => ({ type: 'tool_result', id, content }),
  results: (...blocks: object[]) => ({ t: 'msg', role: 'user', blocks }),
  summary: (text: string) => ({ t: 'msg', role: 'user', blocks: [{ type: 'summary', text }] }),
  usage: (model = 'm', cost?: number) => ({ t: 'usage', model, input: 60, output: 20, cacheRead: 30, cacheWrite: 10, ...(cost !== undefined ? { cost } : {}) }),
};
const put = (home: string, id: string, lines: Array<object | string>, end = true) => {
  fs.mkdirSync(path.join(home, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(home, 'conversations', `${id}.jsonl`), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + (end ? '\n' : ''));
};
const sse = (type: string, o: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;

describe('resume: the history and the money continue (spec 4.6)', () => {
  it.each(WIRES)('two turns, close, open with the same sessionId: the next request holds both turns and the total continues, on %s', async (wireId) => {
    const r = await make(wireId);
    const usage = USAGE_120[wireId];
    r.push({ text: 'answer one', usage }, { text: 'answer two', usage });
    const s = await r.open();
    await s.turn('question one');
    const second = await s.turn('question two');
    await s.close();
    expect(second.total).toBeCloseTo(2 * COST_120, 12);

    r.push({ text: 'answer three', usage });
    const again = await r.open({ sessionId: s.sessionId });
    expect(again.sessionId).toBe(s.sessionId);
    const res = await again.turn('question three');
    const sent = JSON.stringify(r.fake.requests.at(-1)!.body.messages);
    for (const t of ['question one', 'answer one', 'question two', 'answer two', 'question three']) expect(sent).toContain(t);
    expect(res.cost).toBeCloseTo(COST_120, 12);
    expect(res.total).toBeCloseTo(3 * COST_120, 12);
    expect(res.totals!.m).toBeCloseTo(3 * COST_120, 12);
    expect(res.models!.m).toBeCloseTo(COST_120, 12);
  });

  it('the file holds one line per message and per call, in the order they happened, with the protocol on assistant lines', async () => {
    const r = await make('openai-chat');
    r.push({ ...toolReply(0), usage: USAGE_120['openai-chat'] }, { text: 'done', usage: USAGE_120['openai-chat'] });
    const s = await r.open();
    await s.turn('go');
    const lines = parsed(r, s.sessionId);
    // The spend of a reply is inside its line: no line of its own.
    expect(shape(lines)).toEqual(['msg:user', 'msg:assistant', 'msg:user', 'msg:assistant']);
    expect(lines[0]).toEqual({ t: 'msg', role: 'user', blocks: [{ type: 'text', text: 'go' }] });
    expect(lines[1]).toMatchObject({ protocol: 'openai-chat', blocks: [{ type: 'tool_call', id: 'c0', name: 'Read', args: { file_path: MISSING } }] });
    expect(lines[1].usage).toEqual({ model: 'm', input: 60, output: 20, cacheRead: 30, cacheWrite: 10, reasoning: 0, cost: expect.any(Number) });
    expect(lines[1].usage.cost).toBeCloseTo(COST_120, 12);
    expect(lines[2].blocks[0]).toEqual({ type: 'tool_result', id: 'c0', content: expect.stringContaining('File not found'), isError: true });
    expect(lines[2].protocol).toBeUndefined();
    expect(lines[2].usage).toBeUndefined();
  });

  it('a fresh session writes no file until its first reply arrives', async () => {
    const r = await make('openai-chat');
    const s = await r.open();
    expect(fs.existsSync(folder(r))).toBe(false);
    r.push(...Array.from({ length: 4 }, () => ({ status: 500, body: 'boom' })));
    await expect(s.turn('hi')).rejects.toThrow('server error');
    expect(fs.existsSync(folder(r))).toBe(false);
  });

  it('the store\'s costBase and the file\'s sums are the same number in the normal case', async () => {
    const r = await make('openai-chat');
    const usage = USAGE_120['openai-chat'];
    r.push({ text: 'a', usage }, { text: 'b', usage });
    const s = await r.open();
    await s.turn('one');
    const res = await s.turn('two');
    await s.close();
    const file = openConversation(r.host.home, s.sessionId).load('openai-chat');
    expect(file.total).toBe(res.total);
    expect(file.totals).toEqual(res.totals);
    // Opened with the store's number, the reply continues from it: the same as from the file.
    r.push({ text: 'c', usage });
    const next = await (await r.open({ sessionId: s.sessionId, costBase: res.total!, costBaseByModel: res.totals! })).turn('three');
    expect(next.total).toBe(res.total! + next.cost!);
    expect(next.totals!.m).toBe(res.totals!.m! + next.cost!);
  });

  it('a costBase that differs from the file wins and nothing throws', async () => {
    const r = await make('openai-chat');
    const usage = USAGE_120['openai-chat'];
    r.push({ text: 'a', usage }, { text: 'b', usage });
    const s = await r.open();
    await s.turn('one');
    await s.close();
    const res = await (await r.open({ sessionId: s.sessionId, costBase: 5, costBaseByModel: { m: 5 } })).turn('two');
    expect(res.total).toBeCloseTo(5 + COST_120, 12);
    expect(res.totals!.m).toBeCloseTo(5 + COST_120, 12);
  });

  it('without a costBase the file\'s sums are the start, and an unpriced call stays unknown after a reload', async () => {
    const r = await make('openai-chat', { manifest: { models: [{ id: 'm', context: 1000 }] } });
    r.push({ text: 'a', usage: USAGE_120['openai-chat'] }, { text: 'b', usage: USAGE_120['openai-chat'] });
    const s = await r.open();
    expect((await s.turn('one')).total).toBeUndefined();
    expect(parsed(r, s.sessionId)[1].usage).not.toHaveProperty('cost');
    await s.close();
    const loaded = openConversation(r.host.home, s.sessionId).load('openai-chat');
    expect(loaded.total).toBeUndefined();
    expect(loaded.totals).toEqual({});
    const res = await (await r.open({ sessionId: s.sessionId })).turn('two');
    expect(res.total).toBeUndefined();
    expect(res.cost).toBeUndefined();
  });

  it('by hand: a model with one unpriced line is left out of totals; the total is unknown; nothing is counted as 0', () => {
    const home = tmp();
    const id = randomUUID();
    put(home, id, [L.u('q'), L.a('a'), L.usage('m', 0.5), L.usage('m', 0.25), L.usage('n', 1), L.usage('n')]);
    const loaded = openConversation(home, id).load('openai-chat');
    expect(loaded.total).toBeUndefined();
    expect(loaded.totals).toEqual({ m: 0.75 });
    put(home, id, [L.u('q'), L.a('a'), L.usage('m', 0.5), L.usage('n', 1)]);
    const priced = openConversation(home, id).load('openai-chat');
    expect(priced.total).toBe(1.5);
    expect(priced.totals).toEqual({ m: 0.5, n: 1 });
  });
});

describe('the session id and the place of the file (spec 4.6)', () => {
  const BAD = ['../x', 'a/b', '', 'x'.repeat(65), 'abcdefgh\0', 'con', 'PROGRA~1', '..\\..\\x1234567', 'abcdefg', 'abcdefgh\n', 'ABCDEFGH', 'abcdefgH', randomUUID().toUpperCase(), 'abcd efgh', 'abcdefgh.jsonl', '..', 'C:\\x1234567', 'ab\u00e9defghij'];

  it.each(BAD)('%j is refused before any fs access', (id) => {
    const used: string[] = [];
    const spy = new Proxy(fs, { get: (t, k) => (typeof (t as any)[k] === 'function' ? (...a: unknown[]) => { used.push(String(k)); return (t as any)[k](...a); } : (t as any)[k]) }) as unknown as StoreFs;
    expect(() => openConversation(os.tmpdir(), id, { fs: spy })).toThrow(BAD_ID);
    expect(used).toEqual([]);
    expect(BAD_ID).toBe('That session id is not one Reins made.');
  });

  it('a UUID and the other plain ids pass', () => {
    for (const id of [randomUUID(), 'abcdefgh', 'a_b-c_d-e', 'a'.repeat(64)]) expect(openConversation(os.tmpdir(), id).path).toBe(path.join(os.tmpdir(), 'conversations', `${id}.jsonl`));
  });

  it('the engine refuses a bad id when it opens, and makes no folder', async () => {
    const r = await make('openai-chat');
    for (const id of ['../x', 'a/b', '', 'x'.repeat(65), 'con']) await expect(r.open({ sessionId: id })).rejects.toThrow(BAD_ID);
    expect(fs.existsSync(folder(r))).toBe(false);
  });

  it('a missing file with a sessionId says so, with the path', async () => {
    const r = await make('openai-chat');
    const id = randomUUID();
    await expect(r.open({ sessionId: id })).rejects.toThrow(`The conversation of this session is gone (${fileOf(r, id)}); start a new session.`);
    // The lock is taken before the read and given back: nothing is left in the folder.
    expect(fs.readdirSync(folder(r))).toEqual([]);
  });

  it('a symlinked folder is refused to read and to write, and the link\'s target gets nothing', async (t) => {
    const r = await make('openai-chat');
    const target = tmp();
    try {
      fs.symlinkSync(target, folder(r), 'junction');
    } catch (e) {
      return skip(t, `links cannot be made here (${(e as { code?: string }).code})`);
    }
    await expect(r.open({ sessionId: randomUUID() })).rejects.toThrow(/folder is a link/);
    r.push({ text: 'ok' });
    const res = await (await r.open()).turn('hi');
    expect(res.text).toBe('ok');
    expect(saveHooks(res.events!)).toEqual([{ type: 'hook', event: 'conversation-save', decision: 'failed', reason: expect.stringContaining('The conversation folder is a link') }]);
    expect(types(res.events)).not.toContain('error');
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('a symlinked file is refused to read and to write, and the link\'s target is not touched', (t) => {
    const home = tmp();
    const id = randomUUID();
    const target = path.join(tmp(), 'real.jsonl');
    fs.writeFileSync(target, `${JSON.stringify(L.u('q'))}\n`);
    fs.mkdirSync(path.join(home, 'conversations'));
    try {
      fs.symlinkSync(target, path.join(home, 'conversations', `${id}.jsonl`), 'file');
    } catch (e) {
      return skip(t, `file links cannot be made here (${(e as { code?: string }).code}); the folder link is tested above`);
    }
    const c = openConversation(home, id);
    expect(() => c.load('openai-chat')).toThrow(/file is a link/);
    expect(() => c.appendMsg({ role: 'user', blocks: [{ type: 'text', text: 'x' }] }, 'p')).toThrow(/file is a link/);
    expect(fs.readFileSync(target, 'utf8')).toBe(`${JSON.stringify(L.u('q'))}\n`);
  });

  it('the folder is made 0700 and the file opened 0600, append-only, never following a link: the flags it passes', async () => {
    const opened: Array<{ path: unknown; flags: unknown; mode: unknown }> = [];
    const made: unknown[][] = [];
    const spy: StoreFs = {
      ...fs,
      mkdirSync: ((...a: unknown[]) => { made.push(a); return (fs.mkdirSync as any)(...a); }) as typeof fs.mkdirSync,
      openSync: ((p: unknown, flags: unknown, mode: unknown) => { opened.push({ path: p, flags, mode }); return (fs.openSync as any)(p, flags, mode); }) as typeof fs.openSync,
    };
    const r = await make('openai-chat', { deps: { convFs: spy } });
    r.push({ text: 'ok' });
    const s = await r.open();
    await s.turn('hi');
    expect(made).toEqual([[folder(r), { recursive: true, mode: 0o700 }]]);
    const ofFile = opened.filter((o) => o.path === fileOf(r, s.sessionId));
    expect(ofFile.length).toBeGreaterThan(0);
    for (const o of ofFile) {
      expect(o.mode).toBe(0o600);
      expect(o.flags).toBe(APPEND_FLAGS);
    }
    // The lock file is made exclusively, also 0600.
    const ofLock = opened.filter((o) => String(o.path).endsWith('.lock'));
    expect(ofLock).toHaveLength(1);
    expect(ofLock[0]!.mode).toBe(0o600);
    expect(Number(ofLock[0]!.flags) & fs.constants.O_EXCL).toBe(fs.constants.O_EXCL);
    expect(opened).toHaveLength(ofFile.length + 1);
    expect(APPEND_MODE).toBe(0o600);
    expect(APPEND_FLAGS & fs.constants.O_APPEND).toBe(fs.constants.O_APPEND);
    expect(APPEND_FLAGS & fs.constants.O_CREAT).toBe(fs.constants.O_CREAT);
    if (fs.constants.O_NOFOLLOW) expect(APPEND_FLAGS & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
  });

  it('on POSIX the folder is 0700 and the file 0600 on disk', async (t) => {
    if (process.platform === 'win32') return skip(t, 'Windows has no POSIX modes; the flags are asserted in the test above');
    const r = await make('openai-chat');
    r.push({ text: 'ok' });
    const s = await r.open();
    await s.turn('hi');
    expect(fs.statSync(folder(r)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(fileOf(r, s.sessionId)).mode & 0o777).toBe(0o600);
  });
});

describe('a key never reaches the file (spec 8.3)', () => {
  const cases: Array<{ name: string; run(r: Rig, cwd: string): Promise<EngineSession> }> = [
    { name: 'the model\'s text', run: async (r) => { r.push({ text: `the key is ${KEY} ok` }); const s = await r.open(); await s.turn('hi'); return s; } },
    { name: 'the user\'s text', run: async (r) => { r.push({ text: 'ok' }); const s = await r.open(); await s.turn(`my key is ${KEY}`); return s; } },
    { name: 'a tool call\'s arguments', run: async (r) => { r.push({ toolCalls: [call('k1', 'Read', { file_path: KEY })] }, { text: 'ok' }); const s = await r.open(); await s.turn('go'); return s; } },
    {
      name: 'a tool output',
      run: async (r, cwd) => {
        fs.writeFileSync(path.join(cwd, 'leak.txt'), `token=${KEY}\n`);
        r.push({ toolCalls: [call('k1', 'Read', { file_path: 'leak.txt' })] }, { text: 'ok' });
        const s = await r.open({ cwd, policy: () => WRITE_MODE });
        await s.turn('go');
        return s;
      },
    },
    {
      name: 'a card',
      run: async (r) => {
        const cards = [`card text with ${KEY} in it`];
        r.push(toolReply(0), { text: 'ok' });
        const s = await r.open({ pendingCards: () => cards.splice(0) });
        await s.turn('go');
        return s;
      },
    },
  ];

  it.each(cases)('$name is [key Reins] in the file, and no 8-character start of the key is there', async ({ run }) => {
    const r = await make('openai-chat');
    const cwd = tmp();
    const s = await run(r, cwd);
    const bytes = fs.readFileSync(fileOf(r, s.sessionId)).toString('latin1');
    for (let n = 8; n <= KEY.length; n++) expect(bytes).not.toContain(KEY.slice(0, n));
    expect(bytes).toContain('[key Reins]');
    expect(bytes).not.toContain(KEY.slice(-8));
  });

  it('the history in memory stays raw: the next request goes to the same provider with what was said', async () => {
    const r = await make('openai-chat');
    r.push({ text: 'ok' }, { text: 'again' });
    const s = await r.open();
    await s.turn(`my key is ${KEY}`);
    await s.turn('more');
    expect(JSON.stringify(r.fake.requests.at(-1)!.body.messages)).toContain(KEY);
  });

  it('a line that still holds a known secret is not written: one error, the turn completes, later lines are not tried', async () => {
    const seen: string[] = [];
    const r = await make('openai-chat', { host: { holdsSecret: (t) => (seen.push(t), true) } });
    r.push({ text: 'one' }, { text: 'two' });
    const s = await r.open();
    const first = await s.turn('hi');
    expect(first.text).toBe('one');
    expect(first.isError).toBeUndefined();
    const failed = saveHooks(first.events!);
    expect(failed).toHaveLength(1);
    expect((failed[0] as { reason: string }).reason).toMatch(/key/);
    expect(types(first.events)).not.toContain('error');
    expect(saveHooks(r.live)).toHaveLength(1);
    expect(fs.existsSync(fileOf(r, s.sessionId))).toBe(false);
    const second = await s.turn('again');
    expect(second.text).toBe('two');
    expect(saveHooks(second.events!)).toEqual([]);
    expect(fs.existsSync(fileOf(r, s.sessionId))).toBe(false);
    // The check saw the serialized line, once; after the failure nothing is tried.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^\{"t":"msg"/);
    // Both turns are in the history in memory.
    expect(JSON.stringify(r.fake.requests.at(-1)!.body.messages)).toContain('hi');
  });
});

describe('reading a file back: damage, unknown lines, the size (spec 4.6)', () => {
  const GOOD = [L.u('q1'), L.a('a1'), L.usage('m', 0.5)];

  it('a torn last line is skipped, and the next line is written on a line of its own', async () => {
    const r = await make('openai-chat');
    const id = randomUUID();
    put(r.host.home, id, [...GOOD, '{"t":"msg","role":"user","blocks":[{"type":"te'], false);
    const loaded = openConversation(r.host.home, id).load('openai-chat');
    expect(loaded.skipped).toBe(1);
    expect(loaded.msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    // A line was lost: it may have been a paid reply, so the total is not known.
    expect(loaded.total).toBeUndefined();
    r.push({ text: 'a2' });
    await (await r.open({ sessionId: id })).turn('q2');
    const lines = raw(r, id).split('\n');
    expect(lines[3]).toBe('{"t":"msg","role":"user","blocks":[{"type":"te');
    expect(lines.slice(4).filter(Boolean).map((l) => JSON.parse(l).t)).toEqual(['msg', 'msg']);
    const again = openConversation(r.host.home, id).load('openai-chat');
    expect(again.skipped).toBe(1);
    expect(again.msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('a corrupt middle line is skipped and counted; the lines around it are read', () => {
    const home = tmp();
    const id = randomUUID();
    put(home, id, [L.u('q1'), 'this is not json {{{', L.a('a1'), L.usage('m', 0.5), L.u('q2')]);
    const loaded = openConversation(home, id).load('openai-chat');
    expect(loaded.skipped).toBe(1);
    expect(loaded.msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(loaded.total).toBeUndefined();
  });

  it('an unknown `t`, a line that is not an object, a bad role and a bad block are skipped and counted', () => {
    const home = tmp();
    const id = randomUUID();
    put(home, id, [
      L.u('q1'), { t: 'mystery', x: 1 }, '42', 'null', '[]', '"text"', { t: 'msg', role: 'system', blocks: [] }, { t: 'msg', role: 'user', blocks: 'no' },
      { t: 'msg', role: 'user', blocks: [{ type: 'image', data: 'x' }] }, { t: 'msg', role: 'user', blocks: [{ type: 'text', text: 7 }] },
      { t: 'usage', model: 'm', input: 'x', output: 1, cacheRead: 0, cacheWrite: 0 }, L.a('a1'), '',
    ]);
    const loaded = openConversation(home, id).load('openai-chat');
    expect(loaded.skipped).toBe(10);
    expect(loaded.msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('a file over the size cap is refused with a plain message and is not read', () => {
    const home = tmp();
    const id = randomUUID();
    fs.mkdirSync(path.join(home, 'conversations'));
    const file = path.join(home, 'conversations', `${id}.jsonl`);
    const fd = fs.openSync(file, 'w');
    fs.ftruncateSync(fd, 300 * 1024 * 1024);
    fs.closeSync(fd);
    expect(MAX_FILE).toBe(256 * 1024 * 1024);
    let reads = 0;
    const spy: StoreFs = { ...fs, readSync: ((...a: unknown[]) => (reads++, (fs.readSync as any)(...a))) as typeof fs.readSync };
    expect(() => openConversation(home, id, { fs: spy }).load('openai-chat')).toThrow('The conversation of this session is too big to open (over 256 MiB); start a new session.');
    expect(reads).toBe(0);
  });

  it('a file that is not readable says why, in plain words, redacted', () => {
    const home = tmp();
    const id = randomUUID();
    put(home, id, GOOD);
    const spy: StoreFs = { ...fs, openSync: (() => { throw Object.assign(new Error(`EACCES: denied ${KEY}`), { code: 'EACCES' }); }) as unknown as typeof fs.openSync };
    const hide = (t: string) => t.split(KEY).join('[key Reins]');
    let message = '';
    try {
      openConversation(home, id, { fs: spy, redactAll: hide }).load('openai-chat');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/^Could not read the conversation of this session \(EACCES: denied \[key Reins\]\)\.$/);
  });
});

describe('sanitizing on load and before every request (spec 4.12b, d)', () => {
  const HAND = (): Array<object | string> => [
    L.u('q1'),
    L.results(L.res('ghost')), // an orphan result
    L.a('a1', 'openai-chat', [L.call('orphan')]), // an orphan call
    L.u('q2'),
    L.a('a2', 'openai-chat', [L.call('dup')]), L.results(L.res('dup', 'first')), // a duplicate id
    L.a('a3', 'openai-chat', [L.call('dup')]), L.results(L.res('dup', 'second')),
    L.results(L.res('early')), L.a('a4', 'openai-chat', [L.call('early')]), // a result before its call
    L.usage('m', 0.1),
  ];

  it.each(WIRES)('a hand-written file with every kind of damage opens, is well paired as loaded, and its next request is accepted, on %s', async (wireId) => {
    const r = await make(wireId, { strictPairs: true });
    const id = randomUUID();
    put(r.host.home, id, HAND());
    const loaded = openConversation(r.host.home, id).load(r.p.protocol);
    // Nothing left to repair: the loaded history is its own sanitized form.
    expect(pairUp(loaded.msgs)).toEqual({ msgs: loaded.msgs, stubbed: [] });
    const text = JSON.stringify(loaded.msgs);
    expect(text).not.toContain('ghost');
    // The same id in two rounds is two calls: both outputs stay.
    expect(text).toContain('first');
    expect(text).toContain('second');
    expect(text).toContain(INTERRUPTED);
    r.push({ text: 'accepted' });
    const res = await (await r.open({ sessionId: id })).turn('next');
    expect(res.text).toBe('accepted');
    expect(r.fake.requests).toHaveLength(1);
  });
});

describe('an unpaired 400 is repaired once (spec 4.9)', () => {
  const unpairedBody = (wireId: WireId, tail = '') => JSON.stringify(wireId === 'openai-chat'
    ? { error: { message: `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'.${tail}` } }
    : { type: 'error', error: { type: 'invalid_request_error', message: `unexpected tool_use_id toolu_01 found in tool_result blocks${tail}` } });

  it.each(WIRES)('the fake answers one 400 naming a tool id, then 200: exactly one retry, no wait, the turn succeeds, on %s', async (wireId) => {
    const r = await make(wireId);
    r.push({ status: 400, body: unpairedBody(wireId) }, { text: 'recovered' });
    const res = await (await r.open()).turn('hi');
    expect(res.text).toBe('recovered');
    expect(res.isError).toBeUndefined();
    expect(r.fake.requests).toHaveLength(2);
    expect(r.slept).toEqual([]);
  });

  it.each(WIRES)('twice: the final error is the body, redacted, after exactly two requests, on %s', async (wireId) => {
    const r = await make(wireId);
    r.push({ status: 400, body: unpairedBody(wireId, ` ${KEY}`) }, { status: 400, body: unpairedBody(wireId, ` ${KEY}`) }, { text: 'the next try' });
    const s = await r.open();
    const err = await s.turn('hi').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain(wireId === 'openai-chat' ? "must be followed by tool messages" : 'unexpected tool_use_id toolu_01');
    expect(msg).toContain('[key Reins]');
    expect(msg).not.toContain(KEY);
    expect(msg).not.toContain('refused the request');
    expect(r.fake.requests).toHaveLength(2);
    // The turn got no reply: no trace, the same text goes again.
    expect((await s.turn('hi')).text).toBe('the next try');
  });

  it.each(WIRES)('another 400 (an invalid model) is a plain bad request and is not tried again, on %s', async (wireId) => {
    const r = await make(wireId);
    r.push({ status: 400, body: 'invalid model: nope' }, { text: 'not asked for' });
    await expect((await r.open()).turn('hi')).rejects.toThrow('Fake refused the request (400): invalid model: nope');
    expect(r.fake.requests).toHaveLength(1);
  });

  it('what counts as naming a tool id: both a name and a way of not pairing', () => {
    for (const body of [
      "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'.",
      "messages with role 'tool' must be a response to a preceeding message with 'tool_calls'.",
      '`tool_use` ids were found without `tool_result` blocks immediately after: toolu_01',
      'messages.1.content.0: unexpected `tool_use_id` found in `tool_result` blocks: toolu_01. Each `tool_result` block must have a corresponding `tool_use` block in the previous message.',
      'tool_call_id c1 has no matching tool call',
      'tool_call_id c1 has no matching tool result',
    ]) expect(isUnpaired(body), body).toBe(true);
    for (const body of [
      'invalid model: nope', 'max_tokens must be positive', 'unexpected field "foo"', 'tool_calls is not supported by this model', '', 'The conversation is too long',
      // a schema or choice error that only mentions the words: no relation between a call and a result
      'Invalid tool_calls schema: unexpected property in parameters', "tool_choice must be one of 'auto', 'none' or a tool name",
      "Invalid 'tool_calls[0].function.arguments': must be a string", 'tools: unexpected value; tool_use is not allowed without a tools list', 'tool_use_id must be at most 64 characters',
    ]) expect(isUnpaired(body), body).toBe(false);
  });
});

describe('a file written on one protocol and read on the other (spec 4.6)', () => {
  const THINK = { type: 'reasoning', text: 'THINK-ME', signature: 'SIG-Q1' };
  const tool = { type: 'tool_call', id: 'c0', name: 'Read', args: { file_path: 'x' }, extra: { thought_signature: 'TS-Q1' } };
  const hand = (home: string, id: string) => put(home, id, [L.u('q'), L.a('answer', 'anthropic-messages', [THINK, tool], { note: 'N-Q1' }), L.results(L.res('c0', 'seen')), L.a('end', 'anthropic-messages', [], { mystery: 'M-Q1' })]);

  it('on the other protocol the thinking blocks and every extra are dropped; the rest stays', () => {
    const home = tmp();
    const id = randomUUID();
    hand(home, id);
    const msgs = openConversation(home, id).load('openai-chat').msgs;
    const text = JSON.stringify(msgs);
    for (const gone of ['THINK-ME', 'SIG-Q1', 'TS-Q1', 'N-Q1', 'M-Q1']) expect(text).not.toContain(gone);
    expect(msgs).toEqual([
      { role: 'user', blocks: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: 'answer' }, { type: 'tool_call', id: 'c0', name: 'Read', args: { file_path: 'x' } }] },
      { role: 'user', blocks: [{ type: 'tool_result', id: 'c0', content: 'seen' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: 'end' }] },
    ]);
  });

  it('on the same protocol the signature and every extra come back as they were written', () => {
    const home = tmp();
    const id = randomUUID();
    hand(home, id);
    const msgs = openConversation(home, id).load('anthropic-messages').msgs;
    expect(msgs[1]).toEqual({
      role: 'assistant', extra: { note: 'N-Q1' },
      blocks: [{ type: 'text', text: 'answer' }, { type: 'thinking', text: 'THINK-ME', signature: 'SIG-Q1' }, { type: 'tool_call', id: 'c0', name: 'Read', args: { file_path: 'x' }, extra: { thought_signature: 'TS-Q1' } }],
    });
    expect(msgs[3]).toMatchObject({ extra: { mystery: 'M-Q1' } });
  });

  it('a thinking-only message of the other protocol is dropped whole (no empty message is sent)', () => {
    const home = tmp();
    const id = randomUUID();
    put(home, id, [L.u('q'), { t: 'msg', role: 'assistant', protocol: 'anthropic-messages', blocks: [THINK] }, L.u('q2')]);
    expect(openConversation(home, id).load('openai-chat').msgs.map((m) => m.role)).toEqual(['user', 'user']);
  });

  it('through the engine on anthropic: what the stream gave comes back unchanged after a reload; on the other wire it does not', async () => {
    const r = await make('anthropic-messages');
    r.push({
      status: 200, headers: { 'content-type': 'text/event-stream' },
      body: sse('message_start', { message: { usage: { input_tokens: 1, output_tokens: 1 } } })
        + sse('content_block_start', { index: 0, content_block: { type: 'mystery', data: 'D-Q1' } }) + sse('content_block_stop', { index: 0 })
        + sse('content_block_start', { index: 1, content_block: { type: 'thinking', thinking: '' } })
        + sse('content_block_delta', { index: 1, delta: { type: 'thinking_delta', thinking: 'THINK-ME' } })
        + sse('content_block_delta', { index: 1, delta: { type: 'signature_delta', signature: 'SIG-Q1' } }) + sse('content_block_stop', { index: 1 })
        + sse('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'c0', name: 'Read', input: {}, caller: 'CALLER-Q1' } })
        + sse('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: MISSING }) } }) + sse('content_block_stop', { index: 2 })
        + sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }) + sse('message_stop', {}),
    }, { text: 'seen it' });
    const s = await r.open();
    await s.turn('go');
    expect(parsed(r, s.sessionId)[1].blocks.map((b: any) => b.type)).toEqual(['reasoning', 'tool_call']);
    await s.close();

    // What the wire sends back of an earlier turn is the wire's rule; what the file hands over is the whole of it.
    expect(openConversation(r.host.home, s.sessionId).load('anthropic-messages').msgs[1]).toEqual({
      role: 'assistant', extra: { unknownBlocks: [{ type: 'mystery', data: 'D-Q1' }] },
      blocks: [
        { type: 'thinking', text: 'THINK-ME', signature: 'SIG-Q1' },
        { type: 'tool_call', id: 'c0', name: 'Read', args: { file_path: MISSING }, extra: { caller: 'CALLER-Q1' } },
      ],
    });
    r.push({ text: 'again' });
    const again = await r.open({ sessionId: s.sessionId });
    await again.turn('more');
    await again.close();

    // The same file, read by a session of the other protocol: the proofs and unknown fields are not sent.
    const other = await make('openai-chat', { host: { home: r.host.home } });
    other.push({ text: 'hello from the other side' });
    await (await other.open({ sessionId: s.sessionId })).turn('switched');
    const sent = JSON.stringify(other.fake.requests.at(-1)!.body.messages);
    for (const gone of ['THINK-ME', 'SIG-Q1', 'CALLER-Q1', 'D-Q1']) expect(sent).not.toContain(gone);
    for (const kept of ['go', 'seen it', 'more', 'switched']) expect(sent).toContain(kept);
  });
});

describe('the summary boundary (Task 16 writes it; resume reads from the last one)', () => {
  it('loads only from the last summary; the summary is a user text block; money before it still counts', () => {
    const home = tmp();
    const id = randomUUID();
    put(home, id, [L.u('old 1'), L.a('old a1'), L.usage('m', 1), L.summary('FIRST SUMMARY'), L.u('mid'), L.a('mid a'), L.usage('m', 2), L.summary('SECOND SUMMARY'), L.u('new q'), L.a('new a'), L.usage('m', 4)]);
    const loaded = openConversation(home, id).load('openai-chat');
    expect(loaded.msgs).toEqual([
      { role: 'user', blocks: [{ type: 'text', text: 'SECOND SUMMARY' }] },
      { role: 'user', blocks: [{ type: 'text', text: 'new q' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: 'new a' }] },
    ]);
    expect(loaded.total).toBe(7);
    expect(loaded.totals).toEqual({ m: 7 });
  });

  it('the next request carries the summary and what follows it, not what came before', async () => {
    const r = await make('openai-chat');
    const id = randomUUID();
    put(r.host.home, id, [L.u('old question'), L.a('old answer'), L.summary('THE SUMMARY'), L.u('new question'), L.a('new answer'), L.usage('m', 1)]);
    r.push({ text: 'ok' });
    await (await r.open({ sessionId: id })).turn('next');
    const sent = JSON.stringify(r.fake.requests[0]!.body.messages);
    expect(sent).toContain('THE SUMMARY');
    expect(sent).toContain('new answer');
    expect(sent).not.toContain('old question');
    expect(sent).not.toContain('old answer');
  });
});

describe('through the HTTP server: a restart, then the next reply continues', () => {
  it('the second reply after a restart is given the first turn', async () => {
    const r = await make('openai-chat');
    const home = r.host.home;
    fs.mkdirSync(path.join(home, 'mods', 'p'), { recursive: true });
    fs.writeFileSync(path.join(home, 'mods', 'p', 'mod.json'), JSON.stringify({
      reins: 1, id: 'p', kind: 'provider', version: '1', label: 'Fake', protocol: 'openai-chat', baseUrl: `${r.fake.url}/v1`,
      auth: { style: 'bearer', keyEnv: ['P_API_KEY'] }, defaultModel: 'm', models: [{ id: 'm', context: 1000, maxOutput: 100, price: PRICE }],
    }));
    const dbFile = path.join(tmpDir(), 'reins.db');
    const cwd = tmpDir();
    const start = (store: Store) => startServer({
      store, dir: home, probe: async () => PROBE, consent: () => undefined, // S16: the user's yes is pre-granted
      makeEngine: ({ model, effort, onApprove, onLive, settings }) => loopEngine(r.p, r.wire, { ...r.host, onApprove, onLive, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(settings ? { settings } : {}) }),
    });
    const settled = (store: Store, id: string, n: number) => until(() => {
      const last = store.readLog(id).at(-1);
      return rowsOf(store, id, 'turn_ended').length >= n && last?.type === 'status' && (last.data as { status?: string }).status === 'idle';
    });
    const usage = USAGE_120['openai-chat'];
    r.push({ text: 'the first answer', usage }, { text: 'the second answer', usage });

    let store = openStore(dbFile);
    let srv = await start(store);
    const made = await request(srv, 'POST', '/api/sessions', { body: { cwd, engine: 'p' } });
    expect(made.status).toBe(200);
    const id = made.json.id as string;
    expect((await request(srv, 'POST', `/api/sessions/${id}/message`, { body: { text: 'the first question' } })).status).toBe(200);
    await settled(store, id, 1);
    const sid = store.getSession(id)!.engineSessionId!;
    expect(fs.existsSync(fileOf(r, sid))).toBe(true);
    await srv.close();
    store.close();

    store = openStore(dbFile);
    srv = await start(store);
    try {
      expect((await request(srv, 'POST', `/api/sessions/${id}/message`, { body: { text: 'the second question' } })).status).toBe(200);
      await settled(store, id, 2);
      const sent = JSON.stringify(r.fake.requests.at(-1)!.body.messages);
      for (const t of ['the first question', 'the first answer', 'the second question']) expect(sent).toContain(t);
      expect(r.fake.requests).toHaveLength(2);
      expect(store.getSession(id)!.engineSessionId).toBe(sid);
      expect(store.getEngineTotal(sid)).toBeCloseTo(2 * COST_120, 12);
      expect(parsed(r, sid).filter((l) => l.t === 'msg' && l.usage)).toHaveLength(2);
    } finally {
      await srv.close();
      store.close();
    }
  });
});

describe('the loop\'s tools cannot open the conversation file (the Reins home stays closed)', () => {
  it('Read, Grep, Glob, Write and a shell command naming it are all refused, with the file there', async () => {
    const r = await make('openai-chat');
    const project = tmp();
    r.push({ text: 'a sentence with a secret in it' });
    const s = await r.open({ cwd: project, policy: () => WRITE_MODE });
    await s.turn('first');
    const file = fileOf(r, s.sessionId);
    const before = fs.readFileSync(file, 'utf8');
    expect(before).toContain('a sentence with a secret in it');
    const dir = folder(r);
    const SHELL = shellToolName(process.platform);
    r.push(
      calls(call('a', 'Read', { file_path: file }), call('b', 'Grep', { pattern: 'secret', path: dir }), call('c', 'Glob', { pattern: '*.jsonl', path: dir }),
        call('d', 'Write', { file_path: file, content: 'x' }), call('e', SHELL, { command: `${process.platform === 'win32' ? 'type' : 'cat'} "${file}"` })),
      { text: 'done' },
    );
    await s.turn('go');
    expect(toolResults(r.fake.requests.at(-1)!.body).map((x) => x.content)).toEqual([HOME_WORDS, HOME_WORDS, HOME_WORDS, HOME_WORDS, HOME_NAMED_WORDS]);
    expect(fs.readFileSync(file, 'utf8').startsWith(before)).toBe(true);
  });

  it('a project folder that is the home itself: the default search and a relative path are refused too', async () => {
    const r = await make('openai-chat');
    r.push({ text: 'a sentence with a secret in it' });
    const s = await r.open({ cwd: r.host.home, policy: () => WRITE_MODE });
    await s.turn('first');
    r.push(
      calls(call('a', 'Read', { file_path: `conversations/${s.sessionId}.jsonl` }), call('b', 'Grep', { pattern: 'secret' }), call('c', 'Glob', { pattern: '**/*.jsonl' }), call('d', 'Grep', { pattern: 'secret', path: 'conversations' })),
      { text: 'done' },
    );
    await s.turn('go');
    expect(toolResults(r.fake.requests.at(-1)!.body).map((x) => x.content)).toEqual([HOME_WORDS, HOME_WORDS, HOME_WORDS, HOME_WORDS]);
  });
});

describe('the order of what is written, and a write that fails', () => {
  it('a turn that got no reply leaves no trace on disk, in a new session and in a resumed one', async () => {
    const r = await make('openai-chat');
    r.push({ text: 'a1', usage: USAGE_120['openai-chat'] });
    const s = await r.open();
    await s.turn('q1');
    const before = raw(r, s.sessionId);
    r.push(...Array.from({ length: 4 }, () => ({ status: 500, body: 'boom' })));
    await expect(s.turn('lost')).rejects.toThrow('server error');
    expect(raw(r, s.sessionId)).toBe(before);
    await s.close();
    r.push(...Array.from({ length: 4 }, () => ({ status: 500, body: 'boom' })));
    await expect((await r.open({ sessionId: s.sessionId })).turn('lost again')).rejects.toThrow('server error');
    expect(raw(r, s.sessionId)).toBe(before);
    expect(before).not.toContain('lost');
  });

  it('the user message goes to the file with the first reply, before it', async () => {
    const r = await make('openai-chat');
    r.push(toolReply(0), { text: 'done' });
    const s = await r.open();
    await s.turn('go');
    expect(shape(parsed(r, s.sessionId)).slice(0, 3)).toEqual(['msg:user', 'msg:assistant', 'msg:user']);
    expect(parsed(r, s.sessionId)[0].blocks[0].text).toBe('go');
  });

  it('a write that throws: exactly one error event, the turn still returns its text, later writes are not tried', async () => {
    let tries = 0;
    const spy: StoreFs = { ...fs, appendFileSync: (() => { tries++; throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); }) as typeof fs.appendFileSync };
    const r = await make('openai-chat', { deps: { convFs: spy } });
    r.push({ text: 'one' }, { text: 'two' });
    const s = await r.open();
    const first = await s.turn('hi');
    expect(first.text).toBe('one');
    expect(first.isError).toBeUndefined();
    expect(saveHooks(first.events!)).toEqual([{ type: 'hook', event: 'conversation-save', decision: 'failed', reason: 'ENOSPC: no space left on device' }]);
    expect(types(first.events)).not.toContain('error');
    expect(saveHooks(r.live)).toHaveLength(1);
    const second = await s.turn('again');
    expect(second.text).toBe('two');
    expect(saveHooks(second.events!)).toEqual([]);
    expect(tries).toBe(1);
    expect(JSON.stringify(r.fake.requests.at(-1)!.body.messages)).toContain('one');
  });

  it('the reason of a failed write is redacted', async () => {
    const spy: StoreFs = { ...fs, appendFileSync: (() => { throw new Error(`disk said ${KEY}`); }) as typeof fs.appendFileSync };
    const r = await make('openai-chat', { deps: { convFs: spy } });
    r.push({ text: 'one' });
    const res = await (await r.open()).turn('hi');
    expect((saveHooks(res.events!)[0] as { reason: string }).reason).toBe('disk said [key Reins]');
  });

  it('a turn aborted while a tool waits for the user leaves a file that loads well paired, and resumes on a strict provider', async () => {
    const SHELL = shellToolName(process.platform);
    const r = await make('openai-chat', { strictPairs: true, host: { onApprove: () => new Promise(() => {}) } });
    r.push(calls(call('s1', SHELL, { command: 'echo hi' })));
    const s = await r.open({ policy: () => WRITE_MODE });
    const turn = s.turn('run it');
    await until(() => r.fake.requests.length >= 1 && types(r.live).includes('tool_call'));
    await s.interrupt();
    expect((await turn).text).toBe('');
    await s.close();
    expect(shape(parsed(r, s.sessionId))).toEqual(['msg:user', 'msg:assistant']);
    const loaded = openConversation(r.host.home, s.sessionId).load('openai-chat');
    expect(pairUp(loaded.msgs)).toEqual({ msgs: loaded.msgs, stubbed: [] });
    expect(JSON.stringify(loaded.msgs.at(-1))).toContain(INTERRUPTED);
    r.push({ text: 'resumed' });
    expect((await (await r.open({ sessionId: s.sessionId })).turn('go on')).text).toBe('resumed');
  });
});
