import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_WORDS, HOME_WORDS, LEXICAL_WORDS, confine, lexicalRefusal, toRel, type FsLike } from '../src/loop/paths.js';

const win = process.platform === 'win32';
let tmp = '';
let cwd = '';
let other = '';
let home = '';
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-paths-')));
  cwd = path.join(tmp, 'proj');
  other = path.join(tmp, 'other');
  home = path.join(tmp, 'home');
  for (const d of [cwd, other, home]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(other, 'secret.txt'), 'outside');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A link to a folder: a symlink on POSIX, a junction on Windows. Undefined (and the reason) when this environment cannot make one. */
function link(target: string, at: string): string | undefined {
  try {
    fs.symlinkSync(target, at, win ? 'junction' : 'dir');
    return undefined;
  } catch (e) {
    return `links cannot be created here (${(e as Error).message})`;
  }
}

/** A spy on every function of the real fs; `count()` stops them and says how many calls were made. */
function spyAll() {
  const spies = Object.keys(fs)
    .filter((k) => /^[a-z]/.test(k) && typeof (fs as any)[k] === 'function')
    .map((k) => vi.spyOn(fs as any, k));
  return () => {
    const n = spies.reduce((a, s) => a + s.mock.calls.length, 0);
    for (const s of spies) s.mockRestore();
    return n;
  };
}

/** A fake file system for another platform: every path exists as it is written and nothing is a link. */
const identityFs = (): FsLike => ({ realpathSync: { native: (p: string) => p }, lstatSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });

const LEXICAL: string[] = [
  '\\\\host\\share\\x', '//host/x', '\\/host/x', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', 'C:foo', 'c:', 'CON', 'nul.txt', 'COM1', 'a\\ADMIN~1\\b', 'a/PROGRA~2/x',
  'a\0b', 'dir/aux/x', 'LPT9.tar.gz', 'con.', 'CoN ', 'nul .txt', 'Com5 ', 'src/prn.ts', 'x/NuL', 'a.txt::$DATA', 'dir/file:stream', 'CON:', 'secrets.json.', 'a/b ', 'a/...',
];

describe('lexical refusals (4.3 step 1): no fs call, on every platform', () => {
  it.each(LEXICAL)('%j is refused with the plain words', (raw) => {
    expect(lexicalRefusal(raw)).toBe(LEXICAL_WORDS(raw));
    expect(lexicalRefusal(raw)).toContain('Blocked by Reins: Reins does not open network, device or short-name paths (');
  });

  it('an empty path has its own words', () => {
    for (const raw of ['', '   ']) expect(confine(raw, { cwd, home })).toEqual({ ok: false, reason: EMPTY_WORDS });
  });

  it.each(LEXICAL)('confine(%j) makes no fs call at all (a spy on the whole fs module and a spy fs)', (raw) => {
    const injected = { realpathSync: { native: vi.fn(() => { throw new Error('fs touched'); }) }, lstatSync: vi.fn(() => { throw new Error('fs touched'); }) };
    const count = spyAll();
    const r = confine(raw, { cwd, home, fs: injected });
    const calls = count();
    expect(r.ok).toBe(false);
    expect(calls).toBe(0);
    expect(injected.realpathSync.native).not.toHaveBeenCalled();
    expect(injected.lstatSync).not.toHaveBeenCalled();
  });

  it('on a platform that is not the host the rules are the same', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) expect(confine('nul.txt', { cwd: '/x', home: '/h', platform, fs: identityFs() }).ok).toBe(false);
  });

  it('ordinary names are not caught', () => {
    for (const raw of ['src/console.ts', 'conf/x', 'comma', 'a/b.c/d', '../x', './x', 'a/auxiliary/x', 'com10', 'C:\\ok\\x', 'C:/ok/x', 'my~file', 'a b/c d', '.hidden/.env']) {
      expect(lexicalRefusal(raw), raw).toBeUndefined();
    }
  });
});

