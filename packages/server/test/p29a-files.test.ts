// Milestone P, Task 29 phase A: a known key never reaches a file (A1), and a link to a network target is refused before it is followed (A6).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Policy } from '@reins/core';
import { addCustom, editMod, importApply, importPreview, type ModEnv } from '../src/mods/actions.js';
import { confine, type FsLike } from '../src/loop/paths.js';
import { findTool, type ToolCtx } from '../src/loop/tools.js';
import { startMods } from '../src/engines.js';
import type { Mods } from '../src/mods/types.js';

const KEY = 'sk-test-0123456789abcdef';
const WRITE_MODE: Policy = { mode: 'write', guards: [], allowShell: true };
const REFUSED = 'That content holds a saved key, so it was not written.';
// A key with quote characters in it: JSON writes it escaped, so only a check on the DECODED names and values can see it.
const QK = 'sk-"q"-0123456789abcdef';

let tmp = '';
let cwd = '';
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29a-')));
  cwd = path.join(tmp, 'proj');
  fs.mkdirSync(cwd);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

function ctxOf(extra: Partial<ToolCtx> = {}): ToolCtx {
  return {
    cwd, home: path.join(tmp, 'home'), policy: () => WRITE_MODE, signal: new AbortController().signal, redact: (t) => t, redactAll: (t) => t,
    platform: process.platform, holdsSecret: (t) => t.includes(KEY), ...extra,
  };
}
async function run(name: string, input: Record<string, unknown>, ctx = ctxOf()) {
  const tool = findTool(name)!;
  const at = confine(input.file_path as string, { cwd: ctx.cwd, home: ctx.home, platform: ctx.platform });
  if (!at.ok) throw new Error(at.reason);
  return await tool.run!(input, ctx, { abs: at.abs, root: at.root });
}

describe('A1: Write and Edit never put a known key in a file', () => {
  it('Write refuses a content that holds the key, with a constant text, and creates nothing', async () => {
    const out = await run('Write', { file_path: 'sub/ordinary.txt', content: `token=${KEY}\n` });
    expect(out.isError).toBe(true);
    expect(out.text).toBe(REFUSED);
    expect(out.text).not.toContain(KEY);
    expect(fs.existsSync(path.join(cwd, 'sub'))).toBe(false); // refused before any folder is made
  });

  it('Write leaves an existing file as it was', async () => {
    const file = path.join(cwd, 'a.txt');
    fs.writeFileSync(file, 'before');
    const out = await run('Write', { file_path: 'a.txt', content: KEY });
    expect(out.text).toBe(REFUSED);
    expect(fs.readFileSync(file, 'utf8')).toBe('before');
  });

  it('Write still writes content without a key', async () => {
    const out = await run('Write', { file_path: 'ok.txt', content: 'hello' });
    expect(out.isError).toBeUndefined();
    expect(fs.readFileSync(path.join(cwd, 'ok.txt'), 'utf8')).toBe('hello');
  });

  it('Edit refuses a key that only exists across the old/new boundary', async () => {
    const file = path.join(cwd, 'b.txt');
    // The key is neither in old_string, nor in new_string, nor in the file: it appears when the edit is applied.
    fs.writeFileSync(file, 'sk-test-0123X456789abcdef');
    const out = await run('Edit', { file_path: 'b.txt', old_string: 'X', new_string: '' });
    expect(out.isError).toBe(true);
    expect(out.text).toBe(REFUSED);
    expect(fs.readFileSync(file, 'utf8')).toBe('sk-test-0123X456789abcdef');
  });

  it('Edit and Write refuse a file name that holds the key, for any extension', async () => {
    fs.writeFileSync(path.join(cwd, 'seed.txt'), 'abc');
    for (const name of [`${KEY}.txt`, `${KEY}.md`, `sub/${KEY}`]) {
      expect((await run('Write', { file_path: name, content: 'hello' })).text).toBe(REFUSED);
      expect((await run('Edit', { file_path: name, old_string: 'a', new_string: 'b' })).text).toBe(REFUSED);
    }
    expect(fs.readdirSync(cwd).filter((n) => n.includes(KEY))).toEqual([]);
  });

  it('Edit refuses a new_string that holds the key', async () => {
    const file = path.join(cwd, 'c.txt');
    fs.writeFileSync(file, 'x = PLACEHOLDER\n');
    const out = await run('Edit', { file_path: 'c.txt', old_string: 'PLACEHOLDER', new_string: KEY });
    expect(out.text).toBe(REFUSED);
    expect(fs.readFileSync(file, 'utf8')).toBe('x = PLACEHOLDER\n');
  });
});

