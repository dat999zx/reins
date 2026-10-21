// Task 11 fix round: a regression test for each item of the security review (docs/plan/p-task-11-codex-review.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent, Policy } from '@reins/core';
import { hostSend, startMods } from '../src/engines.js';
import { readBounded, replaceFile } from '../src/loop/fileio.js';
import { HOME_WORDS, confine } from '../src/loop/paths.js';
import { setKey } from '../src/secrets.js';
import { HARD_LINK_WORDS, MAX_FILE, MAX_GREP_FILE, findTool, type ToolCtx, type ToolOut } from '../src/loop/tools.js';
import { KEY, rig, toolResults, type Rig } from './loop-harness.js';
import { tempHome } from './mods-harness.js';

const INTERRUPTED = 'Interrupted; the tool did not finish.';
const WRITE_MODE: Policy = { mode: 'write', guards: [], allowShell: true };
const win = process.platform === 'win32';

let tmp = '';
let cwd = '';
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-fix-')));
  cwd = path.join(tmp, 'proj');
  fs.mkdirSync(cwd);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of rigs.splice(0)) await r.cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const put = (rel: string, text: string | Buffer) => {
  const abs = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
};
const ctxOf = (extra: Partial<ToolCtx> = {}): ToolCtx => ({
  cwd, home: path.join(tmp, 'home'), policy: () => WRITE_MODE, signal: new AbortController().signal, redact: (t, max) => (max === undefined ? t : t.slice(0, max)),
  redactAll: (t) => t, platform: process.platform, ...extra,
});
/** Confines like the engine does, then runs the tool. */
async function run(name: string, input: Record<string, unknown>, ctx = ctxOf()): Promise<ToolOut> {
  const tool = findTool(name)!;
  const at = confine((input[tool.path?.arg ?? ''] as string | undefined) ?? '.', { cwd: ctx.cwd, home: ctx.home, platform: ctx.platform });
  if (!at.ok) throw new Error(`confine refused: ${at.reason}`);
  return await tool.run!(input, ctx, { abs: at.abs, root: at.root });
}
/** A link to a folder: a symlink on POSIX, a junction on Windows. Undefined, or the reason this environment cannot make one. */
function link(target: string, at: string): string | undefined {
  try {
    fs.symlinkSync(target, at, win ? 'junction' : 'dir');
    return undefined;
  } catch (e) {
    return `links cannot be created here (${(e as Error).message})`;
  }
}
const hardLink = (target: string, at: string): string | undefined => {
  try {
    fs.linkSync(target, at);
    return undefined;
  } catch (e) {
    return `hard links cannot be created here (${(e as Error).message})`;
  }
};
/** A Reins home with a secrets file and a conversation file. */
const makeHome = () => {
  const h = path.join(tmp, 'home');
  fs.mkdirSync(path.join(h, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(h, 'secrets.json'), '{"providers":{"p":{"key":"HOMESECRET"}}}');
  fs.writeFileSync(path.join(h, 'conversations', 's.jsonl'), 'convo HOMESECRET\n');
  return h;
};
const listdirSpy = () => {
  const listed: string[] = [];
  const real = fs.readdirSync;
  vi.spyOn(fs, 'readdirSync').mockImplementation(((p: string, ...rest: unknown[]) => (listed.push(String(p)), (real as (...a: unknown[]) => unknown)(p, ...rest))) as typeof real);
  return listed;
};
const under = (p: string, dir: string) => path.resolve(p).toLowerCase().startsWith(path.resolve(dir).toLowerCase());

const rigs: Rig[] = [];
const make = async (o: Parameters<typeof rig>[1] = {}) => {
  const r = await rig('openai-chat', { strictPairs: true, ...o });
  rigs.push(r);
  return r;
};
const call = (id: string, name: string, args: unknown) => ({ id, name, args: JSON.stringify(args) });
const calls = (...c: ReturnType<typeof call>[]) => ({ toolCalls: c });
const open = (r: Rig, policy: Policy = WRITE_MODE) => r.open({ cwd, policy: () => policy });
const asked = (r: Rig, at = 1) => toolResults(r.fake.requests[at]!.body);
const ofType = <T extends EngineEvent['type']>(ev: EngineEvent[], type: T) => ev.filter((e): e is Extract<EngineEvent, { type: T }> => e.type === type);

describe('fix 1: hard links and atomic replacement', () => {
  it('replaceFile renames over the name: a hard-linked alias keeps the old data', (t) => {
    put('f.txt', 'orig');
    const why = hardLink(path.join(cwd, 'f.txt'), path.join(cwd, 'alias.txt'));
    if (why) return t.skip(`SKIPPED: ${why}`);
    replaceFile(path.join(cwd, 'f.txt'), 'new');
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(cwd, 'alias.txt'), 'utf8')).toBe('orig');
  });

  it('a failure half way leaves the old file whole and no temporary file behind', () => {
    put('f.txt', 'ORIGINAL');
    const real = fs.writeSync;
    vi.spyOn(fs, 'writeSync').mockImplementation(((...a: Parameters<typeof real>) => {
      real(...a);
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }) as unknown as typeof real);
    expect(() => replaceFile(path.join(cwd, 'f.txt'), 'REPLACEMENT')).toThrow('disk full');
    vi.restoreAllMocks();
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8')).toBe('ORIGINAL');
    expect(fs.readdirSync(cwd)).toEqual(['f.txt']);
  });

  it.skipIf(win)('the new file takes the mode of the one it replaces', () => {
    put('f.txt', 'orig');
    fs.chmodSync(path.join(cwd, 'f.txt'), 0o640);
    replaceFile(path.join(cwd, 'f.txt'), 'new');
    expect(fs.statSync(path.join(cwd, 'f.txt')).mode & 0o777).toBe(0o640);
  });

  it('Write and Edit refuse a file that has other names, and change neither name', async (t) => {
    put('f.txt', 'orig');
    const why = hardLink(path.join(cwd, 'f.txt'), path.join(cwd, 'alias.txt'));
    if (why) return t.skip(`SKIPPED: ${why}`);
    expect(await run('Write', { file_path: 'f.txt', content: 'x' })).toEqual({ text: HARD_LINK_WORDS, isError: true });
    expect(await run('Edit', { file_path: 'alias.txt', old_string: 'orig', new_string: 'x' })).toEqual({ text: HARD_LINK_WORDS, isError: true });
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8')).toBe('orig');
    expect(fs.readFileSync(path.join(cwd, 'alias.txt'), 'utf8')).toBe('orig');
  });

  it('a project name for a file of the Reins home is refused by Read, Grep, Write and Edit; the home file is untouched', async (t) => {
    const home = makeHome();
    const why = hardLink(path.join(home, 'secrets.json'), path.join(cwd, 'alias.json')) ?? hardLink(path.join(home, 'conversations', 's.jsonl'), path.join(cwd, 'convo.txt'));
    if (why) return t.skip(`SKIPPED: ${why}`);
    const ctx = ctxOf({ home });
    expect(await run('Read', { file_path: 'alias.json' }, ctx)).toEqual({ text: HOME_WORDS, isError: true });
    expect(await run('Read', { file_path: 'convo.txt' }, ctx)).toEqual({ text: HOME_WORDS, isError: true });
    expect(await run('Grep', { pattern: 'HOMESECRET', path: 'alias.json' }, ctx)).toEqual({ text: HOME_WORDS, isError: true });
    expect((await run('Grep', { pattern: 'HOMESECRET' }, ctx)).text).toBe('No matches found.');
    expect(await run('Write', { file_path: 'alias.json', content: 'x' }, ctx)).toEqual({ text: HARD_LINK_WORDS, isError: true });
    expect(await run('Edit', { file_path: 'alias.json', old_string: 'HOMESECRET', new_string: 'x' }, ctx)).toEqual({ text: HARD_LINK_WORDS, isError: true });
    expect(fs.readFileSync(path.join(home, 'secrets.json'), 'utf8')).toContain('HOMESECRET');
  });

  it('an ordinary hard link inside the project (a package store) reads and searches fine', async (t) => {
    makeHome();
    put('store/a.txt', 'shared content');
    const why = hardLink(path.join(cwd, 'store', 'a.txt'), path.join(cwd, 'b.txt'));
    if (why) return t.skip(`SKIPPED: ${why}`);
    expect((await run('Read', { file_path: 'b.txt' })).text).toBe('     1\tshared content');
    expect((await run('Grep', { pattern: 'shared', output_mode: 'files_with_matches' })).text).toBe('b.txt\nstore/a.txt');
  });
});

