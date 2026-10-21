// Milestone P, Task 29 phase A, over real HTTP: every JSON reply is sanitized at the boundary (A2), a refused identity write is a plain 4xx (A9),
// and a project folder that is the user's home, above it, or a drive root is refused (A10). Synthetic keys only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Redactor, setKey } from '../src/secrets.js';
import { startServer, type Server } from '../src/server.js';
import { openStore, redactingStore } from '../src/store.js';
import { PROBE, request, type Res } from './http-helpers.js';

const KEY = 'sk-test-0123456789abcdef';
const undo: Array<() => unknown> = [];
afterEach(async () => { for (const f of undo.splice(0).reverse()) await f(); });

async function boot(o: { pickError?: string; userHome?: string; prep?: (dir: string, root: string) => void } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29a-http-')));
  undo.push(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left */ } });
  const dir = path.join(root, '.reins');
  const cwd = path.join(root, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(cwd);
  o.prep?.(dir, root);
  setKey(dir, 'p', KEY);
  const redactor = new Redactor({ home: dir, env: {}, keyEnvNames: () => [] });
  const store = redactingStore(openStore(':memory:'), redactor);
  const srv: Server = await startServer({
    store, dir, redactor, env: {}, catalogDir: path.join(root, 'none'), ...(o.userHome ? { userHome: o.userHome } : {}), probe: async () => PROBE,
    makeEngine: () => { throw new Error('no engine in this test'); },
    ...(o.pickError ? { pickFolder: async () => { throw new Error(`picker said ${o.pickError}`); } } : {}),
  });
  undo.push(() => srv.close(), () => store.close());
  const api = (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<Res> => request(srv, method, url, body === undefined ? {} : { body });
  return { root, dir, cwd, srv, api, store };
}
const session = async (w: Awaited<ReturnType<typeof boot>>) => {
  const r = await w.api('POST', '/api/sessions', { cwd: w.cwd });
  if (r.status !== 200) throw new Error(`POST /api/sessions: ${r.status} ${r.text}`);
  return r.json.id as string;
};

describe('A2: no reply leaves with a known key in it', () => {
  it('an unknown provider id that is a key is not echoed raw', async () => {
    const w = await boot();
    const r = await w.api('POST', '/api/sessions', { cwd: w.cwd, engine: KEY });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain(KEY);
  });

  it('an unknown provider id that fails the id pattern is not quoted at all', async () => {
    const w = await boot();
    const r = await w.api('POST', '/api/sessions', { cwd: w.cwd, engine: `Bad_${KEY}` });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: 'That provider is not installed.' });
  });

  it('a workflow file that holds the key is read back without it', async () => {
    const w = await boot();
    const id = await session(w);
    const file = path.join(w.cwd, '.reins', 'workflows', 'leak.reins.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\nname: leak\n---\n\n# Step\n\nUse ${KEY} here.\n`);
    const r = await w.api('GET', `/api/sessions/${id}/workflow?path=${encodeURIComponent(file)}`);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(KEY);
  });

  it('a preview of text that holds the key answers without it', async () => {
    const w = await boot();
    const id = await session(w);
    const file = path.join(w.cwd, '.reins', 'workflows', 'p.reins.md');
    const r = await w.api('POST', `/api/sessions/${id}/preview`, { path: file, text: `---\nname: p\n---\n\n# Step\n\n${KEY}\n` });
    expect(r.text).not.toContain(KEY);
  });

  it('the list of workflows does not show a file name that is a key', async () => {
    const w = await boot();
    const folder = path.join(w.cwd, '.reins', 'workflows');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${KEY}.reins.md`), 'x');
    const r = await w.api('GET', `/api/workflows?cwd=${encodeURIComponent(w.cwd)}`);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(KEY);
  });

  it('a 501 made from a thrown error does not carry the key', async () => {
    const w = await boot({ pickError: KEY });
    const r = await w.api('POST', '/api/pick-folder', {});
    expect(r.status).toBe(501);
    expect(r.text).not.toContain(KEY);
  });
});

describe('A9: a key in an identity field is a plain 400, not a 500', () => {
  it('session create with a folder whose name is the key', async () => {
    const w = await boot();
    const bad = path.join(w.root, KEY);
    fs.mkdirSync(bad);
    const r = await w.api('POST', '/api/sessions', { cwd: bad });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('That value contains a saved key, so it was not saved.');
    expect(r.text).not.toContain(KEY);
  });

  it('running a workflow whose path holds the key is answered 400 before OK, and no run starts (fix round, item 8)', async () => {
    const w = await boot();
    const id = await session(w);
    const file = path.join(w.cwd, `${KEY}.reins.md`);
    fs.writeFileSync(file, '---\nreins: 1\nname: a\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n## phase one\n> Do it.\n');
    const r = await w.api('POST', `/api/sessions/${id}/run`, { path: file });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('That value contains a saved key, so it was not saved.');
    expect(r.text).not.toContain(KEY);
    expect(w.store.readLog(id).filter((x) => x.type === 'status' || x.type === 'run_finished')).toEqual([]);
  });

  it('consent grant for an origin that holds the key', async () => {
    const w = await boot({
      prep: (dir) => {
        const folder = path.join(dir, 'mods', 'leaky');
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, 'mod.json'), JSON.stringify({
          reins: 1, id: 'leaky', kind: 'provider', version: '1.0.0', label: 'Leaky', protocol: 'openai-chat', baseUrl: `https://${KEY}.example.invalid/v1`,
          defaultModel: 'm', models: [{ id: 'm' }], auth: { style: 'none', keyEnv: [] },
        }));
      },
    });
    const r = await w.api('POST', '/api/mods/leaky/consent', { origin: `https://${KEY}.example.invalid` });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain(KEY);
  });

  it('an editor-state write for a folder whose name is the key', async () => {
    const w = await boot();
    const r = await w.api('PUT', '/api/editor-state', { cwd: path.join(w.root, KEY), state: { a: 1 } });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain(KEY);
  });
});

describe('A10: a project folder is not the whole home folder or a drive', () => {
  const WORDS = 'Pick a project folder, not your whole home folder or a drive.';
  // A home of its own in a temp folder, away from the Reins folder, so only the home rule can refuse.
  const fakeHome = () => {
    const homeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29a-home-')));
    undo.push(() => { try { fs.rmSync(homeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left */ } });
    const home = path.join(homeRoot, 'home');
    fs.mkdirSync(path.join(home, 'proj'), { recursive: true });
    return { homeRoot, home };
  };
  it.each(['home', 'parent', 'drive'] as const)('refuses the %s folder', async (which) => {
    const h = fakeHome();
    const w = await boot({ userHome: h.home });
    const cwd = which === 'home' ? h.home : which === 'parent' ? h.homeRoot : path.parse(h.homeRoot).root;
    const r = await w.api('POST', '/api/sessions', { cwd });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe(WORDS);
  });

  it('refuses a folder that contains the Reins folder', async () => {
    const h = fakeHome();
    const w = await boot({ userHome: h.home });
    const r = await w.api('POST', '/api/sessions', { cwd: w.root });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe(WORDS);
  });

  it('accepts a folder inside the home folder', async () => {
    const h = fakeHome();
    const w = await boot({ userHome: h.home });
    const r = await w.api('POST', '/api/sessions', { cwd: path.join(h.home, 'proj') });
    expect(r.status).toBe(200);
  });
});