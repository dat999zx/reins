// Task 11 fix round 2: a regression test for each item of the second security review (docs/plan/p-task-11-codex2-review.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent, Policy } from '@reins/core';
import { HOME_UNKNOWN_WORDS, replaceFile } from '../src/loop/fileio.js';
import { HOME_WORDS, confine } from '../src/loop/paths.js';
import type { Wire } from '../src/mods/types.js';
import { MAX_FILE, findTool, type ToolCtx, type ToolOut } from '../src/loop/tools.js';
import { KEY, rig, type Rig } from './loop-harness.js';

const WRITE_MODE: Policy = { mode: 'write', guards: [], allowShell: true };
const win = process.platform === 'win32';

let tmp = '';
let cwd = '';
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-fix2-')));
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
async function run(name: string, input: Record<string, unknown>, ctx = ctxOf()): Promise<ToolOut> {
  const tool = findTool(name)!;
  const at = confine((input[tool.path?.arg ?? ''] as string | undefined) ?? '.', { cwd: ctx.cwd, home: ctx.home, platform: ctx.platform });
  if (!at.ok) throw new Error(`confine refused: ${at.reason}`);
  return await tool.run!(input, ctx, { abs: at.abs, root: at.root });
}
const hardLink = (target: string, at: string): string | undefined => {
  try {
    fs.linkSync(target, at);
    return undefined;
  } catch (e) {
    return `hard links cannot be created here (${(e as Error).message})`;
  }
};
/** A Reins home with a nested private file. */
const makeHome = () => {
  const h = path.join(tmp, 'home');
  fs.mkdirSync(path.join(h, 'mod-cache', 'x'), { recursive: true });
  fs.writeFileSync(path.join(h, 'mod-cache', 'x', 'private.db'), 'NESTED_PRIVATE_DATA');
  fs.writeFileSync(path.join(h, 'secrets.json'), '{}');
  return h;
};
const under = (p: string, dir: string) => path.resolve(p).toLowerCase().startsWith(path.resolve(dir).toLowerCase());
const nap = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const rigs: Rig[] = [];
const make = async (o: Parameters<typeof rig>[1] = {}) => {
  const r = await rig('openai-chat', { strictPairs: true, ...o });
  rigs.push(r);
  return r;
};
const call = (id: string, name: string, args: unknown) => ({ id, name, args: JSON.stringify(args) });
const calls = (...c: ReturnType<typeof call>[]) => ({ toolCalls: c });
const ofType = <T extends EngineEvent['type']>(ev: EngineEvent[], type: T) => ev.filter((e): e is Extract<EngineEvent, { type: T }> => e.type === type);