describe('fix 2: a name under the home is refused before any link is followed', () => {
  it('the home inside the project with a link in it that leads back to the project', async (t) => {
    const inner = path.join(cwd, '.reins');
    fs.mkdirSync(inner);
    const why = link(cwd, path.join(inner, 'egress'));
    if (why) return t.skip(`SKIPPED: ${why}`);
    expect(confine('.reins/egress/new.txt', { cwd, home: inner })).toEqual({ ok: false, reason: HOME_WORDS });
    const r = await make({ host: { home: inner } });
    r.push(calls(call('a', 'Write', { file_path: '.reins/egress/new.txt', content: 'x' })), { text: 'ok' });
    await (await open(r)).turn('go');
    expect(asked(r)[0]!.content).toBe(HOME_WORDS);
    expect(fs.existsSync(path.join(cwd, 'new.txt'))).toBe(false);
  });
});

describe('fix 3: the walk checks every folder before it reads it', () => {
  it('Glob and Grep never read the home, and still show the rest', async () => {
    const inner = path.join(cwd, '.reins');
    put('.reins/secret/x.txt', 'needle'); put('ok/a.txt', 'needle');
    const listed = listdirSpy();
    const ctx = ctxOf({ home: inner });
    expect((await run('Glob', { pattern: '**/*.txt' }, ctx)).text).toBe('ok/a.txt');
    expect((await run('Grep', { pattern: 'needle' }, ctx)).text).toBe('ok/a.txt:1:needle');
    expect(listed.filter((p) => under(p, inner))).toEqual([]);
    expect(listed.some((p) => under(p, path.join(cwd, 'ok')))).toBe(true);
  });

  it('an interrupt during a walk of many empty folders stops it at once', async () => {
    for (let i = 0; i < 6000; i++) fs.mkdirSync(path.join(cwd, `d${String(i).padStart(4, '0')}`));
    const listed = listdirSpy();
    const ac = new AbortController();
    const began = Date.now();
    setTimeout(() => ac.abort(), 30);
    const out = await run('Glob', { pattern: '**/*.zip' }, ctxOf({ signal: ac.signal }));
    expect(Date.now() - began).toBeLessThan(1000);
    expect(out).toEqual({ text: 'Interrupted.', isError: true });
    expect(listed.length).toBeLessThan(6000);
  }, 30_000);

  it('a walk stops after too many entries and says so', async () => {
    for (let i = 0; i < 40; i++) put(`f${i}.txt`, 'needle');
    const ctx = ctxOf({ maxEntries: 10 });
    expect((await run('Glob', { pattern: '*.txt' }, ctx)).text).toMatch(/\nsearch stopped: too many entries$/);
    expect((await run('Grep', { pattern: 'needle', output_mode: 'count' }, ctx)).text).toMatch(/\nsearch stopped: too many entries$/);
    expect((await run('Glob', { pattern: '*.txt' })).text).not.toContain('too many');
  });

  it('folders named Node_Modules and .GIT are skipped whatever their case', async () => {
    put('Node_Modules/pkg/i.js', ''); put('.GIT/config', ''); put('keep.js', '');
    expect((await run('Glob', { pattern: '**/*' })).text).toBe('keep.js');
  });
});