describe('resolve (4.3 steps 2, 3, 5)', () => {
  it('a relative path inside the folder, a new file included, resolves to the real path', () => {
    fs.mkdirSync(path.join(cwd, 'a'));
    expect(confine('a/new.txt', { cwd, home })).toEqual({ ok: true, abs: path.join(cwd, 'a', 'new.txt'), inside: true, root: cwd });
    expect(confine('.', { cwd, home })).toMatchObject({ ok: true, abs: cwd, inside: true });
    expect(confine('deep/er/still/new.txt', { cwd, home })).toMatchObject({ ok: true, abs: path.join(cwd, 'deep', 'er', 'still', 'new.txt'), inside: true });
  });

  it('.. out of the folder, and an absolute path elsewhere, are outside (the caller decides)', () => {
    expect(confine('../other/secret.txt', { cwd, home })).toMatchObject({ ok: true, abs: path.join(other, 'secret.txt'), inside: false });
    expect(confine(path.join(other, 'secret.txt'), { cwd, home })).toMatchObject({ ok: true, inside: false });
    expect(confine('a/../../other/x', { cwd, home })).toMatchObject({ ok: true, inside: false });
    expect(confine(path.join(cwd, 'x.txt'), { cwd, home })).toMatchObject({ ok: true, inside: true });
  });

  it('a folder whose name only starts like the cwd is outside', () => {
    fs.mkdirSync(path.join(tmp, 'proj-two'));
    expect(confine('../proj-two/x', { cwd, home })).toMatchObject({ ok: true, inside: false });
  });

  it('a link inside the folder that leads out is outside, for an existing file and a new one', (t) => {
    const why = link(other, path.join(cwd, 'out'));
    if (why) return t.skip(`SKIPPED: ${why}`);
    expect(confine('out/secret.txt', { cwd, home })).toMatchObject({ ok: true, abs: path.join(other, 'secret.txt'), inside: false });
    expect(confine('out/new.txt', { cwd, home })).toMatchObject({ ok: true, abs: path.join(other, 'new.txt'), inside: false });
    expect(confine('out', { cwd, home })).toMatchObject({ ok: true, abs: other, inside: false });
  });

  it('a link inside the folder that leads inside is inside, as the real path', (t) => {
    fs.mkdirSync(path.join(cwd, 'real'));
    const why = link(path.join(cwd, 'real'), path.join(cwd, 'alias'));
    if (why) return t.skip(`SKIPPED: ${why}`);
    expect(confine('alias/f.txt', { cwd, home })).toMatchObject({ ok: true, abs: path.join(cwd, 'real', 'f.txt'), inside: true });
  });

  it('a link that leads nowhere is refused, not treated as a new file', (t) => {
    const why = link(path.join(other, 'not-there'), path.join(cwd, 'dangling'));
    if (why) return t.skip(`SKIPPED: ${why}`);
    const r = confine('dangling', { cwd, home });
    expect(r.ok).toBe(false);
    expect(confine('dangling/x.txt', { cwd, home }).ok).toBe(false);
  });

  it('a cwd that is itself a link is judged by its real path', (t) => {
    const why = link(cwd, path.join(tmp, 'cwdlink'));
    if (why) return t.skip(`SKIPPED: ${why}`);
    expect(confine('a.txt', { cwd: path.join(tmp, 'cwdlink'), home })).toMatchObject({ ok: true, abs: path.join(cwd, 'a.txt'), inside: true, root: cwd });
  });

  it('a path that is an error for the fs (not just missing) is refused', () => {
    const bad: FsLike = { realpathSync: { native: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }, lstatSync: () => ({}) };
    const r = confine('a.txt', { cwd, home, fs: bad });
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toContain('Blocked by Reins');
  });

  it('an error with no code is a bug and goes up (the engine turns it into a deny)', () => {
    const boom: FsLike = { realpathSync: { native: () => { throw new Error('boom'); } }, lstatSync: () => ({}) };
    expect(() => confine('a.txt', { cwd, home, fs: boom })).toThrow('boom');
  });
});

