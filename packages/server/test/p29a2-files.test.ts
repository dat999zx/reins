// Milestone P, Task 29 phase A, fix round (second Codex review): the import inspects decoded values (1), Write and Edit refuse a key in the path (2) and
// in a Markdown file or a replace-all (11), and confinement looks at every link from the filesystem root before it resolves anything (4).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Policy } from '@reins/core';
import { importApply, importPreview, type ModEnv } from '../src/mods/actions.js';
import { confine, type FsLike } from '../src/loop/paths.js';
import { findTool, type ToolCtx } from '../src/loop/tools.js';
import { startMods } from '../src/engines.js';
import { Redactor, setKey } from '../src/secrets.js';
import type { Mods } from '../src/mods/types.js';

const WRITE_MODE: Policy = { mode: 'write', guards: [], allowShell: true };
const REFUSED = 'That content holds a saved key, so it was not written.';
const KEY_IN_MOD = 'That text holds a key Reins knows, so nothing was installed. Keys go in Settings > Providers, never in a mod file.';
// Keys the JSON text form changes: a backslash and a quote are escaped by JSON.stringify; the third has non-ASCII characters (from code points).
const KEYS: Array<[string, string]> = [
  ['a backslash', 'sk-back\\slash-0123456789'],
  ['a quote', 'sk-"quoted"-0123456789'],
  ['non-ASCII characters', `sk-${String.fromCodePoint(0xe9, 0x2603, 0x1f600)}-0123456789`],
];

let tmp = '';
beforeEach(() => { tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29a2-'))); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe('fix 1: the import looks at decoded names, texts and property names, not at a re-serialized container', () => {
  let home = '';
  let mods: Mods;
  let redactor: Redactor;
  beforeEach(async () => {
    home = path.join(tmp, '.reins');
    fs.mkdirSync(home, { recursive: true });
    mods = await startMods({ dir: home, env: {} });
  });
  afterEach(() => mods.dispose());
  const envFor = (key: string): ModEnv => {
    setKey(home, 'p', key);
    redactor = new Redactor({ home, env: {}, keyEnvNames: () => [] });
    return {
      home, catalogDir: path.join(tmp, 'none'), mods, consent: { has: () => false, grant: () => {}, revoke: () => {} },
      send: async () => new Response(''), env: {}, redact: (t) => t, holdsSecret: redactor.has,
    };
  };
  const manifest = (over: Record<string, unknown> = {}) => ({
    reins: 1, id: 'leaky', kind: 'provider', version: '1.0.0', label: 'Leaky', protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1',
    defaultModel: 'm', models: [{ id: 'm' }], auth: { style: 'none', keyEnv: [] }, ...over,
  });
  const entries = () => (fs.existsSync(path.join(home, 'mods')) ? fs.readdirSync(path.join(home, 'mods')) : []);

  describe.each(KEYS)('a key with %s', (_n, key) => {
    const cases: Array<[string, () => unknown]> = [
      ['a nested manifest value', () => ({ reinsMod: 1, files: { 'mod.json': JSON.stringify(manifest({ headers: { 'x-a': `use ${key}` } })) } })],
      ['a property name of the manifest', () => ({ reinsMod: 1, files: { 'mod.json': JSON.stringify(manifest({ [key]: 1 })) } })],
      ['a file name', () => ({ reinsMod: 1, files: { 'mod.json': JSON.stringify(manifest()), [`${key}.txt`]: 'x' } })],
      ['another file text', () => ({ reinsMod: 1, files: { 'mod.json': JSON.stringify(manifest()), 'notes.txt': `see ${key}` } })],
      ['a property name of the envelope', () => ({ reinsMod: 1, files: { 'mod.json': JSON.stringify(manifest()) }, [key]: 1 })],
      ['the envelope given as text', () => JSON.stringify({ reinsMod: 1, files: { 'mod.json': JSON.stringify(manifest({ description: key })) } })],
    ];
    it.each(cases)('%s is refused in the preview and the apply, with nothing installed or trusted', async (_where, build) => {
      const env = envFor(key);
      const p = importPreview(env, build());
      expect([p.status, (p.body as { error?: string }).error]).toEqual([400, KEY_IN_MOD]);
      const a = await importApply(env, { file: build(), trust: true });
      expect([a.status, (a.body as { error?: string }).error]).toEqual([400, KEY_IN_MOD]);
      expect(JSON.stringify([p.body, a.body])).not.toContain(key);
      expect(entries()).toEqual([]);
      expect(fs.existsSync(path.join(home, 'mod-trust.json'))).toBe(false);
    });
  });

  it('a file without a key still previews', () => {
    const env = envFor('sk-unrelated-0123456789');
    expect(importPreview(env, { reinsMod: 1, files: { 'mod.json': JSON.stringify(manifest()) } }).status).toBe(200);
  });
});