describe('fix 4: a regex that never ends cannot hold the process', () => {
  it('(a+)+$ against 32 a and a bang returns within 3 s with the message', async () => {
    put('big.txt', `${'a'.repeat(32)}!\n`);
    put('zz.txt', 'aaa\n');
    const began = Date.now();
    const out = await run('Grep', { pattern: '(a+)+$' });
    expect(Date.now() - began).toBeLessThan(3000);
    expect(out).toEqual({ text: 'Grep stopped: the pattern is too slow on big.txt', isError: true });
    // an ordinary pattern on the same files still works afterwards
    expect((await run('Grep', { pattern: '^a+!$' })).text).toBe(`big.txt:1:${'a'.repeat(32)}!`);
  }, 15_000);

  it('a line over 10,000 characters is not matched, and the result says so once', async () => {
    put('long.txt', `needle ${'x'.repeat(10_001)}\nneedle short\n`);
    put('long2.txt', `${'y'.repeat(10_001)}\n`);
    expect((await run('Grep', { pattern: 'needle' })).text).toBe('long.txt:2:needle short\n[lines over 10000 characters were not searched]');
  });
});

describe('fix 5 and 7: redaction of a clipped line and of the public tool input', () => {
  it('Grep redacts the whole line before it clips it: no 8-character prefix of the key is shown', async () => {
    put('env.txt', `${'x'.repeat(485)}${KEY}tail\n`);
    const r = await make();
    r.push(calls(call('a', 'Grep', { pattern: 'x' })), { text: 'ok' });
    const res = await (await open(r)).turn('go');
    const out = ofType(res.events!, 'tool_result')[0]!.output as string;
    expect(out).toContain('[key Reins]');
    expect(out).not.toContain(KEY.slice(0, 8));
    expect(JSON.stringify(r.fake.requests[1]!.body)).not.toContain(KEY.slice(0, 8));
  });

  it('a Write whose content holds the key shows [key Reins] in onLive and the events; the file is NOT written (p29a A1: it used to be written with the real content)', async () => {
    const r = await make();
    r.push(calls(call('a', 'Write', { file_path: 'k.txt', content: `token=${KEY}\n` })), { text: 'ok' });
    const res = await (await open(r)).turn('go');
    expect(JSON.stringify(res.events)).not.toContain(KEY);
    expect(JSON.stringify(r.live)).not.toContain(KEY);
    expect(res.events).toContainEqual({ type: 'tool_call', tool: 'Write', input: { file_path: 'k.txt', content: 'token=[key Reins]\n' } });
    expect(fs.existsSync(path.join(cwd, 'k.txt'))).toBe(false);
    expect(res.events).toContainEqual({ type: 'tool_result', tool: 'Write', output: 'That content holds a saved key, so it was not written.' });
  });
});