describe('case rule (4.3 step 3)', () => {
  const ctx = (platform: NodeJS.Platform, c: string, h: string) => ({ cwd: c, home: h, platform, fs: identityFs() });

  it('win32: c: and C:, and any letter case, are the same place', () => {
    expect(confine('c:\\work\\proj\\a.txt', ctx('win32', 'C:\\work\\proj', 'C:\\h'))).toMatchObject({ ok: true, inside: true });
    expect(confine('C:\\WORK\\Proj\\sub\\a.txt', ctx('win32', 'c:\\work\\proj', 'C:\\h'))).toMatchObject({ ok: true, inside: true });
    expect(confine('C:/work/proj/a.txt', ctx('win32', 'C:\\work\\proj', 'C:\\h'))).toMatchObject({ ok: true, inside: true });
    expect(confine('C:\\work\\proj2\\a.txt', ctx('win32', 'C:\\work\\proj', 'C:\\h'))).toMatchObject({ ok: true, inside: false });
  });

  it('darwin ignores case; linux does not', () => {
    expect(confine('/Users/Me/PROJ/a', ctx('darwin', '/users/me/proj', '/h'))).toMatchObject({ inside: true });
    expect(confine('/Users/Me/PROJ/a', ctx('linux', '/users/me/proj', '/h'))).toMatchObject({ inside: false });
    expect(confine('/users/me/proj/a', ctx('linux', '/users/me/proj', '/h'))).toMatchObject({ inside: true });
  });

  it('the Reins home is compared the same way', () => {
    expect(confine('c:\\USERS\\a\\.REINS\\secrets.json', ctx('win32', 'C:\\work', 'C:\\Users\\a\\.reins'))).toEqual({ ok: false, reason: HOME_WORDS });
    expect(confine('/H/.Reins/x', ctx('darwin', '/work', '/h/.reins'))).toEqual({ ok: false, reason: HOME_WORDS });
    expect(confine('/H/.Reins/x', ctx('linux', '/work', '/h/.reins'))).toMatchObject({ ok: true });
  });

  it.runIf(win)('a real path with the drive letter in the other case is inside (real fs)', () => {
    const flipped = cwd[0] === cwd[0]!.toUpperCase() ? cwd[0]!.toLowerCase() + cwd.slice(1) : cwd[0]!.toUpperCase() + cwd.slice(1);
    expect(confine(path.join(flipped, 'a.txt'), { cwd, home })).toMatchObject({ ok: true, inside: true });
    expect(confine('a.txt', { cwd: flipped, home })).toMatchObject({ ok: true, inside: true });
  });
});

describe('the Reins home (4.3 step 4)', () => {
  it('is refused outside the folder, inside the folder, and the home itself', () => {
    expect(confine(path.join(home, 'secrets.json'), { cwd, home })).toEqual({ ok: false, reason: HOME_WORDS });
    expect(confine(home, { cwd, home })).toEqual({ ok: false, reason: HOME_WORDS });
    const inner = path.join(cwd, '.reins');
    fs.mkdirSync(inner);
    expect(confine('.reins/secrets.json', { cwd, home: inner })).toEqual({ ok: false, reason: HOME_WORDS });
    expect(confine('.reins/conversations/new.jsonl', { cwd, home: inner })).toEqual({ ok: false, reason: HOME_WORDS });
    expect(confine('other-file.txt', { cwd, home: inner })).toMatchObject({ ok: true, inside: true });
  });

  it('a home that does not exist yet is still refused', () => {
    const ghost = path.join(cwd, 'ghost-home');
    expect(confine('ghost-home/secrets.json', { cwd, home: ghost })).toEqual({ ok: false, reason: HOME_WORDS });
  });

  it('a home that is itself a link: the target and the link are both refused', (t) => {
    const real = path.join(tmp, 'realhome');
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'secrets.json'), '{}');
    const why = link(real, path.join(cwd, 'homelink'));
    if (why) return t.skip(`SKIPPED: ${why}`);
    const viaLink = path.join(cwd, 'homelink');
    expect(confine(path.join(real, 'secrets.json'), { cwd, home: viaLink })).toEqual({ ok: false, reason: HOME_WORDS });
    expect(confine('homelink/secrets.json', { cwd, home: viaLink })).toEqual({ ok: false, reason: HOME_WORDS });
    expect(confine('homelink/secrets.json', { cwd, home: real })).toEqual({ ok: false, reason: HOME_WORDS });
  });

  it('the words say nothing a receipt would count as a guard or a read-only refusal', () => {
    for (const words of [HOME_WORDS, EMPTY_WORDS, LEXICAL_WORDS('x'), (confine('con', { cwd, home }) as { reason: string }).reason]) {
      expect(words).not.toMatch(/guard|read-only/i);
    }
  });
});

describe('toRel', () => {
  it('uses / and . for the root', () => {
    expect(toRel(path.join(cwd, 'a', 'b.txt'), cwd)).toBe('a/b.txt');
    expect(toRel(cwd, cwd)).toBe('.');
    expect(toRel('C:\\w\\p\\a\\b.txt', 'c:\\w\\p', 'win32')).toBe('a/b.txt');
  });
});