describe('fixes 2 and 11: Write and Edit refuse a key in the path, in a Markdown file, and in a replace-all', () => {
  const KEY = 'sk-test-0123456789abcdef';
  let cwd = '';
  beforeEach(() => { cwd = path.join(tmp, 'proj'); fs.mkdirSync(cwd); });
  const ctxOf = (): ToolCtx => ({
    cwd, home: path.join(tmp, 'home'), policy: () => WRITE_MODE, signal: new AbortController().signal, redact: (t) => t, redactAll: (t) => t,
    platform: process.platform, holdsSecret: (t) => t.includes(KEY),
  });
  async function run(name: string, input: Record<string, unknown>) {
    const ctx = ctxOf();
    const at = confine(input.file_path as string, { cwd: ctx.cwd, home: ctx.home, platform: ctx.platform });
    if (!at.ok) throw new Error(at.reason);
    return await findTool(name)!.run!(input, ctx, { abs: at.abs, root: at.root });
  }

  it('Write with a key in the file name creates nothing, however ordinary the content', async () => {
    const out = await run('Write', { file_path: `${KEY}.txt`, content: 'hello' });
    expect(out).toEqual({ text: REFUSED, isError: true });
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it('Write with a key in a folder name makes no folder', async () => {
    const out = await run('Write', { file_path: `${KEY}/a.txt`, content: 'hello' });
    expect(out.text).toBe(REFUSED);
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it('Edit of a file whose name holds the key is refused and the file is unchanged', async () => {
    fs.writeFileSync(path.join(cwd, `${KEY}.txt`), 'before');
    const out = await run('Edit', { file_path: `${KEY}.txt`, old_string: 'before', new_string: 'after' });
    expect(out).toEqual({ text: REFUSED, isError: true });
    expect(fs.readFileSync(path.join(cwd, `${KEY}.txt`), 'utf8')).toBe('before');
  });

  it('a Markdown file with the key is refused too', async () => {
    const out = await run('Write', { file_path: 'notes.md', content: `# notes\n${KEY}\n` });
    expect(out.text).toBe(REFUSED);
    expect(fs.existsSync(path.join(cwd, 'notes.md'))).toBe(false);
  });

  it('a replace-all that makes the key is refused, and the file is unchanged', async () => {
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'x = PLACE\ny = PLACE\n');
    const out = await run('Edit', { file_path: 'a.txt', old_string: 'PLACE', new_string: KEY, replace_all: true });
    expect(out.text).toBe(REFUSED);
    expect(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('x = PLACE\ny = PLACE\n');
  });

  it('every tool that writes is covered: Write and Edit are the only write-class file tools', () => {
    const writers = ['Read', 'Write', 'Edit', 'Glob', 'Grep'].filter((n) => findTool(n)!.class === 'write');
    expect(writers).toEqual(['Write', 'Edit']);
  });
});

// ---- 4: confinement looks at every link from the filesystem root before it resolves anything

describe('fix 4: the cwd, the home and every ancestor are inspected before they are followed', () => {
  const NET = '\\\\server.invalid\\share\\dir';
  interface Node { link?: string }
  function fake(nodes: Record<string, Node>) {
    const calls: Array<[string, string]> = [];
    const lower = (p: string) => p.toLowerCase();
    const at = (p: string) => Object.entries(nodes).find(([k]) => lower(k) === lower(p))?.[1];
    const isRoot = (p: string) => /^[a-z]:\\$/i.test(p);
    const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const follow = (p: string): string => {
      for (const [k, v] of Object.entries(nodes)) {
        if (v.link !== undefined && (lower(p) === lower(k) || lower(p).startsWith(lower(k) + '\\'))) return follow(v.link + p.slice(k.length));
      }
      return p;
    };
    const fs: FsLike = {
      realpathSync: { native: (p: string) => { calls.push(['realpath', p]); const r = follow(p); if (!r.startsWith('\\\\') && !at(r) && !isRoot(r)) throw enoent(); return r; } },
      lstatSync: (p: string) => { calls.push(['lstat', p]); const n = at(p); if (!n && !isRoot(p)) throw enoent(); return { isSymbolicLink: () => n?.link !== undefined, isDirectory: () => n?.link === undefined, isFile: () => false }; },
      readlinkSync: (p: string) => { calls.push(['readlink', p]); return at(p)!.link!; },
    };
    return { fs, calls };
  }
  const named = (calls: Array<[string, string]>) => calls.filter(([, p]) => p.startsWith('\\\\'));

  it('a cwd that is a link to a network path is refused, and the target is never named to the filesystem', () => {
    const { fs, calls } = fake({ 'C:\\link': { link: NET } });
    const r = confine('f.txt', { cwd: 'C:\\link', home: 'C:\\home\\.reins', platform: 'win32', fs });
    expect(r.ok).toBe(false);
    expect(named(calls)).toEqual([]);
    expect(calls.filter(([k, p]) => k === 'realpath' && /link/i.test(p))).toEqual([]);
  });

  it('a cwd below such a link is refused the same way', () => {
    const { fs, calls } = fake({ 'C:\\link': { link: NET }, 'C:\\link\\sub': {} });
    const r = confine('f.txt', { cwd: 'C:\\link\\sub', home: 'C:\\home\\.reins', platform: 'win32', fs });
    expect(r.ok).toBe(false);
    expect(named(calls)).toEqual([]);
    expect(calls.filter(([k, p]) => k === 'realpath' && /link/i.test(p))).toEqual([]);
  });

  it('a home below such a link is refused the same way', () => {
    const { fs, calls } = fake({ 'C:\\proj': {}, 'C:\\h': { link: NET } });
    const r = confine('f.txt', { cwd: 'C:\\proj', home: 'C:\\h\\.reins', platform: 'win32', fs });
    expect(r.ok).toBe(false);
    expect(named(calls)).toEqual([]);
  });

  it('a normal cwd under an ordinary link ancestor still works', () => {
    const { fs } = fake({ 'C:\\work': { link: 'D:\\real' }, 'D:\\real': {}, 'D:\\real\\proj': {}, 'D:\\real\\proj\\f.txt': {} });
    const r = confine('f.txt', { cwd: 'C:\\work\\proj', home: 'C:\\home\\.reins', platform: 'win32', fs });
    expect(r).toMatchObject({ ok: true, inside: true, abs: 'D:\\real\\proj\\f.txt' });
  });
});