describe('fix 6: an interrupt does not wait for a stuck read', () => {
  it('the turn ends within 1 s, the call gets the stub, and the late read is never recorded', async () => {
    put('a.txt', 'LATE CONTENT');
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    const real = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: string, ...rest: unknown[]) => {
      // held until released, or for 2.5 s: a missing fix then shows as a slow turn, not a hang
      if (String(p).endsWith('a.txt')) await Promise.race([gate, new Promise((ok) => setTimeout(ok, 2500))]);
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.promises.open);
    const r = await make();
    r.push(calls(call('a', 'Read', { file_path: 'a.txt' })), { text: 'again' });
    const s = await open(r);
    let at = 0;
    r.host.onLive = (e) => {
      r.live.push(e);
      if (e.type === 'tool_call') setTimeout(() => { at = Date.now(); void s.interrupt(); }, 30);
    };
    const res = await s.turn('go');
    expect(Date.now() - at).toBeLessThan(1000);
    expect(res.text).toBe('');
    expect(res.events).toContainEqual({ type: 'tool_result', tool: 'Read', output: INTERRUPTED });
    release();
    await new Promise((ok) => setTimeout(ok, 200));
    expect(JSON.stringify(r.live)).not.toContain('LATE CONTENT');
    r.host.onLive = (e) => void r.live.push(e);
    expect((await s.turn('hi')).text).toBe('again');
    expect(asked(r)).toEqual([{ id: 'a', content: INTERRUPTED }]);
  });

  it('readBounded looks at the signal between chunks', async () => {
    put('big.bin', Buffer.alloc(3 * 1024 * 1024, 'a'));
    const ac = new AbortController();
    const real = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (...a: unknown[]) => {
      const fh = await (real as (...x: unknown[]) => Promise<fs.promises.FileHandle>)(...a);
      const read = fh.read.bind(fh) as (...x: unknown[]) => Promise<unknown>;
      (fh as any).read = async (...x: unknown[]) => { const out = await read(...x); ac.abort(); return out; };
      return fh;
    }) as typeof fs.promises.open);
    expect(await readBounded(path.join(cwd, 'big.bin'), MAX_FILE, ac.signal)).toBe('aborted');
  });
});

