// Milestone P, Task 29 phase D8: a filesystem root is refused as TEXT before the filesystem is asked anything, and refused again after the links are
// followed (an alias that resolves to a drive root), whatever the two homes are.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectFolderWords, rootFolderWords, TOO_WIDE_WORDS } from '../src/session.js';
import { startServer, type Server } from '../src/server.js';
import { openStore } from '../src/store.js';
import { PROBE, request } from './http-helpers.js';

const undo: Array<() => unknown> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of undo.splice(0).reverse()) await f();
});

describe('D8: the canonical folder is judged again', () => {
  it('an alias that resolves to a drive root is refused although both homes are on another drive', () => {
    vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike) => (String(p) === 'C:\\alias' ? 'C:\\' : String(p))) as typeof fs.realpathSync);
    expect(projectFolderWords('C:\\alias', 'D:\\home\\.reins', 'D:\\home')).toBe(TOO_WIDE_WORDS);
    // a link that resolves to a project folder is fine
    vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike) => (String(p) === 'C:\\alias' ? 'C:\\work\\proj' : String(p))) as typeof fs.realpathSync);
    expect(projectFolderWords('C:\\alias', 'D:\\home\\.reins', 'D:\\home')).toBeUndefined();
  });

  it('an alias that resolves to a share root is refused too', () => {
    vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike) => (String(p) === 'D:\\share-link' ? '\\\\server\\share' : String(p))) as typeof fs.realpathSync);
    expect(projectFolderWords('D:\\share-link', 'D:\\home\\.reins', 'D:\\home')).toBe(TOO_WIDE_WORDS);
  });
});

describe('D8: a root is refused before any filesystem call', () => {
  it('rootFolderWords never touches the filesystem', () => {
    const calls = [vi.spyOn(fs, 'statSync'), vi.spyOn(fs, 'realpathSync'), vi.spyOn(fs, 'existsSync')];
    for (const root of ['C:\\', 'X:/', '\\\\server\\share', '\\\\server\\share\\', '\\\\server', '/']) expect(rootFolderWords(root), root).toBe(TOO_WIDE_WORDS);
    expect(rootFolderWords('D:\\work\\proj')).toBeUndefined();
    for (const c of calls) expect(c).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'win32')('POST /api/sessions with a share root answers 400 with the words and never stats it', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29d-root-')));
    undo.push(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left */ } });
    const dir = path.join(root, '.reins');
    fs.mkdirSync(dir, { recursive: true });
    const store = openStore(':memory:');
    const srv: Server = await startServer({
      store, dir, env: {}, catalogDir: path.join(root, 'none'), probe: async () => PROBE,
      makeEngine: () => { throw new Error('no engine in this test'); },
    });
    undo.push(() => srv.close(), () => store.close());
    const seen: string[] = [];
    const stat = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, o?: unknown) => { seen.push(String(p)); return (stat as (p: fs.PathLike, o?: unknown) => unknown)(p, o); }) as typeof fs.statSync);
    const r = await request(srv, 'POST', '/api/sessions', { body: { cwd: '\\\\server\\share' } });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe(TOO_WIDE_WORDS);
    expect(seen.filter((p) => p.includes('server'))).toEqual([]);
  });
});
