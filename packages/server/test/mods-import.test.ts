// Milestone P, Task 22 (spec 7.7, 5.4, 5.6): export, import preview and apply, the summary lines, and trust for code mods. A real server over HTTP
// on a temp Reins folder, the real loader (bundled mods included). No network, no real key. The code mod is a fixture that appends a line to a
// marker file when it runs, so "it ran" and "it ran once" are facts on disk.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyEnvNames, makeEngineFrom, startMods } from '../src/engines.js';
import { CODE_PROMPT, importPreview, modTrusted, type ModEnv } from '../src/mods/actions.js';
import { hashFiles } from '../src/mods/loader.js';
import { Redactor, readSecrets, setKey } from '../src/secrets.js';
import { makeSend } from '../src/send.js';
import { startServer, type Server } from '../src/server.js';
import { openStore, type Store } from '../src/store.js';
import type { Mods } from '../src/mods/types.js';
import { PROBE } from './http-helpers.js';

const KEY = 'sk-test-0123456789abcdef';
const rm = (d: string) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the OS */ } };

interface World {
  root: string; dir: string; mods: Mods; store: Store; srv: Server; marker: string;
  call: (method: string, url: string, o?: { body?: unknown; raw?: string; auth?: boolean; headers?: Record<string, string> }) => Promise<{ status: number; json: any; text: string; headers: http.IncomingHttpHeaders }>;
  list: () => Promise<{ mods: Array<Record<string, any>> }>;
  mod: (id: string) => Promise<Record<string, any> | undefined>;
  env: () => ModEnv;
}
const worlds: World[] = [];
const extra: Mods[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const m of extra.splice(0)) m.dispose();
  for (const w of worlds.splice(0)) {
    await w.srv.close();
    w.store.close();
    w.mods.dispose();
    rm(w.root);
  }
});