describe('fix 8: the bytes read are bounded, not the size seen earlier', () => {
  it('a file that grows after it was opened is cut off at the limit', async () => {
    put('g.txt', 'small');
    const real = fs.promises.open.bind(fs.promises);
    let bytes = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: string, ...rest: unknown[]) => {
      const fh = await (real as (...a: unknown[]) => Promise<fs.promises.FileHandle>)(p, ...rest);
      if (!String(p).endsWith('g.txt')) return fh;
      return new Proxy(fh, {
        get(target, k) {
          const v = (target as any)[k];
          if (typeof v !== 'function') return v;
          if (k === 'stat') return async (...a: unknown[]) => { const s = await v.apply(target, a); fs.appendFileSync(String(p), Buffer.alloc(MAX_FILE + 1024 * 1024)); return s; };
          if (k === 'read') return async (...a: unknown[]) => { const out = await v.apply(target, a); bytes += out.bytesRead; return out; };
          return v.bind(target);
        },
      });
    }) as typeof fs.promises.open);
    const out = await run('Read', { file_path: 'g.txt' });
    expect(out).toMatchObject({ isError: true, text: expect.stringContaining('is over 20 MB') });
    expect(bytes).toBeLessThanOrEqual(MAX_FILE + 1);
  }, 30_000);

  it('Read: exactly 20 MB is read, one byte more is refused', async () => {
    put('exact.bin', Buffer.alloc(MAX_FILE, 'a'));
    expect((await run('Read', { file_path: 'exact.bin' })).isError).toBeUndefined();
    put('plus.bin', Buffer.alloc(MAX_FILE + 1, 'a'));
    expect(await run('Read', { file_path: 'plus.bin' })).toMatchObject({ isError: true, text: expect.stringContaining('is over 20 MB') });
  }, 30_000);

  it('Edit: a file of 20 MB is edited, one byte more is refused', async () => {
    put('exact.txt', Buffer.concat([Buffer.from('x'), Buffer.alloc(MAX_FILE - 1, 'a')]));
    expect((await run('Edit', { file_path: 'exact.txt', old_string: 'x', new_string: 'y' })).isError).toBeUndefined();
    expect(fs.readFileSync(path.join(cwd, 'exact.txt')).subarray(0, 2).toString()).toBe('ya');
    put('plus.txt', Buffer.concat([Buffer.from('x'), Buffer.alloc(MAX_FILE, 'a')]));
    expect(await run('Edit', { file_path: 'plus.txt', old_string: 'x', new_string: 'y' })).toMatchObject({ isError: true, text: expect.stringContaining('too big to edit') });
  }, 30_000);

  it('Grep: a file of exactly 2 MB is searched, one byte more is skipped', async () => {
    const fill = (n: number) => Buffer.from(('a'.repeat(99) + '\n').repeat(Math.ceil(n / 100))).subarray(0, n);
    put('exact.txt', Buffer.concat([Buffer.from('needle\n'), fill(MAX_GREP_FILE - 7)]));
    put('plus.txt', Buffer.concat([Buffer.from('needle\n'), fill(MAX_GREP_FILE - 6)]));
    expect((await run('Grep', { pattern: 'needle', output_mode: 'files_with_matches' })).text).toBe('exact.txt\n[skipped 1 file over 2 MB]');
  });
});