// ---- mod text written by users

const manifest = (over: Record<string, unknown> = {}) => ({
  reins: 1, id: 'leaky', kind: 'provider', version: '1.0.0', label: 'Leaky', protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1',
  defaultModel: 'm', models: [{ id: 'm' }], auth: { style: 'bearer', keyEnv: ['LEAKY_API_KEY'] }, ...over,
});

describe('A1: a known key in a mod file is refused before anything is installed', () => {
  let home = '';
  let mods: Mods;
  beforeEach(async () => {
    home = path.join(tmp, '.reins');
    fs.mkdirSync(home, { recursive: true });
    mods = await startMods({ dir: home, env: {} });
  });
  afterEach(() => mods.dispose());
  const env = (): ModEnv => ({
    home, catalogDir: path.join(tmp, 'none'), mods, consent: { has: () => false, grant: () => {}, revoke: () => {} },
    send: async () => new Response(''), env: {}, redact: (t) => t, holdsSecret: (t) => t.includes(KEY) || t.includes(QK),
  });
  const entries = () => (fs.existsSync(path.join(home, 'mods')) ? fs.readdirSync(path.join(home, 'mods')) : []);

  it('a custom endpoint whose label holds the key is refused, and no folder is made', async () => {
    const r = await addCustom(env(), { id: 'leaky', label: `Mine ${KEY}`, protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1', defaultModel: 'm', auth: { style: 'none' } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    expect(entries()).toEqual([]);
  });

  it('an edit that puts the key in a field is refused and the file is unchanged', async () => {
    const ok = await addCustom(env(), { id: 'leaky', label: 'Mine', protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1', defaultModel: 'm', auth: { style: 'none' } });
    expect(ok.status).toBe(200);
    const file = path.join(home, 'mods', 'leaky', 'mod.json');
    const before = fs.readFileSync(file, 'utf8');
    const r = await editMod(env(), 'leaky', { description: `see ${KEY}` });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('an import file whose mod.json holds the key is refused in the preview and the apply; nothing is installed or trusted', async () => {
    const file = { reinsMod: 1, files: { 'mod.json': JSON.stringify(manifest({ description: `use ${KEY}` })) } };
    const p = importPreview(env(), file);
    expect(p.status).toBe(400);
    expect(JSON.stringify(p.body)).not.toContain(KEY);
    const r = await importApply(env(), { file, trust: true });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    expect(entries()).toEqual([]);
    expect(fs.existsSync(path.join(home, 'mod-trust.json'))).toBe(false);
  });

  it('a key used as a property NAME of the manifest, nested or not, is refused too', async () => {
    const withBody = (body: Record<string, unknown>) => manifest({ efforts: [{ id: 'hi', label: 'High', body }], defaultEffort: 'hi' });
    const named = { reinsMod: 1, files: { 'mod.json': JSON.stringify(withBody({ [QK]: 'x' })) } };
    const r = await importApply(env(), { file: named, trust: true });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain(QK);
    const nested = { reinsMod: 1, files: { 'mod.json': JSON.stringify(withBody({ deep: { [QK]: 1 } })) } };
    expect((await importApply(env(), { file: nested, trust: true })).status).toBe(400);
    expect(entries()).toEqual([]);
    // the same manifest with a harmless name is accepted, so the refusal above is about the name
    const fine = { reinsMod: 1, files: { 'mod.json': JSON.stringify(withBody({ deep: { harmless: 1 } })) } };
    expect((await importPreview(env(), fine)).status).toBe(200);
  });

  it('an import file whose code holds the key is refused before it is hashed or trusted', async () => {
    const file = { reinsMod: 1, files: { 'mod.json': JSON.stringify(manifest({ main: 'index.js' })), 'index.js': `export const k = '${KEY}';\n` } };
    const r = await importApply(env(), { file, trust: true });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    expect(entries()).toEqual([]);
    expect(fs.existsSync(path.join(home, 'mod-trust.json'))).toBe(false);
  });
});

// ---- A6: a link to a network target is refused before it is followed (Windows paths on an injected filesystem)

describe('A6: confine looks at where a link points before it follows it', () => {
  const NET = '\\\\server.invalid\\share\\file.txt';
  interface Node { link?: string }
  /** `C:\proj` is the cwd. Entries: path to node. realpath follows a link to its target (a fake, so no real network is touched). */
  function fake(nodes: Record<string, Node>, o: { readlink?: boolean } = {}) {
    const calls: Array<[string, string]> = [];
    const lower = (p: string) => p.toLowerCase();
    const at = (p: string) => Object.entries(nodes).find(([k]) => lower(k) === lower(p))?.[1];
    const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const follow = (p: string): string => {
      for (const [k, v] of Object.entries(nodes)) {
        if (v.link !== undefined && (lower(p) === lower(k) || lower(p).startsWith(lower(k) + '\\'))) return follow(v.link + p.slice(k.length));
      }
      return p;
    };
    const fs: FsLike & { readlinkSync?: (p: string) => string } = {
      realpathSync: { native: (p: string) => { calls.push(['realpath', p]); if (!at(p) && !/^C:\\(proj)?$/i.test(p) && !follow(p).startsWith('\\\\')) throw enoent(); return follow(p); } },
      lstatSync: (p: string) => { calls.push(['lstat', p]); const n = at(p); if (!n && !/^C:\\(proj)?$/i.test(p)) throw enoent(); return { isSymbolicLink: () => n?.link !== undefined, isDirectory: () => n?.link === undefined, isFile: () => false }; },
      ...(o.readlink === false ? {} : { readlinkSync: (p: string) => { calls.push(['readlink', p]); return at(p)!.link!; } }),
    };
    return { fs, calls };
  }
  const ctx = (fs: FsLike) => ({ cwd: 'C:\\proj', home: 'C:\\home\\.reins', platform: 'win32' as const, fs });

  it('a local-looking link that leads to a network path is refused, and nothing is asked of the target', () => {
    const { fs, calls } = fake({ 'C:\\proj\\link': { link: NET } });
    const r = confine('link\\file.txt', ctx(fs));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/network, device or short-name paths/);
    // The only thing done to the link is to read it: it is not resolved, and the target is never named to the filesystem.
    expect(calls.filter(([, p]) => p.startsWith('\\\\'))).toEqual([]);
    expect(calls.filter(([k, p]) => k === 'realpath' && /link/i.test(p))).toEqual([]);
  });

  it('a link to a device path, and a link that reaches a network path through a second link, are refused too', () => {
    const device = fake({ 'C:\\proj\\d': { link: '\\\\?\\GLOBALROOT\\Device\\X' } });
    expect(confine('d', ctx(device.fs)).ok).toBe(false);
    const chain = fake({ 'C:\\proj\\a': { link: 'C:\\proj\\b' }, 'C:\\proj\\b': { link: NET } });
    const r = confine('a\\x', ctx(chain.fs));
    expect(r.ok).toBe(false);
    expect(chain.calls.filter(([, p]) => p.startsWith('\\\\'))).toEqual([]);
  });

  it('a cwd that is itself a link to a network path, or sits below one, is refused before it is followed', () => {
    const own = fake({ 'C:\\proj': { link: NET } });
    expect(confine('f.txt', ctx(own.fs)).ok).toBe(false);
    expect(own.calls.filter(([k, p]) => k === 'realpath' && /^C:\\proj/i.test(p))).toEqual([]);
    expect(own.calls.filter(([, p]) => p.startsWith('\\\\'))).toEqual([]);
    const below = fake({ 'C:\\up': { link: NET } });
    const r = confine('f.txt', { cwd: 'C:\\up\\sub', home: 'C:\\home\\.reins', platform: 'win32' as const, fs: below.fs });
    expect(r.ok).toBe(false);
    expect(below.calls.filter(([k, p]) => k === 'realpath' && /^C:\\up/i.test(p))).toEqual([]);
    expect(below.calls.filter(([, p]) => p.startsWith('\\\\'))).toEqual([]);
  });

  it('an ordinary link inside the project still works', () => {
    const { fs } = fake({ 'C:\\proj\\link': { link: 'C:\\proj\\real' }, 'C:\\proj\\real': {}, 'C:\\proj\\real\\f.txt': {} });
    const r = confine('link\\f.txt', ctx(fs));
    expect(r).toMatchObject({ ok: true, inside: true, abs: 'C:\\proj\\real\\f.txt' });
  });

  it('a link given as an extended-length local path is not mistaken for a network path', () => {
    const { fs } = fake({ 'C:\\proj\\link': { link: '\\\\?\\C:\\proj\\real' }, 'C:\\proj\\real': {}, 'C:\\proj\\real\\f.txt': {} });
    expect(confine('link\\f.txt', ctx(fs)).ok).toBe(true);
  });

  it('the second layer: a path that resolves to a network form is refused even when the link could not be read', () => {
    const { fs } = fake({ 'C:\\proj\\link': { link: NET } }, { readlink: false });
    const r = confine('link\\file.txt', ctx(fs));
    expect(r.ok).toBe(false);
  });
});