describe('fix 1: a second name of ANY file below the Reins home is refused, and an unchecked home refuses', () => {
  it('a hard link to <home>/mod-cache/x/private.db is refused by Read and Grep', async (t) => {
    const home = makeHome();
    const why = hardLink(path.join(home, 'mod-cache', 'x', 'private.db'), path.join(cwd, 'alias.db'));
    if (why) return t.skip(`SKIPPED: ${why}`);
    const ctx = ctxOf({ home });
    expect(await run('Read', { file_path: 'alias.db' }, ctx)).toEqual({ text: HOME_WORDS, isError: true });
    expect(await run('Grep', { pattern: 'NESTED', path: 'alias.db' }, ctx)).toEqual({ text: HOME_WORDS, isError: true });
    expect((await run('Grep', { pattern: 'NESTED' }, ctx)).text).not.toContain('NESTED_PRIVATE_DATA');
  });

  it('an error while listing the home refuses a file that has other names (and says why)', async (t) => {
    const home = makeHome();
    put('a.txt', 'shared');
    const why = hardLink(path.join(cwd, 'a.txt'), path.join(cwd, 'b.txt'));
    if (why) return t.skip(`SKIPPED: ${why}`);
    const real = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: string, ...rest: unknown[]) => {
      if (under(String(p), home)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof real);
    const ctx = ctxOf({ home });
    expect(await run('Read', { file_path: 'b.txt' }, ctx)).toEqual({ text: HOME_UNKNOWN_WORDS, isError: true });
    expect(await run('Grep', { pattern: 'shared', path: 'b.txt' }, ctx)).toEqual({ text: HOME_UNKNOWN_WORDS, isError: true });
  });

  it('a file with other names that are not in the home (a package store) is still read', async (t) => {
    const home = makeHome();
    put('store/a.txt', 'shared content');
    const why = hardLink(path.join(cwd, 'store', 'a.txt'), path.join(cwd, 'b.txt'));
    if (why) return t.skip(`SKIPPED: ${why}`);
    expect((await run('Read', { file_path: 'b.txt' }, ctxOf({ home }))).text).toBe('     1\tshared content');
  });

  it('a file with one name does not make the home be listed at all', async () => {
    const home = makeHome();
    put('a.txt', 'needle');
    const listed: string[] = [];
    const real = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: string, ...rest: unknown[]) => (listed.push(String(p)), (real as (...a: unknown[]) => unknown)(p, ...rest))) as typeof real);
    const ctx = ctxOf({ home });
    expect((await run('Read', { file_path: 'a.txt' }, ctx)).text).toBe('     1\tneedle');
    expect((await run('Grep', { pattern: 'needle' }, ctx)).text).toBe('a.txt:1:needle');
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.filter((p) => under(p, home))).toEqual([]);
  });

  it('the home is listed once for a Grep over many files that have other names', async (t) => {
    const home = makeHome();
    put('src/a.txt', 'needle');
    for (let i = 0; i < 5; i++) {
      const why = hardLink(path.join(cwd, 'src', 'a.txt'), path.join(cwd, `l${i}.txt`));
      if (why) return t.skip(`SKIPPED: ${why}`);
    }
    let homeListings = 0;
    const real = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: string, ...rest: unknown[]) => {
      if (path.resolve(String(p)).toLowerCase() === path.resolve(home).toLowerCase()) homeListings++;
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof real);
    expect((await run('Grep', { pattern: 'needle', output_mode: 'count' }, ctxOf({ home }))).text).toContain('l4.txt:1');
    // the home folder itself is listed once per spelling of it (as given, and real), never once per file
    expect(homeListings).toBeLessThanOrEqual(2);
  });
});