describe('fix 9: a whole text is redacted without the trim of its ending', () => {
  it('the production host: a secret "abcdefgh\\nZ" leaves "hello abcdefgh" alone, while a cut would trim it', async () => {
    const home = tempHome();
    try {
      setKey(home.home, 'p', 'abcdefgh\nZ');
      const mods = await startMods({ dir: home.home, env: {} });
      try {
        const host = hostSend(mods, { env: {}, home: home.home });
        expect(host.redactAll!('hello abcdefgh')).toBe('hello abcdefgh');
        expect(host.redactAll!('hello abcdefgh\nZ!')).toBe('hello [key Reins]!');
        expect(host.redact!('hello abcdefgh')).toBe('hello ');
      } finally {
        mods.dispose();
      }
    } finally {
      home.cleanup();
    }
  });
});

describe('fix 10: line endings of the text put in', () => {
  const edit = (input: Record<string, unknown>) => run('Edit', { file_path: 'f.txt', ...input });
  it('a CRLF file gets CRLF for new lines, in a plain match and in a match that needed CRLF', async () => {
    put('f.txt', 'a\r\nb\r\nc\r\n');
    await edit({ old_string: 'b', new_string: 'B\nC' });
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8')).toBe('a\r\nB\r\nC\r\nc\r\n');
    await edit({ old_string: 'a\nB', new_string: 'x\ny' });
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8')).toBe('x\r\ny\r\nC\r\nc\r\n');
  });
  it('an LF file stays LF', async () => {
    put('f.txt', 'a\nb\nc\n');
    await edit({ old_string: 'b', new_string: 'B\nC' });
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8')).toBe('a\nB\nC\nc\n');
  });
});

describe('fix 11: guards on both names, a stale batch, a final component that is not a file', () => {
  it('the path as written is guarded although it resolves to an unguarded place', async (t) => {
    fs.mkdirSync(path.join(cwd, 'elsewhere'));
    const why = link(path.join(cwd, 'elsewhere'), path.join(cwd, 'migrations'));
    if (why) return t.skip(`SKIPPED: ${why}`);
    const r = await make();
    r.push(calls(call('a', 'Write', { file_path: 'migrations/1.sql', content: 'new' })), { text: 'ok' });
    await (await open(r, { mode: 'write', guards: ['migrations/**'], allowShell: true })).turn('go');
    expect(asked(r)[0]!.content).toBe('Blocked by Reins: migrations/1.sql is guarded (migrations/**). Do not touch it.');
    expect(fs.existsSync(path.join(cwd, 'elsewhere', '1.sql'))).toBe(false);
  });

  it('a call is judged just before it runs: the first call turns the step read-only, the second is refused', async () => {
    const policy: Policy = { mode: 'write', guards: [], allowShell: true };
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((...a: Parameters<typeof rename>) => {
      rename(...a);
      if (String(a[1]).endsWith('a.txt')) policy.mode = 'read-only';
    }) as typeof rename);
    const r = await make();
    r.push(calls(call('1', 'Write', { file_path: 'a.txt', content: 'A' }), call('2', 'Write', { file_path: 'b.txt', content: 'B' })), { text: 'ok' });
    await (await open(r, policy)).turn('go');
    expect(asked(r).map((x) => x.content)).toEqual(['Wrote 1 bytes to a.txt', 'Blocked by Reins: this step is read-only. Finish the step; edits unlock after the gate.']);
    expect(fs.existsSync(path.join(cwd, 'b.txt'))).toBe(false);
  });

  it('Write does not replace a final component that is neither a file nor a folder', async () => {
    put('f.txt', 'orig');
    const real = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: string, ...rest: unknown[]) => {
      const s = (real as (...a: unknown[]) => fs.Stats)(p, ...rest);
      return String(p).endsWith('f.txt') ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { isFile: () => false, isDirectory: () => false }) : s;
    }) as typeof real);
    const out = await run('Write', { file_path: 'f.txt', content: 'new' });
    vi.restoreAllMocks();
    expect(out).toMatchObject({ isError: true, text: expect.stringContaining('exists and is not a file') });
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8')).toBe('orig');
  });
});