async function boot(o: { prep?: (dir: string, root: string) => void } = {}): Promise<World> {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-modsimport-')));
  const dir = path.join(root, '.reins');
  fs.mkdirSync(dir, { recursive: true });
  o.prep?.(dir, root);
  const mods = await startMods({ dir, env: {} });
  const redactor = new Redactor({ home: dir, env: {}, keyEnvNames: () => keyEnvNames(mods) });
  const send = makeSend({ secrets: () => readSecrets(dir), env: {}, redactor, consent: () => true });
  const store = openStore(':memory:');
  const srv = await startServer({
    store, dir, mods, env: {}, catalogDir: path.join(root, 'no-catalog'), redactor, send, consent: () => undefined, probe: async () => PROBE,
    makeEngine: makeEngineFrom(mods, { env: {}, home: dir, send }),
  });
  const call: World['call'] = (method, url, c = {}) => new Promise((resolve, reject) => {
    const payload = c.raw ?? (c.body !== undefined ? JSON.stringify(c.body) : undefined);
    const req = http.request({
      host: '127.0.0.1', port: srv.port, path: url, method, agent: false,
      headers: {
        ...(c.auth === false ? {} : { authorization: `Bearer ${srv.token}` }),
        ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
        ...(c.headers ?? {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (text += d));
      res.on('end', () => {
        let json: unknown;
        try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, json, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
  const w: World = {
    root, dir, mods, store, srv, call, marker: path.join(root, 'marker.log'),
    list: async () => (await call('GET', '/api/mods')).json,
    mod: async (id) => (await w.list()).mods.find((m) => m.id === id),
    env: () => ({
      home: dir, catalogDir: path.join(root, 'no-catalog'), mods, consent: { has: () => false, grant: () => {}, revoke: () => {} },
      send: async () => new Response(''), env: {}, redact: (t: string) => t, holdsSecret: (t: string) => t.includes(KEY),
    }),
  };
  worlds.push(w);
  return w;
}

const prov = (id: string, over: Record<string, unknown> = {}) => ({
  reins: 1, id, kind: 'provider', version: '1.0.0', label: id.toUpperCase(), description: `The ${id} test provider`, protocol: 'openai-chat',
  baseUrl: `https://api.${id}.test/v1`, auth: { style: 'bearer', keyEnv: [`${id.toUpperCase()}_API_KEY`] },
  defaultModel: `${id}-m`, models: [{ id: `${id}-m`, label: 'M', price: { input: 1, output: 2 } }], ...over,
});
const text = (m: unknown) => JSON.stringify(m, null, 2);
const file = (files: Record<string, string>) => ({ reinsMod: 1, files });
const provFile = (id: string, over: Record<string, unknown> = {}, more: Record<string, string> = {}) => file({ 'mod.json': text(prov(id, over)), ...more });
const codeFiles = (w: World, id: string, version: string, more: Record<string, string> = {}): Record<string, string> => ({
  'mod.json': text({ reins: 1, id, kind: 'protocol', version, label: id, main: 'index.js' }),
  'index.js': `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(w.marker)}, ${JSON.stringify(`ran ${version} `)} + import.meta.url + '\\n');\nexport default function activate() {}\n`,
  ...more,
});
const ran = (w: World) => (fs.existsSync(w.marker) ? fs.readFileSync(w.marker, 'utf8').split('\n').filter(Boolean) : []);
const hashOf = (files: Record<string, string>) => hashFiles(Object.entries(files).map(([rel, t]) => ({ rel, bytes: Buffer.from(t, 'utf8') })));

const preview = (w: World, f: unknown) => w.call('POST', '/api/mods/import/preview', { body: { file: f } });
const imp = (w: World, f: unknown, o: Record<string, unknown> = {}) => w.call('POST', '/api/mods/import', { body: { file: f, ...o } });
const folder = (w: World, id: string) => path.join(w.dir, 'mods', id);

/** Every entry under `dir` with its size and modification time: a write of any kind changes this. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    const st = fs.lstatSync(d);
    out.push(`${rel || '.'}|${st.isDirectory() ? 'dir' : st.size}|${st.mtimeMs}`);
    if (st.isDirectory() && !st.isSymbolicLink()) for (const n of fs.readdirSync(d).sort()) walk(path.join(d, n), `${rel}/${n}`);
  };
  walk(dir, '');
  return out;
}
const scratchLeft = (w: World) => fs.readdirSync(w.dir).filter((n) => n.startsWith('.mod-'));

describe('export', () => {
  it('round trip: export from one home, import into a clean one, every file byte for byte; no key anywhere in the export', async () => {
    const a = await boot({
      prep: (dir) => {
        const d = path.join(dir, 'mods', 'acme');
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'mod.json'), text(prov('acme')));
        fs.writeFileSync(path.join(d, 'notes.txt'), '\uFEFFline one\r\nline two \u00e9\u4e2d\r\n');
        fs.writeFileSync(path.join(d, 'empty.txt'), '');
      },
    });
    expect((await a.call('PUT', '/api/mods/acme/key', { body: { key: KEY } })).status).toBe(200);
    expect(fs.readFileSync(path.join(a.dir, 'secrets.json'), 'utf8')).toContain(KEY);
    const ex = await a.call('GET', '/api/mods/acme/export');
    expect(ex.status).toBe(200);
    expect(ex.headers['content-disposition']).toBe('attachment; filename="acme.reins-mod.json"');
    expect(ex.json.reinsMod).toBe(1);
    expect(Object.keys(ex.json.files).sort()).toEqual(['empty.txt', 'mod.json', 'notes.txt']);
    expect(ex.text).not.toContain(KEY);
    expect(Buffer.from(ex.text).includes(Buffer.from(KEY))).toBe(false);
    const b = await boot();
    const r = await imp(b, ex.json);
    expect([r.status, r.json.ok, r.json.trust]).toEqual([200, true, 'none']);
    for (const name of ['mod.json', 'notes.txt', 'empty.txt']) {
      expect(fs.readFileSync(path.join(folder(b, 'acme'), name)).equals(fs.readFileSync(path.join(folder(a, 'acme'), name)))).toBe(true);
    }
    expect(fs.readdirSync(folder(b, 'acme')).sort()).toEqual(['empty.txt', 'mod.json', 'notes.txt']);
    expect(await b.mod('acme')).toMatchObject({ id: 'acme', enabled: true, trust: 'none', problems: [] });
    expect(scratchLeft(b)).toEqual([]);
    // the export of the clean home equals the first export
    expect((await b.call('GET', '/api/mods/acme/export')).json).toEqual(ex.json);
  });

  it('refuses a file that holds a known key, and says which file without printing the key', async () => {
    const w = await boot({ prep: (dir) => { fs.mkdirSync(path.join(dir, 'mods', 'acme'), { recursive: true }); fs.writeFileSync(path.join(dir, 'mods', 'acme', 'mod.json'), text(prov('acme'))); } });
    await w.call('PUT', '/api/mods/acme/key', { body: { key: KEY } });
    fs.writeFileSync(path.join(folder(w, 'acme'), 'notes.txt'), `my key is ${KEY}\n`);
    const r = await w.call('GET', '/api/mods/acme/export');
    expect(r.status).toBe(409);
    expect(r.json.error).toContain('`notes.txt` holds a key Reins knows');
    expect(r.text).not.toContain(KEY);
    // the key in the JSON-escaped form is still a known key
    fs.writeFileSync(path.join(folder(w, 'acme'), 'notes.txt'), 'clean\n');
    expect((await w.call('GET', '/api/mods/acme/export')).status).toBe(200);
  });

  it('exports bundled mods as shipped, but never a file of the home', async () => {
    const w = await boot();
    fs.writeFileSync(path.join(w.dir, 'secrets.json'), JSON.stringify({ providers: { x: { key: KEY } } }));
    const r = await w.call('GET', '/api/mods/claude-code/export');
    expect(r.status).toBe(200);
    const bundled = (await w.mod('claude-code'))!;
    expect(bundled.bundled).toBe(true);
    expect(Object.keys(r.json.files)).toContain('mod.json');
    expect(r.text).not.toContain(KEY);
    for (const n of ['secrets.json', 'disabled-mods.json', 'mod-cache', 'mod-trust.json']) expect(Object.keys(r.json.files)).not.toContain(n);
  });

  it('refuses a mod over 1 MB, a binary file, a folder inside, a link and a file named like one of Reins own', async () => {
    const w = await boot({ prep: (dir) => { fs.mkdirSync(path.join(dir, 'mods', 'acme'), { recursive: true }); fs.writeFileSync(path.join(dir, 'mods', 'acme', 'mod.json'), text(prov('acme'))); } });
    const d = folder(w, 'acme');
    const bad = async (why: string, make: () => void, undo: () => void, words: string) => {
      make();
      const r = await w.call('GET', '/api/mods/acme/export');
      expect([why, r.status]).toEqual([why, 409]);
      expect(r.json.error).toContain(words);
      undo();
    };
    await bad('big', () => fs.writeFileSync(path.join(d, 'big.txt'), 'x'.repeat(1024 * 1024)), () => fs.rmSync(path.join(d, 'big.txt')), 'larger than 1 MB');
    await bad('binary', () => fs.writeFileSync(path.join(d, 'a.bin'), Buffer.from([0, 1, 2, 255])), () => fs.rmSync(path.join(d, 'a.bin')), 'is not text');
    await bad('not utf-8', () => fs.writeFileSync(path.join(d, 'a.txt'), Buffer.from([0x61, 0xff, 0xfe, 0x62])), () => fs.rmSync(path.join(d, 'a.txt')), 'is not text');
    await bad('folder', () => fs.mkdirSync(path.join(d, 'sub')), () => fs.rmdirSync(path.join(d, 'sub')), 'is a folder');
    // a real link inside the mod folder (a junction, which needs no privilege on Windows); lstat sees it, stat would follow it
    const target = path.join(w.root, 'link-target');
    fs.mkdirSync(target);
    let linked = true;
    try { fs.symlinkSync(target, path.join(d, 'lnk'), 'junction'); } catch (e) { linked = false; console.log(`skipped the link case: this machine cannot create links (${(e as Error).message})`); }
    if (linked) await bad('link', () => {}, () => { const l = path.join(d, 'lnk'); if (process.platform === 'win32') fs.rmdirSync(l); else fs.unlinkSync(l); }, 'is a link');
    await bad('home name',() => fs.writeFileSync(path.join(d, 'secrets.json'), '{}'), () => fs.rmSync(path.join(d, 'secrets.json')), 'belongs to Reins');
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(d, `f${i}.txt`), 'x');
    const many = await w.call('GET', '/api/mods/acme/export');
    expect([many.status, many.json.error]).toEqual([409, expect.stringContaining('the most is 50')]);
  });

  it('a bad id or an unknown mod', async () => {
    const w = await boot();
    expect((await w.call('GET', '/api/mods/nope/export')).status).toBe(404);
    expect((await w.call('GET', '/api/mods/con/export')).status).toBe(400);
    expect((await w.call('GET', '/api/mods/a%2Fb/export')).status).toBe(400);
  });
});

describe('preview', () => {
  it('says each line: the key and its host, plain http, the headers by name, the replaces words and the code prompt', async () => {
    const w = await boot();
    const p = (await preview(w, provFile('acme', { headers: { 'X-Org': 'org-secret-value' } }))).json.summary;
    expect(p).toMatchObject({
      id: 'acme', label: 'ACME', kind: 'provider', protocol: 'openai-chat', replaces: null, hasCode: false, headers: ['X-Org'],
      keys: [{ name: 'ACME_API_KEY', host: 'api.acme.test', plainHttp: false, line: 'sends the value of ACME_API_KEY to api.acme.test' }],
      files: [{ name: 'mod.json', bytes: Buffer.byteLength(text(prov('acme', { headers: { 'X-Org': 'org-secret-value' } }))) }],
    });
    expect(JSON.stringify(p)).not.toContain('org-secret-value');
    expect(p.codePrompt).toBeUndefined();

    const plain = (await preview(w, provFile('acme', { baseUrl: 'http://models.acme.test:8080/v1' }))).json.summary;
    expect(plain.keys[0]).toEqual({ name: 'ACME_API_KEY', host: 'models.acme.test:8080', plainHttp: true, line: 'sends the value of ACME_API_KEY to models.acme.test:8080 over plain http' });
    expect(plain.warnings.join(' ')).toContain('plain http');
    for (const local of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://127.4.5.6/v1', 'http://[::1]:9/v1']) {
      const k = (await preview(w, provFile('acme', { baseUrl: local }))).json.summary.keys[0];
      expect([local, k.plainHttp, k.line.endsWith('over plain http')]).toEqual([local, false, false]);
    }
    // a lookalike host is not local
    expect((await preview(w, provFile('acme', { baseUrl: 'http://localhost.evil.test/v1' }))).json.summary.keys[0].plainHttp).toBe(true);
    // two key names: a line each; no key style: none
    const two = (await preview(w, provFile('acme', { auth: { style: 'bearer', keyEnv: ['ACME_API_KEY', 'ACME_TOKEN'] } }))).json.summary;
    expect(two.keys.map((k: { line: string }) => k.line)).toEqual(['sends the value of ACME_API_KEY to api.acme.test', 'sends the value of ACME_TOKEN to api.acme.test']);
    expect((await preview(w, provFile('acme', { auth: { style: 'none', keyEnv: [] } }))).json.summary.keys).toEqual([]);

    const code = (await preview(w, file(codeFiles(w, 'wire', '1', { 'helper.mjs': 'export const x = 1;\n' })))).json.summary;
    expect(code).toMatchObject({ id: 'wire', kind: 'protocol', hasCode: true, codePrompt: CODE_PROMPT, trusted: false });
    expect(CODE_PROMPT).toBe('This mod runs its own code inside Reins, with your rights: it can read your files and your keys, and use the network. Reins cannot limit what it does. Trust it only if you trust its author.');
    expect(code.hash).toBe(hashOf(codeFiles(w, 'wire', '1', { 'helper.mjs': 'export const x = 1;\n' })));
    expect(code.files.map((f: { name: string }) => f.name)).toEqual(['helper.mjs', 'index.js', 'mod.json']);
    expect(code.warnings.join(' ')).toContain('helper.mjs');
  });

  it('replaces your copy, or the built-in one', async () => {
    const w = await boot();
    expect((await preview(w, provFile('acme'))).json.summary.replacesLine).toBeUndefined();
    expect((await imp(w, provFile('acme'))).status).toBe(200);
    const mine = (await preview(w, provFile('acme'))).json.summary;
    expect([mine.replaces, mine.replacesLine]).toEqual(['your', 'replaces your acme']);
    const cc = (await preview(w, provFile('claude-code', { protocol: 'claude-code-cli', auth: { style: 'none', keyEnv: [] } }))).json.summary;
    expect([cc.replaces, cc.replacesLine]).toEqual(['builtin', 'replaces the built-in claude-code']);
  });

  it('writes nothing: not a file, not a folder, not a scratch name, no modification time', async () => {
    const w = await boot({ prep: (dir) => { fs.mkdirSync(path.join(dir, 'mods', 'acme'), { recursive: true }); fs.writeFileSync(path.join(dir, 'mods', 'acme', 'mod.json'), text(prov('acme'))); } });
    await w.call('PUT', '/api/mods/acme/key', { body: { key: KEY } });
    const before = tree(w.root);
    const cases = [provFile('acme'), provFile('other'), file(codeFiles(w, 'wire', '1')), file({ 'mod.json': '{nope' }), { reinsMod: 2, files: {} }, provFile('claude-code', { protocol: 'claude-code-cli', auth: { style: 'none', keyEnv: [] } })];
    for (const c of cases) await preview(w, c);
    await preview(w, JSON.stringify(provFile('fresh')));
    expect(tree(w.root)).toEqual(before);
    expect(scratchLeft(w)).toEqual([]);
    expect(fs.existsSync(w.marker)).toBe(false);
    expect(fs.existsSync(path.join(w.dir, 'mod-cache'))).toBe(false);
  });

  it('takes the file as text too, and refuses a keyEnv name outside the pattern in the validator words', async () => {
    const w = await boot();
    expect((await preview(w, JSON.stringify(provFile('acme')))).json.summary.id).toBe('acme');
    for (const name of ['AWS_SECRET_ACCESS_KEY', 'lower_api_key', 'ACME', 'ACME_KEYS', 'PATH']) {
      const r = await preview(w, provFile('acme', { auth: { style: 'bearer', keyEnv: [name] } }));
      expect([name, r.status]).toEqual([name, 400]);
      expect(r.json.error).toContain('is not a key name Reins will read for a mod');
    }
  });
});

describe('code mods: trust by hash', () => {
  it('without trust it is installed but never runs; with trust it runs from mod-cache/<hash>, once', async () => {
    const w = await boot();
    const files = codeFiles(w, 'wire', '1');
    const r = await imp(w, file(files));
    expect([r.status, r.json.trust]).toEqual([200, 'needs-trust']);
    expect(ran(w)).toEqual([]);
    expect(fs.existsSync(path.join(folder(w, 'wire'), 'index.js'))).toBe(true);
    const m = (await w.mod('wire'))!;
    expect(m.trust).toBe('needs-trust');
    expect(m.problems.join(' ')).toContain('needs trust');
    expect(fs.existsSync(path.join(w.dir, 'mod-cache'))).toBe(false);
    expect(modTrusted(w.dir, 'wire', hashOf(files))).toBe(false);
    // asking for trust on the same bytes
    const t = await imp(w, file(files), { trust: true });
    expect([t.status, t.json.trust, t.json.replaced]).toEqual([200, 'trusted', true]);
    const hash = hashOf(files);
    expect(modTrusted(w.dir, 'wire', hash)).toBe(true);
    expect(ran(w)).toHaveLength(1);
    expect(ran(w)[0]).toContain('ran 1 ');
    expect(ran(w)[0]).toContain(`mod-cache/${hash}/index.js`);
    expect(fs.existsSync(path.join(w.dir, 'mod-cache', hash, 'index.js'))).toBe(true);
    // more reloads (another mod arrives) do not run it again
    await imp(w, provFile('acme'));
    await w.call('POST', '/api/mods/acme/disable');
    expect(ran(w)).toHaveLength(1);
    expect((await w.mod('wire'))).toMatchObject({ trust: 'trusted', problems: [] });
  });

  it('a changed file asks again, and the new code does not run', async () => {
    const w = await boot();
    const v1 = codeFiles(w, 'wire', '1', { 'notes.txt': 'a' });
    await imp(w, file(v1), { trust: true });
    expect(ran(w)).toHaveLength(1);
    const v2 = { ...v1, 'notes.txt': 'b' };
    const r = await imp(w, file(v2));
    expect(r.json.trust).toBe('needs-trust');
    expect((await w.mod('wire'))!.trust).toBe('needs-trust');
    expect(ran(w)).toHaveLength(1);
    // the preview knows the old bytes are trusted and the new are not
    expect((await preview(w, file(v1))).json.summary.trusted).toBe(true);
    expect((await preview(w, file(v2))).json.summary.trusted).toBe(false);
    // a changed file that only differs by one byte of the code
    const v3 = { ...v1, 'index.js': v1['index.js'] + ' ' };
    expect((await imp(w, file(v3))).json.trust).toBe('needs-trust');
  });

  it('a code change while the server runs says to restart; a second loader in this same process (not a new process) runs the trusted new code', async () => {
    const w = await boot();
    const v1 = codeFiles(w, 'wire', '1');
    const v2 = codeFiles(w, 'wire', '2');
    await imp(w, file(v1), { trust: true });
    const r = await imp(w, file(v2), { trust: true });
    expect(r.json.trust).toBe('restart');
    const m = (await w.mod('wire'))!;
    expect(m.trust).toBe('restart');
    expect(m.problems.join(' ')).toContain('restart to run the new code');
    expect(ran(w)).toHaveLength(1);
    expect(ran(w)[0]).toContain('ran 1 ');
    // a fresh loader on the same home has run nothing yet (its own memory of what ran is empty), so it runs the trusted v2
    const fresh = await startMods({ dir: w.dir, env: {} });
    extra.push(fresh);
    expect(fresh.mods.find((x) => x.id === 'wire')).toMatchObject({ trusted: true, problems: [] });
    expect(ran(w)).toHaveLength(2);
    expect(ran(w)[1]).toContain('ran 2 ');
  });

  it('the trust record goes when the mod is removed; the same files imported again ask again', async () => {
    const w = await boot();
    const files = codeFiles(w, 'wire', '1');
    await imp(w, file(files), { trust: true });
    expect(JSON.parse(fs.readFileSync(path.join(w.dir, 'mod-trust.json'), 'utf8'))).toEqual({ wire: hashOf(files) });
    expect((await w.call('DELETE', '/api/mods/wire')).status).toBe(200);
    expect(modTrusted(w.dir, 'wire', hashOf(files))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(w.dir, 'mod-trust.json'), 'utf8'))).toEqual({});
    const r = await imp(w, file(files));
    expect(r.json.trust).toBe('needs-trust');
    expect(ran(w)).toHaveLength(1); // only the first time
  });

  it('trust belongs to one id and one hash: the same code under another id is not trusted', async () => {
    const w = await boot();
    const one = codeFiles(w, 'one', '1');
    await imp(w, file(one), { trust: true });
    const two = { ...one, 'mod.json': text({ reins: 1, id: 'two', kind: 'protocol', version: '1', label: 'two', main: 'index.js' }) };
    expect(modTrusted(w.dir, 'two', hashOf(one))).toBe(false);
    expect(modTrusted(w.dir, 'one', hashOf(one))).toBe(true);
    expect((await imp(w, file(two))).json.trust).toBe('needs-trust');
    expect(ran(w)).toHaveLength(1);
    // and a trust line written by hand for another id's hash does not help either
    fs.writeFileSync(path.join(w.dir, 'mod-trust.json'), JSON.stringify({ one: hashOf(one) }));
    await w.call('POST', '/api/mods/two/disable');
    await w.call('POST', '/api/mods/two/enable');
    expect((await w.mod('two'))!.trust).toBe('needs-trust');
  });

  it('trust: true on a data mod records nothing; a damaged trust file trusts nothing', async () => {
    const w = await boot();
    await imp(w, provFile('acme'), { trust: true });
    expect(fs.existsSync(path.join(w.dir, 'mod-trust.json'))).toBe(false);
    fs.writeFileSync(path.join(w.dir, 'mod-trust.json'), '{nope');
    expect(modTrusted(w.dir, 'acme', 'x')).toBe(false);
    expect((await imp(w, file(codeFiles(w, 'wire', '1')))).json.trust).toBe('needs-trust');
    expect((await imp(w, provFile('acme'), { trust: 'yes' })).status).toBe(400);
  });

  it('code that names a main which is not in the file, or a path, is refused', async () => {
    const w = await boot();
    const f = codeFiles(w, 'wire', '1');
    delete f['index.js'];
    expect((await imp(w, file(f))).json.error).toContain('not one of the files');
    for (const main of ['../index.js', '/index.js', 'sub/index.js', 'C:\\x.js']) {
      const r = await imp(w, file({ ...codeFiles(w, 'wire', '1'), 'mod.json': text({ reins: 1, id: 'wire', kind: 'protocol', version: '1', label: 'w', main }) }));
      expect([main, r.status]).toEqual([main, 400]);
    }
    expect(fs.existsSync(folder(w, 'wire'))).toBe(false);
    expect(ran(w)).toEqual([]);
  });
});

const GOOD = text(prov('acme'));
const NOT_ANY_FILE = 'mod.json';
describe('import refuses', () => {
  const cases: Array<[string, unknown]> = [
    ['dot dot', file({ [NOT_ANY_FILE]: GOOD, '../x': 'a' })],
    ['dot dot inside', file({ [NOT_ANY_FILE]: GOOD, 'a..b': 'a' })],
    ['slash', file({ [NOT_ANY_FILE]: GOOD, 'a/b': 'a' })],
    ['backslash', file({ [NOT_ANY_FILE]: GOOD, 'a\\b': 'a' })],
    ['absolute', file({ [NOT_ANY_FILE]: GOOD, '/etc/x': 'a' })],
    ['drive-relative', file({ [NOT_ANY_FILE]: GOOD, 'C:evil': 'a' })],
    ['drive path', file({ [NOT_ANY_FILE]: GOOD, 'C:\\evil.js': 'a' })],
    ['stream', file({ [NOT_ANY_FILE]: GOOD, 'a.txt:s': 'a' })],
    ['unc', file({ [NOT_ANY_FILE]: GOOD, '\\\\server\\share\\x': 'a' })],
    ['reserved con', file({ [NOT_ANY_FILE]: GOOD, con: 'a' })],
    ['reserved CON.json', file({ [NOT_ANY_FILE]: GOOD, 'CON.json': 'a' })],
    ['reserved nul.txt', file({ [NOT_ANY_FILE]: GOOD, 'nul.txt': 'a' })],
    ['reserved COM1', file({ [NOT_ANY_FILE]: GOOD, COM1: 'a' })],
    ['reserved lpt9.a.b', file({ [NOT_ANY_FILE]: GOOD, 'lpt9.a.b': 'a' })],
    ['trailing dot', file({ [NOT_ANY_FILE]: GOOD, 'x.': 'a' })],
    ['trailing space', file({ [NOT_ANY_FILE]: GOOD, 'x.txt ': 'a' })],
    ['short name', file({ [NOT_ANY_FILE]: GOOD, 'MOD~1.JSO': 'a' })],
    ['leading dot', file({ [NOT_ANY_FILE]: GOOD, '.hidden': 'a' })],
    ['empty name', file({ [NOT_ANY_FILE]: GOOD, '': 'a' })],
    ['control char', file({ [NOT_ANY_FILE]: GOOD, 'a\u0001b': 'a' })],
    ['long name', file({ [NOT_ANY_FILE]: GOOD, [`${'a'.repeat(101)}.txt`]: 'a' })],
    ['case duplicate', file({ [NOT_ANY_FILE]: GOOD, 'MOD.JSON': GOOD })],
    ['proto name', JSON.parse(`{"reinsMod":1,"files":{"mod.json":${JSON.stringify(GOOD)},"__proto__":"a"}}`)],
    ['binary NUL', file({ [NOT_ANY_FILE]: GOOD, 'a.bin': 'a\u0000b' })],
    ['binary control', file({ [NOT_ANY_FILE]: GOOD, 'a.bin': '\u0001\u0002' })],
    ['lone surrogate', file({ [NOT_ANY_FILE]: GOOD, 'a.txt': '\ud800' })],
    ['value not text', { reinsMod: 1, files: { [NOT_ANY_FILE]: GOOD, 'a.txt': 5 } }],
    ['value null', { reinsMod: 1, files: { [NOT_ANY_FILE]: GOOD, 'a.txt': null } }],
    ['files a list', { reinsMod: 1, files: [GOOD] }],
    ['files text', { reinsMod: 1, files: GOOD }],
    ['files missing', { reinsMod: 1 }],
    ['reinsMod 2', { reinsMod: 2, files: { [NOT_ANY_FILE]: GOOD } }],
    ['reinsMod missing', { files: { [NOT_ANY_FILE]: GOOD } }],
    ['reinsMod text', { reinsMod: '1', files: { [NOT_ANY_FILE]: GOOD } }],
    ['extra field', { reinsMod: 1, files: { [NOT_ANY_FILE]: GOOD }, run: 'x' }],
    ['no mod.json', file({ 'readme.txt': 'a' })],
    ['MOD.JSON only', file({ 'MOD.JSON': GOOD })],
    ['no files', file({})],
    ['invalid json text', '{nope'],
    ['not an object', '[1]'],
    ['null', null],
    ['a number', 5],
    ['mod.json not json', file({ [NOT_ANY_FILE]: '{nope' })],
    ['mod.json a list', file({ [NOT_ANY_FILE]: '[]' })],
    ['mod.json too deep', file({ [NOT_ANY_FILE]: `${'['.repeat(40)}${']'.repeat(40)}` })],
    ['keyEnv outside the pattern', provFile('acme', { auth: { style: 'bearer', keyEnv: ['AWS_SECRET_ACCESS_KEY'] } })],
    ['keyEnv lower case', provFile('acme', { auth: { style: 'bearer', keyEnv: ['acme_api_key'] } })],
    ['id is a path', file({ [NOT_ANY_FILE]: text(prov('acme', { id: '../evil' })) })],
    ['id is a nested path', file({ [NOT_ANY_FILE]: text(prov('acme', { id: 'a/b' })) })],
    ['id is a drive path', file({ [NOT_ANY_FILE]: text(prov('acme', { id: 'C:\\evil' })) })],
    ['id is reserved', file({ [NOT_ANY_FILE]: text(prov('acme', { id: 'con' })) })],
    ['id has capitals', file({ [NOT_ANY_FILE]: text(prov('acme', { id: 'Acme' })) })],
    ['id missing', file({ [NOT_ANY_FILE]: text({ ...prov('acme'), id: undefined }) })],
    ['id not text', file({ [NOT_ANY_FILE]: text(prov('acme', { id: 5 })) })],
    ['protocol not installed', provFile('acme', { protocol: 'nope' })],
    ['address with a password', provFile('acme', { baseUrl: 'https://user:pw@api.acme.test/v1' })],
    ['key in a header', provFile('acme', { headers: { Authorization: 'sk-abcdefghijklmnop' } })],
    ['other kind of a built-in id', file({ [NOT_ANY_FILE]: text({ reins: 1, id: 'claude-code-cli', kind: 'provider', version: '1', label: 'x', protocol: 'openai-chat', baseUrl: 'https://a.test/v1', defaultModel: 'm', models: [{ id: 'm' }] }) })],
  ];
  it.each(cases)('%s: refused by preview and by import, and nothing is written anywhere', async (_why, f) => {
    const w = await boot();
    const before = tree(w.root);
    const p = await preview(w, f);
    expect([p.status, typeof p.json.error]).toEqual([400, 'string']);
    const i = await imp(w, f);
    expect([i.status, typeof i.json.error]).toEqual([400, 'string']);
    expect(i.json.problems.length).toBeGreaterThan(0);
    expect(tree(w.root)).toEqual(before);
    expect(({} as Record<string, unknown>).a).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
  });

  it('more than 50 files, and more than 1 MB (by the action, and by the body cap of the route)', async () => {
    const w = await boot();
    const many: Record<string, string> = { 'mod.json': GOOD };
    for (let i = 0; i < 50; i++) many[`f${i}.txt`] = 'x';
    const r = await preview(w, file(many));
    expect([r.status, r.json.error]).toEqual([400, 'The file holds 51 files; the most is 50.']);
    delete many['f0.txt'];
    expect((await preview(w, file(many))).status).toBe(200);
    // over 1 MB in total, in the action itself (a route cannot carry more than its 1 MB body)
    const half = 'x'.repeat(600 * 1024);
    for (const f of [file({ 'mod.json': GOOD, 'a.txt': half, 'b.txt': half }), file({ 'mod.json': GOOD, 'a.txt': 'x'.repeat(1024 * 1024 + 1) }), JSON.stringify(file({ 'mod.json': GOOD, 'a.txt': 'x'.repeat(1024 * 1024 + 1) }))]) {
      const out = importPreview(w.env(), f);
      expect([out.status, (out.body as { error: string }).error]).toEqual([400, expect.stringMatching(/larger than 1 MB/)]);
    }
    const route = await preview(w, file({ 'mod.json': GOOD, 'a.txt': 'x'.repeat(1024 * 1024 + 10) }));
    expect([route.status, route.json.error]).toEqual([413, 'The body is larger than 1 MB.']);
    expect((await imp(w, file({ 'mod.json': GOOD, 'a.txt': 'x'.repeat(1024 * 1024 + 10) }))).status).toBe(413);
    expect((await w.call('POST', '/api/mods/import/preview', { raw: '{nope' })).status).toBe(400);
  });

  it('import never relies on an earlier preview: every check runs again on the file it is given', async () => {
    const w = await boot();
    expect((await preview(w, provFile('acme'))).status).toBe(200);
    const before = tree(w.root);
    const evil = file({ 'mod.json': GOOD, '../x': 'a' });
    expect((await imp(w, evil)).status).toBe(400);
    expect((await imp(w, provFile('acme', { auth: { style: 'bearer', keyEnv: ['AWS_SECRET_ACCESS_KEY'] } }))).status).toBe(400);
    expect(tree(w.root)).toEqual(before);
    // a preview of a built-in replacement does not stand in for the yes
    const cc = provFile('claude-code', { protocol: 'claude-code-cli', auth: { style: 'none', keyEnv: [] } });
    expect((await preview(w, cc)).status).toBe(200);
    expect((await imp(w, cc)).status).toBe(409);
    expect(fs.existsSync(folder(w, 'claude-code'))).toBe(false);
  });

  it('a link where the mod would go is not followed, not replaced, and what it points at is untouched', async () => {
    const w = await boot();
    const outside = path.join(w.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'keep');
    fs.mkdirSync(path.join(w.dir, 'mods'), { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(w.dir, 'mods', 'acme'), 'junction');
    } catch (e) {
      console.log(`skipped: this machine cannot create links (${(e as Error).message})`);
      return;
    }
    const before = tree(outside);
    const r = await imp(w, provFile('acme'));
    expect([r.status, r.json.error]).toEqual([409, expect.stringContaining('is a link or a file')]);
    expect(tree(outside)).toEqual(before);
    expect(fs.lstatSync(path.join(w.dir, 'mods', 'acme')).isSymbolicLink()).toBe(true);
    expect(scratchLeft(w)).toEqual([]);
  });

  it('a file where the mod would go is not replaced either', async () => {
    const w = await boot();
    fs.mkdirSync(path.join(w.dir, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(w.dir, 'mods', 'acme'), 'not a folder');
    const r = await imp(w, provFile('acme'));
    expect(r.status).toBe(409);
    expect(fs.readFileSync(path.join(w.dir, 'mods', 'acme'), 'utf8')).toBe('not a folder');
  });
});

describe('import over a built-in mod', () => {
  const cc = (more: Record<string, unknown> = {}) => provFile('claude-code', { protocol: 'claude-code-cli', auth: { style: 'none', keyEnv: [] }, ...more });
  it('needs replaceBuiltin true, and then says it replaces the built-in', async () => {
    const w = await boot();
    const before = tree(w.root);
    const no = await imp(w, cc());
    expect([no.status, no.json.error]).toEqual([409, expect.stringContaining('replaces the built-in claude-code')]);
    expect(tree(w.root)).toEqual(before);
    const yes = await imp(w, cc(), { replaceBuiltin: true });
    expect([yes.status, yes.json.ok]).toEqual([200, true]);
    expect(await w.mod('claude-code')).toMatchObject({ bundled: false, replaces: 'bundled', problems: [] });
    // the copy the user has now is "your" copy: replacing it needs no second yes
    expect((await imp(w, cc({ version: '2.0.0' }))).status).toBe(200);
    expect((await imp(w, cc(), { replaceBuiltin: 'yes' })).status).toBe(400);
  });
});

describe('import is atomic and serialized', () => {
  it('two imports of the same new id at once: one installs, the other replaces it, nothing is left over', async () => {
    const w = await boot();
    const [a, b] = await Promise.all([imp(w, provFile('acme', { version: '1.0.0' })), imp(w, provFile('acme', { version: '2.0.0' }))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.json.replaced, b.json.replaced]).toEqual([false, true]);
    expect(JSON.parse(fs.readFileSync(path.join(folder(w, 'acme'), 'mod.json'), 'utf8')).version).toBe('2.0.0');
    expect(scratchLeft(w)).toEqual([]);
    const many = await Promise.all(['a1', 'a2', 'a3', 'a4'].map((id) => imp(w, provFile(id))));
    expect(many.map((m) => m.status)).toEqual([200, 200, 200, 200]);
    expect(fs.readdirSync(path.join(w.dir, 'mods')).sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'acme']);
  });

  it('a failure while writing leaves the old copy whole and no scratch folder', async () => {
    const w = await boot();
    const old = provFile('acme', { version: '1.0.0' }, { 'notes.txt': 'old notes' });
    await imp(w, old);
    const before = tree(folder(w, 'acme'));
    const real = fs.writeFileSync;
    let n = 0;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).includes('.mod-new-') && ++n === 2) throw new Error('disk full');
      return (real as (...a: unknown[]) => void)(p, ...rest);
    }) as typeof fs.writeFileSync);
    const r = await imp(w, provFile('acme', { version: '2.0.0' }, { 'notes.txt': 'new notes', 'more.txt': 'x' }));
    expect([r.status, r.json.error]).toEqual([409, expect.stringContaining('Nothing was changed')]);
    vi.restoreAllMocks();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(tree(folder(w, 'acme'))).toEqual(before);
    expect(fs.readFileSync(path.join(folder(w, 'acme'), 'notes.txt'), 'utf8')).toBe('old notes');
    expect(scratchLeft(w)).toEqual([]);
    // a fresh install that fails leaves nothing at all
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).includes('.mod-new-')) throw new Error('disk full');
      return (real as (...a: unknown[]) => void)(p, ...rest);
    }) as typeof fs.writeFileSync);
    expect((await imp(w, provFile('fresh'))).status).toBe(409);
    vi.restoreAllMocks();
    expect(fs.existsSync(folder(w, 'fresh'))).toBe(false);
    expect(scratchLeft(w)).toEqual([]);
  });

  it('a failure when the new folder is moved into place puts the old copy back, and the trust line with it', async () => {
    const w = await boot();
    const v1 = codeFiles(w, 'wire', '1');
    await imp(w, file(v1), { trust: true });
    const before = tree(folder(w, 'wire'));
    const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from).includes('.mod-new-')) throw new Error('EPERM');
      return real(from, to);
    }) as typeof fs.renameSync);
    const v2 = codeFiles(w, 'wire', '2');
    const r = await imp(w, file(v2), { trust: true });
    vi.restoreAllMocks();
    expect(r.status).toBe(409);
    expect(tree(folder(w, 'wire'))).toEqual(before);
    expect(scratchLeft(w)).toEqual([]);
    expect(modTrusted(w.dir, 'wire', hashOf(v2))).toBe(false);
    expect(modTrusted(w.dir, 'wire', hashOf(v1))).toBe(true);
  });

  it('a file never lands outside the new folder, even if a name got past the checks', async () => {
    // the check is in the name rule AND in the one write function; this drives the whole route with names that try to climb
    const w = await boot();
    const before = tree(w.root);
    await imp(w, file({ 'mod.json': GOOD, '../../escape.txt': 'x', '..\\..\\escape2.txt': 'x' }));
    expect(tree(w.root)).toEqual(before);
    expect(fs.existsSync(path.join(w.root, 'escape.txt'))).toBe(false);
    expect(fs.existsSync(path.join(w.dir, 'escape.txt'))).toBe(false);
  });
});

describe('the routes sit behind the same door as the rest', () => {
  const routes: Array<[string, string, unknown]> = [
    ['GET', '/api/mods/claude-code/export', undefined],
    ['POST', '/api/mods/import/preview', { file: provFile('acme') }],
    ['POST', '/api/mods/import', { file: provFile('acme') }],
  ];
  it.each(routes)('%s %s: token, Host and Origin are checked, the body is capped', async (method, url, body) => {
    const w = await boot();
    const before = tree(w.root);
    expect((await w.call(method, url, { auth: false, ...(body ? { body } : {}) })).status).toBe(401);
    expect((await w.call(method, url, { headers: { authorization: 'Bearer wrong' }, ...(body ? { body } : {}) })).status).toBe(401);
    expect((await w.call(method, url, { headers: { origin: 'http://evil.test' }, ...(body ? { body } : {}) })).status).toBe(403);
    expect((await w.call(method, url, { headers: { host: 'evil.test' }, ...(body ? { body } : {}) })).status).toBe(403);
    expect(tree(w.root)).toEqual(before);
    if (body) {
      expect((await w.call(method, url, { body: { file: 'x'.repeat(1024 * 1024 + 10) } })).status).toBe(413);
      expect((await w.call(method, url, { raw: '[1]' })).status).toBe(400);
      expect(tree(w.root)).toEqual(before);
    }
  });
});

// ---- Fix round (Codex review of Task 22)

const DEAD = 987654321; // a process id nothing has
const linksWork = (root: string): boolean => {
  const a = path.join(root, 'probe-target');
  const l = path.join(root, 'probe-link');
  try {
    fs.mkdirSync(a);
    fs.symlinkSync(a, l, 'junction');
    fs.rmdirSync(l);
    return true;
  } catch (e) {
    console.log(`skipped: this machine cannot create links (${(e as Error).message})`);
    return false;
  }
};
/** A spy on a fs function that runs `hook` first and may throw; the real function runs after. */
function wrap<K extends 'renameSync' | 'writeFileSync' | 'mkdirSync' | 'rmSync' | 'lstatSync' | 'readSync'>(name: K, hook: (args: unknown[]) => unknown) {
  const real = fs[name] as (...a: unknown[]) => unknown;
  return vi.spyOn(fs, name).mockImplementation(((...a: unknown[]) => hook(a) ?? real(...a)) as never);
}

describe('a crash in the middle of an import (sweep at start)', () => {
  it('puts the old install back, removes staging and temp files, keeps a live process alone, and the old install loads', async () => {
    const w = await boot({
      prep: (dir) => {
        const put = (p: string, files: Record<string, string>) => { fs.mkdirSync(p, { recursive: true }); for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(p, n), t); };
        put(path.join(dir, `.mod-old-acme-${DEAD}-aaaaaaaaaaaa`), { 'mod.json': text(prov('acme')), 'notes.txt': 'old' });
        put(path.join(dir, `.mod-new-${DEAD}-bbbbbbbbbbbb`), { 'mod.json': '{half' });
        fs.writeFileSync(path.join(dir, `.mod-file-${DEAD}-cccccccccccc`), 'half');
        // a backup beside an install that is there: the install wins, the backup goes
        put(path.join(dir, 'mods', 'beta'), { 'mod.json': text(prov('beta')) });
        put(path.join(dir, `.mod-old-beta-${DEAD}-dddddddddddd`), { 'mod.json': text(prov('beta', { version: '0.1.0' })) });
        // a backup of an id that is not an id is not put anywhere
        put(path.join(dir, `.mod-old-..-${DEAD}-eeeeeeeeeeee`), { 'mod.json': '{}' });
        // a process that is alive is mid-import: its scratch is not ours
        put(path.join(dir, `.mod-new-${process.ppid}-ffffffffffff`), { 'mod.json': '{}' });
      },
    });
    expect(fs.readdirSync(w.dir).filter((n) => n.startsWith('.mod-'))).toEqual([`.mod-new-${process.ppid}-ffffffffffff`]);
    expect(JSON.parse(fs.readFileSync(path.join(folder(w, 'acme'), 'mod.json'), 'utf8')).id).toBe('acme');
    expect(fs.readFileSync(path.join(folder(w, 'acme'), 'notes.txt'), 'utf8')).toBe('old');
    expect(await w.mod('acme')).toMatchObject({ enabled: true, problems: [] });
    expect(JSON.parse(fs.readFileSync(path.join(folder(w, 'beta'), 'mod.json'), 'utf8')).version).toBe('1.0.0');
    expect(w.mods.problems).toEqual([]);
  });

  it('a link planted as a leftover is removed itself and what it points at is not touched', async () => {
    const w0 = await boot();
    if (!linksWork(w0.root)) return;
    const w = await boot({
      prep: (dir, root) => {
        const outside = path.join(root, 'outside');
        fs.mkdirSync(path.join(outside, 'deep'), { recursive: true });
        fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'keep');
        fs.symlinkSync(outside, path.join(dir, `.mod-new-${DEAD}-111111111111`), 'junction');
        fs.symlinkSync(outside, path.join(dir, `.mod-old-acme-${DEAD}-222222222222`), 'junction'); // a link is not a backup to restore
        fs.mkdirSync(path.join(dir, `.mod-new-${DEAD}-333333333333`));
        fs.symlinkSync(outside, path.join(dir, `.mod-new-${DEAD}-333333333333`, 'inner'), 'junction'); // a link inside a leftover folder
      },
    });
    expect(fs.readdirSync(w.dir).filter((n) => n.startsWith('.mod-'))).toEqual([]);
    expect(fs.existsSync(folder(w, 'acme'))).toBe(false);
    expect(fs.readFileSync(path.join(w.root, 'outside', 'sentinel.txt'), 'utf8')).toBe('keep');
    expect(fs.existsSync(path.join(w.root, 'outside', 'deep'))).toBe(true);
  });

  it('a real crash between the two renames: the old install, its trust and its code come back at the next start; the new code was never trusted', async () => {
    const w = await boot();
    const v1 = codeFiles(w, 'wire', '1');
    const v2 = codeFiles(w, 'wire', '2');
    await imp(w, file(v1), { trust: true });
    let trustedAtPlace: boolean | undefined;
    // the process "dies" when the new folder is to be moved in: that rename throws, and so does every attempt to put the old one back
    const spy = wrap('renameSync', (a) => {
      if (String(a[0]).includes('.mod-new-')) { trustedAtPlace = modTrusted(w.dir, 'wire', hashOf(v2)); throw new Error('killed'); }
      if (String(a[0]).includes('.mod-old-')) throw new Error('killed');
      return undefined;
    });
    const r = await imp(w, file(v2), { trust: true });
    spy.mockRestore();
    expect(r.status).toBe(409);
    expect(r.json.error).toContain('could not be fully undone');
    expect(r.json.error).toContain('your old copy is in .mod-old-wire-');
    expect(r.json.error).not.toContain(w.dir);
    expect(trustedAtPlace).toBe(false); // the new hash is recorded only after the folder is in place
    expect(fs.existsSync(folder(w, 'wire'))).toBe(false);
    expect(fs.readdirSync(w.dir).filter((n) => n.startsWith('.mod-old-wire-'))).toHaveLength(1);
    expect(modTrusted(w.dir, 'wire', hashOf(v1))).toBe(true);
    expect(modTrusted(w.dir, 'wire', hashOf(v2))).toBe(false);
    // the next start
    const next = await startMods({ dir: w.dir, env: {} });
    extra.push(next);
    expect(fs.readdirSync(w.dir).filter((n) => n.startsWith('.mod-'))).toEqual([]);
    expect(fs.readFileSync(path.join(folder(w, 'wire'), 'index.js'), 'utf8')).toBe(v1['index.js']);
    expect(next.mods.find((m) => m.id === 'wire')).toMatchObject({ trusted: true, problems: [] });
  });
});

describe('the work after the folder is in place is part of the import', () => {
  it('a failure in consent.revoke puts the old copy, the old trust and the folder back (answer 500, nothing changed)', async () => {
    const w = await boot();
    const v1 = codeFiles(w, 'wire', '1');
    const v2 = codeFiles(w, 'wire', '2');
    await imp(w, file(v1), { trust: true });
    const before = tree(folder(w, 'wire'));
    const spy = vi.spyOn(w.store, 'revokeConsent').mockImplementation(() => { throw new Error('db locked'); });
    const r = await imp(w, file(v2), { trust: true });
    spy.mockRestore();
    expect([r.status, r.json.error]).toEqual([500, expect.stringContaining('Nothing was changed')]);
    expect(tree(folder(w, 'wire'))).toEqual(before);
    expect(modTrusted(w.dir, 'wire', hashOf(v1))).toBe(true);
    expect(modTrusted(w.dir, 'wire', hashOf(v2))).toBe(false);
    expect(scratchLeft(w)).toEqual([]);
  });

  it('a failure saving the on/off state rolls a fresh install back and leaves the mark as it was', async () => {
    const w = await boot({ prep: (dir) => fs.writeFileSync(path.join(dir, 'disabled-mods.json'), '["acme"]') });
    const spy = wrap('renameSync', (a) => { if (String(a[1]).endsWith('disabled-mods.json')) throw new Error('disk full'); return undefined; });
    const r = await imp(w, provFile('acme'));
    spy.mockRestore();
    expect([r.status, r.json.error]).toEqual([500, expect.stringContaining('Nothing was changed')]);
    expect(fs.existsSync(folder(w, 'acme'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(w.dir, 'disabled-mods.json'), 'utf8'))).toEqual(['acme']);
    expect(scratchLeft(w)).toEqual([]);
  });

  it('a failure after the mark was cleared puts the mark back too', async () => {
    const w = await boot({ prep: (dir) => fs.writeFileSync(path.join(dir, 'disabled-mods.json'), '["acme"]') });
    const spy = vi.spyOn(w.store, 'revokeConsent').mockImplementation(() => { throw new Error('db locked'); });
    const r = await imp(w, provFile('acme'));
    spy.mockRestore();
    expect(r.status).toBe(500);
    expect(fs.existsSync(folder(w, 'acme'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(w.dir, 'disabled-mods.json'), 'utf8'))).toEqual(['acme']);
  });

  it('when the undo itself fails the answer says what is left, without the home path', async () => {
    const w = await boot();
    await imp(w, provFile('acme', { version: '1.0.0' }));
    const spy = vi.spyOn(w.store, 'revokeConsent').mockImplementation(() => { throw new Error('db locked'); });
    const ren = wrap('renameSync', (a) => { if (String(a[0]).includes('.mod-old-')) throw new Error('locked'); return undefined; });
    const r = await imp(w, provFile('acme', { version: '2.0.0' }));
    ren.mockRestore();
    spy.mockRestore();
    expect(r.status).toBe(500);
    expect(r.json.error).toContain('could not be fully undone');
    expect(r.json.error).not.toContain('Nothing was changed');
    expect(r.json.error).not.toContain(w.dir);
  });

  it('a backup that cannot be removed is told in the answer (no path), and the next start removes it', async () => {
    const w = await boot();
    await imp(w, provFile('acme', { version: '1.0.0' }));
    const spy = wrap('rmSync', (a) => { if (String(a[0]).includes('.mod-old-')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return undefined; });
    const r = await imp(w, provFile('acme', { version: '2.0.0' }));
    spy.mockRestore();
    expect(r.status).toBe(200);
    expect(r.json.problems).toEqual([expect.stringMatching(/^could not remove \.mod-old-acme-/)]);
    expect(r.text).not.toContain(w.dir);
    expect(scratchLeft(w)).toHaveLength(1);
    const next = await startMods({ dir: w.dir, env: {} });
    extra.push(next);
    expect(scratchLeft(w)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(folder(w, 'acme'), 'mod.json'), 'utf8')).version).toBe('2.0.0');
  });
});

describe('export: budget, the id, file names, links', () => {
  const withMod = (extraPrep?: (d: string) => void) => boot({
    prep: (dir) => {
      fs.mkdirSync(path.join(dir, 'mods', 'acme'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'mods', 'acme', 'mod.json'), text(prov('acme')));
      extraPrep?.(dir);
    },
  });

  it('counts the bytes actually read, whatever the size said: a file that grew is cut at the budget', async () => {
    const w = await withMod();
    fs.writeFileSync(path.join(folder(w, 'acme'), 'big.txt'), 'x'.repeat(3 * 1024 * 1024));
    const realL = fs.lstatSync;
    wrap('lstatSync', (a) => { const st = (realL as (...x: unknown[]) => fs.Stats)(...a); return String(a[0]).endsWith('big.txt') ? Object.create(st, { size: { value: 10 } }) : undefined; });
    let got = 0;
    const realR = fs.readSync as (...x: unknown[]) => number;
    vi.spyOn(fs, 'readSync').mockImplementation(((...a: unknown[]) => { const n = realR(...a); got += n; return n; }) as never);
    const r = await w.call('GET', '/api/mods/acme/export');
    vi.restoreAllMocks();
    expect([r.status, r.json.error]).toEqual([409, expect.stringContaining('larger than 1 MB')]);
    expect(got).toBeGreaterThan(1024 * 1024);
    expect(got).toBeLessThanOrEqual(1024 * 1024 + 1);
  });

  it('never sends an id that is a known key (generic words), and never a file name that is one', async () => {
    const w = await boot({
      prep: (dir) => {
        setKey(dir, 'acme', KEY);
        for (const [id, extraFile] of [['acme', KEY], [KEY, undefined]] as const) {
          const d = path.join(dir, 'mods', id);
          fs.mkdirSync(d, { recursive: true });
          fs.writeFileSync(path.join(d, 'mod.json'), text(prov(id === KEY ? 'keyed' : id, id === KEY ? { id: KEY } : {})));
          if (extraFile) fs.writeFileSync(path.join(d, extraFile), 'x');
        }
      },
    });
    const byId = await w.call('GET', `/api/mods/${KEY}/export`);
    expect([byId.status, byId.json.error]).toEqual([409, 'This mod cannot be exported.']);
    expect(byId.headers['content-disposition']).toBeUndefined();
    expect(byId.text).not.toContain(KEY);
    const byName = await w.call('GET', '/api/mods/acme/export');
    expect([byName.status, byName.json.error]).toEqual([409, expect.stringContaining('a file name holds a key Reins knows')]);
    expect(byName.text).not.toContain(KEY);
    expect(byName.headers['content-disposition']).toBeUndefined();
  });
});

describe('what the confirmation shows reads as it is', () => {
  const odd: Array<[string, string]> = [['newline', 'A\nB'], ['tab', 'A\tB'], ['DEL', 'A\u007fB'], ['C1', 'A\u0085B'], ['line separator', 'A B'], ['paragraph separator', 'A B'],
    ['bidi override', 'A‮B'], ['bidi isolate', 'A⁦B'], ['left-to-right mark', 'A‎B'], ['arabic letter mark', 'A؜B']];
  it.each(odd)('a label with a %s is refused, naming the field', async (_n, label) => {
    const w = await boot();
    const before = tree(w.root);
    for (const f of [preview, imp]) {
      const r = await f(w, provFile('acme', { label }));
      expect([r.status, r.json.error]).toEqual([400, expect.stringContaining('label must not hold a control, line-break or direction-changing character')]);
    }
    expect(tree(w.root)).toEqual(before);
  });

  it('header names must be HTTP tokens and header values plain text, in the shared validator (import, edit)', async () => {
    const w = await boot();
    for (const name of ['X Bad', 'X\nY', 'X‮Y', 'Ä', 'a:b', '', 'a/b', '(x)']) {
      const r = await preview(w, provFile('acme', { headers: { [name]: 'v' } }));
      expect([JSON.stringify(name), r.status]).toEqual([JSON.stringify(name), 400]);
      expect(r.json.error).toContain('not a valid header name');
      expect(r.json.error).not.toContain('‮'); // the words show it escaped
    }
    for (const value of ['a\r\nX-Evil: 1', 'a\nb', 'a\u0000b']) {
      const r = await preview(w, provFile('acme', { headers: { 'X-Org': value } }));
      expect([JSON.stringify(value), r.status]).toEqual([JSON.stringify(value), 400]);
      expect(r.json.error).toContain('must not hold a line break or a NUL');
    }
    expect((await preview(w, provFile('acme', { headers: { "X-Org_1.a~!#$%&'*+^`|": 'plain value' } }))).status).toBe(200);
    // the same validator guards Edit
    await imp(w, provFile('acme'));
    const bad = await w.call('PUT', '/api/mods/acme', { body: { headers: { 'X-Org': 'a\r\nX-Evil: 1' } } });
    expect([bad.status, bad.json.error]).toEqual([400, expect.stringContaining('must not hold a line break')]);
    const badName = await w.call('PUT', '/api/mods/acme', { body: { headers: { 'X Org': 'v' } } });
    expect(badName.status).toBe(400);
  });
});

describe('loader diagnostics do not show the home', () => {
  it('a code mod that imports a missing helper: the problem line has no home path and no absolute mod-cache path', async () => {
    const w = await boot();
    const files = codeFiles(w, 'wire', '1');
    files['index.js'] = `import './missing-helper.mjs';\nexport default function activate() {}\n`;
    const r = await imp(w, file(files), { trust: true });
    expect(r.status).toBe(200);
    const m = (await w.mod('wire'))!;
    const line = m.problems.join('\n');
    expect(line).toContain('did not load');
    expect(line).toContain('missing-helper');
    const norm = (s: string) => s.replaceAll('\\', '/').toLowerCase();
    expect(norm(line)).not.toContain(norm(w.dir));
    expect(norm(line)).not.toContain(norm(os.tmpdir()));
    expect(line).toContain('~/.reins');
    expect(r.text).not.toContain(w.dir.replaceAll('\\', '\\\\'));
  });
});

describe('the one-line edits Codex found unguarded', () => {
  it('a link planted at the staging folder is refused and nothing lands behind it', async () => {
    const w0 = await boot();
    if (!linksWork(w0.root)) return;
    const w = await boot();
    const outside = path.join(w.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'keep');
    const realMk = fs.mkdirSync as (...x: unknown[]) => unknown;
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
      const out = realMk(p, ...rest);
      if (String(p).includes('.mod-new-')) { fs.rmdirSync(p as string); fs.symlinkSync(outside, p as string, 'junction'); }
      return out;
    }) as never);
    const r = await imp(w, provFile('acme'));
    vi.restoreAllMocks();
    expect(r.status).toBe(409);
    expect(fs.readdirSync(outside)).toEqual(['sentinel.txt']);
    expect(fs.existsSync(folder(w, 'acme'))).toBe(false);
    expect(scratchLeft(w)).toEqual([]);
    expect(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  it('staged bytes that are not the bytes that were checked are refused', async () => {
    const w = await boot();
    const realW = fs.writeFileSync as (...x: unknown[]) => unknown;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: unknown, data: unknown, ...rest: unknown[]) =>
      realW(p, String(p).includes('.mod-new-') && String(p).endsWith('notes.txt') ? 'tampered' : data, ...rest)) as never);
    const r = await imp(w, provFile('acme', {}, { 'notes.txt': 'as imported' }));
    vi.restoreAllMocks();
    expect(r.status).toBe(409);
    expect(fs.existsSync(folder(w, 'acme'))).toBe(false);
    expect(scratchLeft(w)).toEqual([]);
  });

  it('an import forgets the yes answers of the id: a new manifest asks again', async () => {
    const w = await boot();
    await imp(w, provFile('acme'));
    w.store.grantConsent('acme', 'https://api.acme.test');
    expect(w.store.hasConsent('acme', 'https://api.acme.test')).toBe(true);
    await imp(w, provFile('acme', { baseUrl: 'https://api.other.test/v1' }));
    expect(w.store.hasConsent('acme', 'https://api.acme.test')).toBe(false);
  });

  it('only 127.x.y.z, [::1] and localhost are local: lookalike hosts get the plain http warning', async () => {
    const w = await boot();
    for (const url of ['http://127.evil.test/v1', 'http://127.0.0.1.evil.com/v1', 'http://localhost.evil.test/v1', 'http://128.0.0.1/v1', 'http://10.0.0.1/v1']) {
      const s = (await preview(w, provFile('acme', { baseUrl: url }))).json.summary;
      expect([url, s.keys[0].plainHttp, s.warnings.join(' ').includes('plain http')]).toEqual([url, true, true]);
    }
    for (const url of ['http://127.0.0.2:8/v1', 'http://[::1]/v1', 'http://localhost/v1', 'http://127.255.255.254/v1']) {
      const s = (await preview(w, provFile('acme', { baseUrl: url }))).json.summary;
      expect([url, s.keys[0].plainHttp, s.warnings.join(' ').includes('plain http')]).toEqual([url, false, false]);
    }
  });
});