describe('fix 2: the temporary file is private until it is whole, and nothing is published after a failure', () => {
  const spyOrder = () => {
    const log: string[] = [];
    const wrap = <K extends keyof typeof fs>(k: K, label: string, extra?: (a: unknown[]) => void) => {
      const real = fs[k] as unknown as (...a: unknown[]) => unknown;
      vi.spyOn(fs, k as never).mockImplementation(((...a: unknown[]) => {
        extra?.(a);
        log.push(label);
        return real(...a);
      }) as never);
    };
    wrap('writeSync', 'write');
    wrap('fchmodSync', 'fchmod');
    wrap('fsyncSync', 'fsync');
    wrap('renameSync', 'rename');
    return log;
  };

  it('is created exclusively with mode 0600, whatever the umask', () => {
    const opens: Array<{ flags: unknown; mode: unknown }> = [];
    const real = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: string, ...rest: unknown[]) => {
      if (String(p).endsWith('.tmp')) opens.push({ flags: rest[0], mode: rest[1] });
      return (real as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof real);
    replaceFile(put('f.txt', 'old'), 'new');
    expect(opens).toEqual([{ flags: 'wx', mode: 0o600 }]);
  });

  it('content is written first, then the mode is set, then flushed, then published', () => {
    const f = put('f.txt', 'old');
    const log = spyOrder();
    replaceFile(f, 'new');
    expect(log).toEqual(['write', 'fchmod', 'fsync', 'rename']);
  });

  it('the file keeps the mode it had; a new file gets 0666 minus the umask', () => {
    const f = put('f.txt', 'old');
    const before = fs.lstatSync(f).mode & 0o7777;
    const modes: number[] = [];
    const real = fs.fchmodSync;
    vi.spyOn(fs, 'fchmodSync').mockImplementation(((fd: number, mode: number) => (modes.push(mode), real(fd, mode))) as typeof real);
    replaceFile(f, 'new');
    replaceFile(path.join(cwd, 'fresh.txt'), 'x');
    expect(modes).toEqual([before, 0o666 & ~process.umask()]);
  });

  it.skipIf(win)('a 0600 file is still 0600 after an Edit (POSIX only; skipped on Windows)', async () => {
    const f = put('f.txt', 'secret one');
    fs.chmodSync(f, 0o600);
    await run('Edit', { file_path: 'f.txt', old_string: 'one', new_string: 'two' });
    expect(fs.readFileSync(f, 'utf8')).toBe('secret two');
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it('a mode that cannot be set stops everything: the file is untouched, no temporary file is left, the result is an error, nothing is renamed', async () => {
    const f = put('f.txt', 'ORIGINAL');
    const renamed = vi.spyOn(fs, 'renameSync');
    vi.spyOn(fs, 'fchmodSync').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    const out = await run('Write', { file_path: 'f.txt', content: 'REPLACEMENT' });
    expect(out).toMatchObject({ isError: true, text: expect.stringContaining('operation not permitted') });
    expect(renamed).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(fs.readFileSync(f, 'utf8')).toBe('ORIGINAL');
    expect(fs.readdirSync(cwd)).toEqual(['f.txt']);
  });

  it('a temporary name that is taken is left alone and another name is tried', () => {
    const f = put('f.txt', 'old');
    const real = fs.openSync;
    let collided = '';
    vi.spyOn(fs, 'openSync').mockImplementation(((p: string, ...rest: unknown[]) => {
      if (String(p).endsWith('.tmp') && !collided) {
        collided = String(p);
        fs.writeFileSync(collided, 'SOMEONE ELSE');
      }
      return (real as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof real);
    replaceFile(f, 'new');
    vi.restoreAllMocks();
    expect(fs.readFileSync(f, 'utf8')).toBe('new');
    expect(fs.readFileSync(collided, 'utf8')).toBe('SOMEONE ELSE');
  });
});

describe('fix 3: every byte is charged to the Grep budget', () => {
  it('26 files of 2.1 MB: the search stops with a note and never says that nothing was found', async () => {
    for (let i = 0; i < 26; i++) put(`f${String(i).padStart(2, '0')}.txt`, Buffer.alloc(2_202_010, 'a'));
    const out = (await run('Grep', { pattern: 'needle' })).text;
    expect(out).toContain('search stopped: scanned 50 MB');
    expect(out).toContain('[skipped 23 files over 2 MB]');
    expect(out).not.toContain('No matches found.');
  }, 30_000);
});

describe('fix 4: one deadline for a Glob or Grep call', () => {
  it('110 slow small reads: the call stops near 10 s with what it found', async () => {
    for (let i = 0; i < 110; i++) put(`f${String(i).padStart(3, '0')}.txt`, 'needle\n');
    const real = fs.readSync;
    vi.spyOn(fs, 'readSync').mockImplementation(((...a: Parameters<typeof real>) => (nap(50), real(...a))) as typeof real);
    const began = Date.now();
    const out = await run('Grep', { pattern: 'needle', output_mode: 'files_with_matches' });
    const took = Date.now() - began;
    expect(out.text).toContain('f000.txt');
    expect(out.text).toContain('Grep stopped: it ran longer than 10 s');
    expect(out.text).not.toContain('f109.txt');
    expect(took).toBeGreaterThanOrEqual(9900);
    expect(took).toBeLessThan(10_900);
  }, 30_000);

  it('the deadline shortens the time one file may take: 0.5 s left means 0.5 s, not 2 s', async () => {
    put('zz.txt', `${'a'.repeat(32)}!\n`);
    let n = 0;
    // the first reading of the clock starts the call; every later one is 9.5 s on
    const now = () => 1_000_000 + (n++ === 0 ? 0 : 9500);
    const began = Date.now();
    const out = await run('Grep', { pattern: '(a+)+$' }, ctxOf({ now }));
    expect(Date.now() - began).toBeLessThan(1500);
    expect(out.text).toBe('Grep stopped: it ran longer than 10 s');
  }, 15_000);

  it('Glob stops at the deadline too, and does not say that no files were found', async () => {
    for (let i = 0; i < 5; i++) put(`f${i}.txt`, '');
    let n = 0;
    const now = () => 1_000_000 + (n++ === 0 ? 0 : 20_000);
    const out = await run('Glob', { pattern: '*.txt' }, ctxOf({ now }));
    expect(out.text).toBe('Glob stopped: it ran longer than 10 s');
  });
});

describe('fix 5: the size of the result is known before it is built', () => {
  it('Edit refuses a replacement that would make 32 MiB out of 1 MiB; one just under the limit works', async () => {
    const f = put('f.txt', 'a'.repeat(1024 * 1024));
    const out = await run('Edit', { file_path: 'f.txt', old_string: 'a', new_string: 'b'.repeat(32), replace_all: true });
    expect(out).toMatchObject({ isError: true, text: expect.stringContaining('would be over 20 MB') });
    expect(fs.statSync(f).size).toBe(1024 * 1024);
    const ok = await run('Edit', { file_path: 'f.txt', old_string: 'a', new_string: 'b'.repeat(19), replace_all: true });
    expect(ok.isError).toBeUndefined();
    expect(fs.statSync(f).size).toBe(19 * 1024 * 1024);
    expect(19 * 1024 * 1024).toBeLessThanOrEqual(MAX_FILE);
  }, 30_000);

  it('Write refuses content over 20 MB', async () => {
    const out = await run('Write', { file_path: 'big.txt', content: 'a'.repeat(MAX_FILE + 1) });
    expect(out).toMatchObject({ isError: true, text: expect.stringContaining('over 20 MB') });
    expect(fs.existsSync(path.join(cwd, 'big.txt'))).toBe(false);
  }, 30_000);
});

describe('fix 6: a big tool input is shown as a preview', () => {
  it('a 20 MB Write content gives a small public event and a whole file', async () => {
    const content = 'a'.repeat(20_000_000);
    let n = 0;
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    const wire: Wire = {
      async *call() {
        if (n++ === 0) yield { type: 'tool_call', id: 'a', name: 'Write', args: JSON.stringify({ file_path: 'big.txt', content }) };
        else yield { type: 'text', text: 'ok' };
        yield { type: 'usage', usage };
        yield { type: 'done' };
      },
    };
    const r = await make({ wire });
    const res = await (await r.open({ cwd, policy: () => WRITE_MODE })).turn('go');
    const call = ofType(res.events!, 'tool_call')[0]!;
    expect(JSON.stringify(call).length).toBeLessThan(20_000);
    expect((call.input as { file_path: string }).file_path).toBe('big.txt');
    expect((call.input as { content: string }).content).toMatch(/ \[19995904 more characters\]$/);
    expect(JSON.stringify(r.live).length).toBeLessThan(40_000);
    expect(fs.statSync(path.join(cwd, 'big.txt')).size).toBe(20_000_000);
  }, 60_000);

  it('a key at the cut of a preview is not shown, and the file has the real content', async () => {
    const content = `${'x'.repeat(4090)}${KEY}${'y'.repeat(1_200_000)}`;
    const r = await make();
    r.push(calls(call('a', 'Write', { file_path: 'k.txt', content })), { text: 'ok' });
    const res = await (await r.open({ cwd, policy: () => WRITE_MODE })).turn('go');
    const shown = (ofType(res.events!, 'tool_call')[0]!.input as { content: string }).content;
    expect(shown.length).toBeLessThan(4200);
    expect(shown).not.toContain('sk-test-');
    expect(shown).toContain('[key');
    expect(fs.readFileSync(path.join(cwd, 'k.txt'), 'utf8')).toBe(content);
  }, 30_000);
});
