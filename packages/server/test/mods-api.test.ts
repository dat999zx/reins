// Milestone P, Task 20 (spec 7.1, 7.3 to 7.5, 8.1): the settings API for provider mods. A real server over HTTP on a temp Reins folder,
// the real loader (bundled mods included), a temp catalog, a fake provider server. No network, no real key.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyEnvNames, makeEngineFrom, startMods } from '../src/engines.js';
import { Redactor, readSecrets, setKey } from '../src/secrets.js';
import { makeSend } from '../src/send.js';
import { startServer, type Server } from '../src/server.js';
import { openStore, type Store } from '../src/store.js';
import type { Mods } from '../src/mods/types.js';
import { startFakeProvider } from './fake-provider.js';
import { until } from './helpers.js';
import { PROBE } from './http-helpers.js';

const KEY = 'sk-test-0123456789abcdef';
const rm = (d: string) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the OS */ } };

const prov = (id: string, over: Record<string, unknown> = {}) => ({
  reins: 1, id, kind: 'provider', version: '1.0.0', label: id.toUpperCase(), description: `The ${id} test provider`, protocol: 'openai-chat',
  baseUrl: `https://api.${id}.test/v1`, auth: { style: 'bearer', keyEnv: [`${id.toUpperCase()}_API_KEY`] },
  defaultModel: `${id}-m`, models: [{ id: `${id}-m`, label: 'M', price: { input: 1, output: 2 } }], untested: true, ...over,
});
const CATALOG: Record<string, unknown> = {
  alpha: prov('alpha'),
  beta: prov('beta', { baseUrl: 'http://localhost:9/v1', auth: { style: 'none', keyEnv: [] }, price: { input: 0, output: 0 } }),
  'claude-code': prov('claude-code'),
  badcat: prov('badcat', { protocol: undefined }),
};

interface World {
  root: string; dir: string; catalogDir: string; mods: Mods; store: Store; srv: Server; proj: string;
  call: (method: string, url: string, o?: { body?: unknown; raw?: string; auth?: boolean; headers?: Record<string, string> }) => Promise<{ status: number; json: any; text: string }>;
  state: () => Promise<{ providers: Array<{ id: string; label: string; defaultModel: string }>; sessions: Array<{ id: string; provider: { status: string }; engine: string }>; engines: Array<{ id: string }> }>;
  list: () => Promise<{ mods: Array<{ id: string; kind: string; label: string; version: string; enabled: boolean; bundled: boolean; source: string; problems: string[] }>; firstRun: boolean; chooser: Array<{ id: string }>; problems: string[] }>;
  modFile: (id: string) => string;
}
const worlds: World[] = [];
const closers: Array<() => unknown> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of closers.splice(0).reverse()) await f();
  for (const w of worlds.splice(0)) {
    await w.srv.close();
    w.store.close();
    w.mods.dispose();
    rm(w.root);
  }
});

async function boot(o: { catalog?: boolean; prep?: (dir: string) => void } = {}): Promise<World> {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-modsapi-')));
  const dir = path.join(root, '.reins');
  const catalogDir = path.join(root, 'catalog');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(proj);
  if (o.catalog !== false) {
    for (const [id, m] of Object.entries(CATALOG)) {
      fs.mkdirSync(path.join(catalogDir, id), { recursive: true });
      fs.writeFileSync(path.join(catalogDir, id, 'mod.json'), JSON.stringify(m, null, 2));
    }
    fs.mkdirSync(path.join(catalogDir, 'Not A Mod'));
  }
  o.prep?.(dir);
  const mods = await startMods({ dir, env: {} });
  const redactor = new Redactor({ home: dir, env: {}, keyEnvNames: () => keyEnvNames(mods) });
  const send = makeSend({ secrets: () => readSecrets(dir), env: {}, redactor, consent: () => true });
  const store = openStore(':memory:');
  const srv = await startServer({
    store, dir, mods, env: {}, catalogDir, redactor, send, consent: () => undefined, probe: async () => PROBE,
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
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
  const w: World = {
    root, dir, catalogDir, mods, store, srv, proj, call,
    state: async () => (await call('GET', '/api/state')).json,
    list: async () => (await call('GET', '/api/mods')).json,
    modFile: (id) => path.join(dir, 'mods', id, 'mod.json'),
  };
  worlds.push(w);
  return w;
}

const read = (f: string) => fs.readFileSync(f);
const ids = (w: { mods: Array<{ id: string }> }) => w.mods.map((m) => m.id);
const BAD_ID_WORDS = 'That is not a valid mod id.';

describe('GET /api/mods', () => {
  it('lists the mods with their fields, the first-run flag and the chooser', async () => {
    const w = await boot();
    const r = await w.call('GET', '/api/mods');
    expect(r.status).toBe(200);
    const cc = r.json.mods.find((m: { id: string }) => m.id === 'claude-code');
    expect(cc).toEqual({ id: 'claude-code', kind: 'provider', label: 'Claude', version: '1.0.0', enabled: true, bundled: true, source: 'bundled', problems: [], manifest: expect.objectContaining({ id: 'claude-code' }) });
    expect(ids(r.json)).toEqual(expect.arrayContaining(['claude-code', 'claude-code-cli', 'openai-chat', 'anthropic-messages']));
    expect(r.json.firstRun).toBe(true);
    expect(r.json.problems).toEqual([]);
    // the chooser: installable providers that are not installed; never the built-in one, an invalid entry, or a folder that is not an id
    expect(r.json.chooser.map((c: { id: string }) => c.id)).toEqual(['alpha', 'beta']);
    expect(r.json.chooser[0]).toEqual({ id: 'alpha', label: 'ALPHA', description: 'The alpha test provider', protocol: 'openai-chat', host: 'api.alpha.test', keyEnv: ['ALPHA_API_KEY'], untested: true, local: false });
  });

  it('provider rows carry their manifest (names only), and the list holds no key value', async () => {
    const w = await boot();
    await w.call('POST', '/api/mods/install', { body: { ids: ['alpha', 'beta'] } });
    expect((await w.call('PUT', '/api/mods/alpha/key', { body: { key: KEY } })).status).toBe(200);
    const r = await w.call('GET', '/api/mods');
    const alpha = r.json.mods.find((m: { id: string }) => m.id === 'alpha');
    expect(alpha.manifest).toMatchObject({ id: 'alpha', protocol: 'openai-chat', untested: true, auth: { style: 'bearer', keyEnv: ['ALPHA_API_KEY'] } });
    expect(alpha.manifest.models).toHaveLength(1);
    expect(alpha.key).toEqual({ state: 'set', source: 'Reins' });
    expect(r.json.mods.find((m: { id: string }) => m.id === 'beta').manifest.auth).toEqual({ style: 'none', keyEnv: [] });
    expect(r.json.mods.find((m: { kind: string }) => m.kind === 'protocol')).not.toHaveProperty('manifest');
    expect(r.text).not.toContain(KEY);
  });

  it('the first-run flag: true on a fresh home, false with the marker or with an installed provider', async () => {
    const a = await boot();
    expect((await a.list()).firstRun).toBe(true);
    fs.writeFileSync(path.join(a.dir, 'first-run-done'), '');
    expect((await a.list()).firstRun).toBe(false);
    const b = await boot();
    await b.call('POST', '/api/mods/install', { body: { ids: ['beta'] } });
    expect((await b.list()).firstRun).toBe(false);
    // a home that was only ever given a folder or the bundled mods is still first run
    const c = await boot({ prep: (dir) => fs.mkdirSync(path.join(dir, 'mods')) });
    expect((await c.list()).firstRun).toBe(true);
  });

  it('shows a broken user mod and its problem, and the rest still works', async () => {
    const w = await boot({ prep: (dir) => {
      fs.mkdirSync(path.join(dir, 'mods', 'broken'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'mods', 'broken', 'mod.json'), '{ "reins": 1, ');
    } });
    const l = await w.list();
    const broken = l.mods.find((m) => m.id === 'broken')!;
    expect(broken.problems.join(' ')).toMatch(/not valid JSON/);
    expect(l.mods.find((m) => m.id === 'claude-code')!.problems).toEqual([]);
    expect((await w.state()).providers.map((p) => p.id)).toEqual(['claude-code']);
  });

  it('answers 404 for a path it does not have, and needs the token, the Host and the Origin like every /api route', async () => {
    const w = await boot();
    expect((await w.call('GET', '/api/mods/alpha')).status).toBe(404);
    for (const [method, url] of [['GET', '/api/mods'], ['POST', '/api/mods/install'], ['POST', '/api/mods/custom'], ['PUT', '/api/mods/alpha'], ['DELETE', '/api/mods/alpha'], ['POST', '/api/mods/alpha/enable'], ['POST', '/api/mods/alpha/disable'], ['POST', '/api/mods/alpha/reinstall']]) {
      const r = await w.call(method!, url!, { auth: false, body: {} });
      expect([method, url, r.status]).toEqual([method, url, 401]);
    }
    expect((await w.call('GET', '/api/mods', { headers: { origin: 'http://evil.test' } })).status).toBe(403);
    expect((await w.call('GET', '/api/mods', { headers: { host: 'evil.test' } })).status).toBe(403);
  });
});

describe('POST /api/mods/install', () => {
  it('copies the named catalog providers; the next state and list show them', async () => {
    const w = await boot();
    const r = await w.call('POST', '/api/mods/install', { body: { ids: ['alpha', 'beta'] } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, results: [{ id: 'alpha', ok: true }, { id: 'beta', ok: true }], reloaded: true });
    expect(read(w.modFile('alpha'))).toEqual(read(path.join(w.catalogDir, 'alpha', 'mod.json')));
    const l = await w.list();
    expect(l.mods.find((m) => m.id === 'alpha')).toMatchObject({ source: 'installed', bundled: false, enabled: true, label: 'ALPHA', problems: [] });
    expect(l.chooser).toEqual([]);
    expect((await w.state()).providers.map((p) => p.id)).toEqual(['alpha', 'beta', 'claude-code']);
  });

  it('works per id: an unknown, invalid, built-in or installed id fails with words and the others still install', async () => {
    const w = await boot();
    await w.call('POST', '/api/mods/install', { body: { ids: ['alpha'] } });
    const r = await w.call('POST', '/api/mods/install', { body: { ids: ['alpha', 'nope', 'badcat', '../x', 'claude-code', 'beta'] } });
    expect(r.status).toBe(200);
    expect(r.json.results).toEqual([
      { id: 'alpha', ok: false, error: 'is already installed. Use Re-install to replace your copy.' },
      { id: 'nope', ok: false, error: 'is not in the catalog.' },
      { id: 'badcat', ok: false, error: '`badcat`: `protocol` is missing.' },
      { id: '../x', ok: false, error: '"../x" is not a valid provider id.' },
      { id: 'claude-code', ok: false, error: 'is built in and always available.' },
      { id: 'beta', ok: true },
    ]);
    // all or nothing per id: the failed ones left no folder and no temp name behind
    expect(fs.readdirSync(path.join(w.dir, 'mods')).sort()).toEqual(['alpha', 'beta']);
    expect(fs.readdirSync(w.dir).filter((n) => n.startsWith('.mod-'))).toEqual([]);
    expect(fs.existsSync(path.join(w.root, 'x'))).toBe(false);
  });

  it('refuses a bad body with words, and answers 404 when there is no catalog', async () => {
    const w = await boot();
    for (const body of [{}, { ids: 'alpha' }, { ids: [] }, { ids: [1] }]) {
      const r = await w.call('POST', '/api/mods/install', { body });
      expect([r.status, r.json.error]).toEqual([400, 'ids must be a list of provider ids.']);
    }
    const none = await boot({ catalog: false });
    const r = await none.call('POST', '/api/mods/install', { body: { ids: ['alpha'] } });
    expect([r.status, r.json.error]).toEqual([404, 'This copy of Reins has no catalog of providers to install from.']);
    expect((await none.call('GET', '/api/mods')).status).toBe(200);
    expect((await none.list()).chooser).toEqual([]);
  });
});

describe('POST /api/mods/custom', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    id: 'mine', label: 'Mine', baseUrl: 'http://127.0.0.1:9/v1', protocol: 'openai-chat', defaultModel: 'm1',
    auth: { style: 'bearer', keyEnv: 'MINE_API_KEY' }, ...over,
  });

  it('builds, validates and writes the manifest, and the next state shows it', async () => {
    const w = await boot();
    const r = await w.call('POST', '/api/mods/custom', { body: body({ price: { input: 0, output: 0 }, models: [{ id: 'm1', context: 8192 }] }) });
    expect([r.status, r.json]).toEqual([200, { ok: true, id: 'mine', reloaded: true }]);
    expect(JSON.parse(read(w.modFile('mine')).toString())).toEqual({
      reins: 1, id: 'mine', kind: 'provider', version: '1.0.0', label: 'Mine', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:9/v1',
      defaultModel: 'm1', price: { input: 0, output: 0 }, auth: { style: 'bearer', keyEnv: ['MINE_API_KEY'] }, models: [{ id: 'm1', context: 8192 }],
    });
    expect((await w.list()).mods.find((m) => m.id === 'mine')).toMatchObject({ source: 'custom', enabled: true, problems: [] });
    expect((await w.state()).providers.find((p) => p.id === 'mine')).toMatchObject({ label: 'Mine', defaultModel: 'm1' });
    // models default to the default model; auth defaults to none
    const d = await w.call('POST', '/api/mods/custom', { body: { id: 'plain', label: 'Plain', baseUrl: 'https://x.test/v1', protocol: 'openai-chat', defaultModel: 'pm' } });
    expect(d.status, d.text).toBe(200);
    expect(JSON.parse(read(w.modFile('plain')).toString())).toMatchObject({ models: [{ id: 'pm' }], auth: { style: 'none', keyEnv: [] } });
  });

  it('a key goes to the secrets file only: never into mod.json, never back in an answer', async () => {
    const w = await boot();
    const r = await w.call('POST', '/api/mods/custom', { body: body({ key: KEY }) });
    expect(r.status, r.text).toBe(200);
    expect(r.text).not.toContain(KEY);
    expect(read(w.modFile('mine')).toString()).not.toContain(KEY);
    expect(read(w.modFile('mine')).toString()).not.toContain('"key"');
    expect(readSecrets(w.dir).get('mine')).toBe(KEY);
    // nothing else under the mods folder or the home (outside secrets.json) holds it
    const holders: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (read(p).includes(KEY)) holders.push(path.basename(p)); } };
    walk(w.dir);
    expect(holders).toEqual(['secrets.json']);
    expect((await w.call('GET', '/api/mods')).text).not.toContain(KEY);
    expect((await w.call('GET', '/api/state')).text).not.toContain(KEY);
    // a key that cannot be a header, or with no auth to use it, is refused and writes nothing
    for (const [over, words] of [[{ key: 'a\nb' }, 'The key must be text with no line breaks or control characters.'], [{ key: 5 }, 'The key must be text with no line breaks or control characters.'], [{ id: 'nokey', auth: { style: 'none' }, key: KEY }, 'A key was given but `auth.style` is none. Pick bearer or header.']] as const) {
      const x = await w.call('POST', '/api/mods/custom', { body: body({ ...over }) });
      expect([x.status, x.json.error]).toEqual([400, words]);
      expect(x.text).not.toContain(KEY);
    }
    expect(fs.existsSync(path.join(w.dir, 'mods', 'nokey'))).toBe(false);
  });

  it('refuses a base address that is not http or https, or that holds a user name or password, and writes nothing', async () => {
    const w = await boot();
    for (const baseUrl of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x.test/v1', 'api.x.test/v1', '']) {
      const r = await w.call('POST', '/api/mods/custom', { body: body({ baseUrl }) });
      expect([baseUrl, r.status, String(r.json.error)]).toEqual([baseUrl, 400, expect.stringContaining('`baseUrl` must be an http or https address')]);
    }
    const cred = await w.call('POST', '/api/mods/custom', { body: body({ baseUrl: `https://me:${KEY}@x.test/v1` }) });
    expect([cred.status, cred.json.error]).toEqual([400, '`mine`: `baseUrl` must not hold a user name or password. Keys go in Settings > Providers, never in a mod.']);
    expect(cred.text).not.toContain(KEY);
    expect(fs.existsSync(path.join(w.dir, 'mods'))).toBe(false);
  });

  it('refuses a bad or taken id, an unknown field, a bad auth, and a protocol that is not an API one', async () => {
    const w = await boot();
    const idWords = 'The id must be lowercase letters, digits and dashes, start with a letter or digit, be at most 40 long, and not be a name Windows reserves.';
    for (const id of ['Mine', '../mine', 'a/b', 'a:b', 'nul', 'con', '-x', 'x'.repeat(41), '', 5]) {
      const r = await w.call('POST', '/api/mods/custom', { body: body({ id }) });
      expect([String(id), r.status, r.json.error]).toEqual([String(id), 400, idWords]);
    }
    const mk = await w.call('POST', '/api/mods/custom', { body: body() });
    expect(mk.status).toBe(200);
    for (const id of ['mine', 'claude-code', 'openai-chat', 'alpha']) {
      const r = await w.call('POST', '/api/mods/custom', { body: body({ id }) });
      expect([id, r.status, r.json.error]).toEqual([id, 409, `\`${id}\` already exists. Pick another id.`]);
    }
    expect((await w.call('POST', '/api/mods/custom', { body: body({ id: 'o', apiKey: KEY }) })).json.error).toBe('`apiKey` is not a field of a custom endpoint.');
    expect((await w.call('POST', '/api/mods/custom', { body: body({ id: 'o', auth: { style: 'cookie' } }) })).json.error).toBe('`auth.style` must be bearer, header or none.');
    expect((await w.call('POST', '/api/mods/custom', { body: body({ id: 'o', auth: { style: 'header' } }) })).json.error).toBe('`auth.header` must name the header that carries the key.');
    expect((await w.call('POST', '/api/mods/custom', { body: body({ id: 'o', auth: { style: 'bearer', keyEnv: 'AWS_SECRET_ACCESS_KEY' } }) })).json.error).toContain('is not a key name Reins will read for a mod');
    expect((await w.call('POST', '/api/mods/custom', { body: body({ id: 'o', protocol: 'nope' }) })).json.error).toContain('which is not installed. Installed:');
    expect((await w.call('POST', '/api/mods/custom', { body: body({ id: 'o', protocol: 'claude-code-cli' }) })).json.error).toBe('`o`: `protocol` "claude-code-cli" is not an API protocol. A custom endpoint needs one.');
    expect((await w.call('POST', '/api/mods/custom', { body: body({ id: 'o', defaultModel: 'zz', models: [{ id: 'm1' }] }) })).json.error).toBe('`o`: `defaultModel` `zz` is not in `models`.');
    expect((await w.call('POST', '/api/mods/custom', { body: body({ id: 'o', label: ' ' }) })).json.error).toBe('`label` is missing.');
    expect(fs.readdirSync(path.join(w.dir, 'mods'))).toEqual(['mine']);
  });

  it('is size capped like the other routes', async () => {
    const w = await boot();
    const r = await w.call('POST', '/api/mods/custom', { body: body({ description: 'x'.repeat(1024 * 1024 + 10) }) });
    expect([r.status, r.json.error]).toEqual([413, 'The body is larger than 1 MB.']);
    expect((await w.call('POST', '/api/mods/custom', { raw: '{nope' })).status).toBe(400);
    const big = await w.call('POST', '/api/mods/custom', { body: body({ description: 'x'.repeat(300 * 1024) }) });
    expect([big.status, big.json.error]).toEqual([400, 'The manifest is larger than 256 KB.']);
    expect(fs.existsSync(path.join(w.dir, 'mods', 'mine'))).toBe(false);
  });
});

describe('PUT /api/mods/:id', () => {
  it('edits fields of an installed provider; the next state shows them; null removes a field', async () => {
    const w = await boot();
    await w.call('POST', '/api/mods/install', { body: { ids: ['beta'] } });
    const r = await w.call('PUT', '/api/mods/beta', { body: { label: 'Beta 2', baseUrl: 'http://localhost:9/v2', models: [{ id: 'beta-m' }, { id: 'b2' }], defaultModel: 'b2', price: null, efforts: [{ id: 'lo', label: 'Lo' }], defaultEffort: 'lo' } });
    expect([r.status, r.json]).toEqual([200, { ok: true, id: 'beta', reloaded: true }]);
    const file = JSON.parse(read(w.modFile('beta')).toString());
    expect(file).toMatchObject({ id: 'beta', kind: 'provider', label: 'Beta 2', baseUrl: 'http://localhost:9/v2', defaultModel: 'b2', defaultEffort: 'lo' });
    expect(file).not.toHaveProperty('price');
    const p = (await w.state()).providers.find((x) => x.id === 'beta');
    expect(p).toMatchObject({ label: 'Beta 2', defaultModel: 'b2' });
    expect((await w.list()).mods.find((m) => m.id === 'beta')!.label).toBe('Beta 2');
  });

  it('an invalid edit writes nothing: the file is byte-identical, its time is unchanged, and the provider still works', async () => {
    const w = await boot();
    await w.call('POST', '/api/mods/custom', { body: { id: 'mine', label: 'Mine', baseUrl: 'http://127.0.0.1:9/v1', protocol: 'openai-chat', defaultModel: 'm1' } });
    const before = read(w.modFile('mine'));
    const mtime = fs.statSync(w.modFile('mine')).mtimeMs;
    const dirBefore = fs.readdirSync(w.dir).sort();
    for (const [change, words] of [
      [{ defaultModel: 'gone' }, '`mine`: `defaultModel` `gone` is not in `models`.'],
      [{ baseUrl: 'file:///etc/passwd' }, '`mine`: `baseUrl` must be an http or https address (got "file:///etc/passwd").'],
      [{ price: { input: -1, output: 1 } }, '`mine`: `price.input` must be a number of 0 or more (got -1).'],
      [{ headers: { Authorization: KEY } }, '`mine`: `headers.Authorization` holds what looks like a key. Keys go in Settings > Providers, never in a mod.'],
      [{ modelsUrl: 'https://other.test/models' }, '`mine`: `modelsUrl` must be on the same address as `baseUrl` (http://127.0.0.1:9), got https://other.test.'],
      [{ auth: { style: 'bearer', keyEnv: ['AWS_SECRET_ACCESS_KEY'] } }, '`mine`: `auth.keyEnv` `AWS_SECRET_ACCESS_KEY` is not a key name Reins will read for a mod; names must end in _API_KEY, _KEY or _TOKEN.'],
    ] as const) {
      const r = await w.call('PUT', '/api/mods/mine', { body: change });
      expect([JSON.stringify(change), r.status, r.json.error]).toEqual([JSON.stringify(change), 400, words]);
      expect(r.text).not.toContain(KEY);
      expect(read(w.modFile('mine'))).toEqual(before);
      expect(fs.statSync(w.modFile('mine')).mtimeMs).toBe(mtime);
    }
    expect(fs.readdirSync(w.dir).sort()).toEqual(dirBefore); // no temp file left
    const p = (await w.state()).providers.find((x) => x.id === 'mine');
    expect(p).toMatchObject({ label: 'Mine', defaultModel: 'm1' });
    expect((await w.list()).mods.find((m) => m.id === 'mine')!.problems).toEqual([]);
  });

  it('refuses a key, a locked field, an unknown field, a built-in mod, a missing mod and a bad id, with words', async () => {
    const w = await boot();
    await w.call('POST', '/api/mods/install', { body: { ids: ['alpha'] } });
    const before = read(w.modFile('alpha'));
    const put = async (id: string, b: unknown) => { const r = await w.call('PUT', `/api/mods/${id}`, { body: b }); return [r.status, r.json.error]; };
    expect(await put('alpha', { key: KEY })).toEqual([400, 'Keys go in Settings > Providers or the key field of a custom endpoint, never in a mod file.']);
    expect(await put('alpha', { id: 'other' })).toEqual([400, '`id` cannot be changed here. Remove the provider and add it again.']);
    expect(await put('alpha', { protocol: 'anthropic-messages' })).toEqual([400, '`protocol` cannot be changed here. Remove the provider and add it again.']);
    expect(await put('alpha', { main: 'x.js' })).toEqual([400, '`main` cannot be changed here. Remove the provider and add it again.']);
    expect(await put('alpha', { apiKey: KEY })).toEqual([400, '`apiKey` is not a field Reins lets you edit.']);
    expect(await put('claude-code', { label: 'Mine' })).toEqual([409, '`claude-code` is built in and cannot be edited. Disable it, or add your own endpoint.']);
    expect(await put('openai-chat', { label: 'Mine' })).toEqual([409, '`openai-chat` is built in and cannot be edited. Disable it, or add your own endpoint.']);
    expect(await put('nothere', { label: 'x' })).toEqual([404, 'No mod `nothere` is installed.']);
    expect(await put('Bad..Id', { label: 'x' })).toEqual([400, BAD_ID_WORDS]);
    expect(read(w.modFile('alpha'))).toEqual(before);
    expect(JSON.parse((await w.call('GET', '/api/mods')).text).mods.find((m: { id: string }) => m.id === 'claude-code').label).toBe('Claude');
  });

  it('two edits at once leave one whole valid file', async () => {
    const w = await boot();
    await w.call('POST', '/api/mods/install', { body: { ids: ['alpha'] } });
    const labels = Array.from({ length: 12 }, (_, i) => `Label ${i}`);
    const rs = await Promise.all(labels.map((label, i) => w.call('PUT', '/api/mods/alpha', { body: { label, description: `d${i}`.repeat(2000 + i) } })));
    expect(rs.map((r) => r.status)).toEqual(labels.map(() => 200));
    const file = JSON.parse(read(w.modFile('alpha')).toString());
    expect(labels).toContain(file.label);
    expect(file.description).toBe(`d${labels.indexOf(file.label)}`.repeat(2000 + labels.indexOf(file.label))); // label and description from the same edit
    expect(file).toMatchObject({ id: 'alpha', kind: 'provider', protocol: 'openai-chat' });
    expect((await w.list()).mods.find((m) => m.id === 'alpha')).toMatchObject({ label: file.label, problems: [] });
    expect(fs.readdirSync(w.dir).filter((n) => n.startsWith('.mod-'))).toEqual([]);
  });
});

describe('POST /api/mods/:id/enable and disable', () => {
  it('a disabled provider leaves the state and cannot start a session; enabling brings it back; the choice survives a restart', async () => {
    const w = await boot();
    await w.call('POST', '/api/mods/install', { body: { ids: ['alpha'] } });
    const off = await w.call('POST', '/api/mods/alpha/disable');
    expect([off.status, off.json]).toEqual([200, { ok: true, id: 'alpha', enabled: false, reloaded: true }]);
    expect((await w.list()).mods.find((m) => m.id === 'alpha')).toMatchObject({ enabled: false, problems: [] });
    expect((await w.state()).providers.map((p) => p.id)).toEqual(['claude-code']);
    const s = await w.call('POST', '/api/sessions', { body: { cwd: w.proj, engine: 'alpha' } });
    expect([s.status, s.json.error]).toEqual([400, 'No provider `alpha` is installed.']);
    expect(read(path.join(w.dir, 'disabled-mods.json')).toString()).toContain('"alpha"');
    // a second process reading the same home sees the same choice
    const again = await startMods({ dir: w.dir, env: {} });
    expect(again.mods.find((m) => m.id === 'alpha')!.enabled).toBe(false);
    again.dispose();
    const on = await w.call('POST', '/api/mods/alpha/enable');
    expect([on.status, on.json.enabled]).toEqual([200, true]);
    expect((await w.state()).providers.map((p) => p.id)).toEqual(['alpha', 'claude-code']);
    expect((await w.call('POST', '/api/sessions', { body: { cwd: w.proj, engine: 'alpha' } })).status).toBe(200);
  });

  it('claude-code can be disabled and enabled; an unknown or invalid id gets words', async () => {
    const w = await boot();
    expect((await w.call('POST', '/api/mods/claude-code/disable')).status).toBe(200);
    expect((await w.list()).mods.find((m) => m.id === 'claude-code')).toMatchObject({ enabled: false });
    expect((await w.state()).providers).toEqual([]);
    expect((await w.call('POST', '/api/mods/claude-code/enable')).status).toBe(200);
    expect((await w.state()).providers.map((p) => p.id)).toEqual(['claude-code']);
    const no = await w.call('POST', '/api/mods/nothere/disable');
    expect([no.status, no.json.error]).toEqual([404, 'No mod `nothere` is installed.']);
    const bad = await w.call('POST', '/api/mods/A%2FB/disable');
    expect([bad.status, bad.json.error]).toEqual([400, BAD_ID_WORDS]);
  });
});

describe('DELETE /api/mods/:id', () => {
  it('removes the folder; the next list and state drop it; the key stays in the secrets file', async () => {
    const w = await boot();
    await w.call('POST', '/api/mods/install', { body: { ids: ['alpha', 'beta'] } });
    setKey(w.dir, 'alpha', KEY);
    await w.call('POST', '/api/mods/beta/disable');
    const r = await w.call('DELETE', '/api/mods/alpha');
    expect([r.status, r.json]).toEqual([200, { ok: true, id: 'alpha', reloaded: true }]);
    expect(fs.existsSync(path.join(w.dir, 'mods', 'alpha'))).toBe(false);
    expect(ids(await w.list())).not.toContain('alpha');
    expect((await w.list()).chooser.map((c) => c.id)).toEqual(['alpha']);
    expect((await w.state()).providers.map((p) => p.id)).toEqual(['claude-code']);
    expect(readSecrets(w.dir).get('alpha')).toBe(KEY);
    // removing a disabled mod also drops its off mark, so a later install is on
    expect((await w.call('DELETE', '/api/mods/beta')).status).toBe(200);
    expect(JSON.parse(read(path.join(w.dir, 'disabled-mods.json')).toString())).toEqual([]);
    const miss = await w.call('DELETE', '/api/mods/alpha');
    expect([miss.status, miss.json.error]).toEqual([404, 'No mod `alpha` is installed.']);
  });

  it('claude-code and the other built-in mods cannot be removed, only disabled', async () => {
    const w = await boot();
    for (const id of ['claude-code', 'claude-code-cli', 'openai-chat']) {
      const r = await w.call('DELETE', `/api/mods/${id}`);
      expect([id, r.status, r.json.error]).toEqual([id, 409, `\`${id}\` is built in and cannot be removed. You can disable it.`]);
    }
    expect(ids(await w.list())).toContain('claude-code');
    expect((await w.state()).providers.map((p) => p.id)).toEqual(['claude-code']);
    // a disabled built-in mod is still there and still cannot be removed
    await w.call('POST', '/api/mods/claude-code/disable');
    expect((await w.call('DELETE', '/api/mods/claude-code')).status).toBe(409);
    expect(ids(await w.list())).toContain('claude-code');
  });

  it('an id with path characters is refused before any file is touched, on every route that takes an id', async () => {
    const w = await boot();
    await w.call('POST', '/api/mods/install', { body: { ids: ['alpha'] } });
    const victim = path.join(w.dir, 'victim.txt');
    fs.writeFileSync(victim, 'keep me');
    fs.writeFileSync(path.join(w.root, 'outside.txt'), 'keep me too');
    const touched: string[] = [];
    for (const name of ['lstatSync', 'statSync', 'existsSync', 'readFileSync', 'readdirSync', 'writeFileSync', 'renameSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'mkdirSync', 'openSync'] as const) {
      const real = (fs as any)[name] as (...a: unknown[]) => unknown;
      vi.spyOn(fs as any, name).mockImplementation((...a: unknown[]) => { touched.push(`${name}(${String(a[0])})`); return real(...a); });
    }
    const bad = ['..%2Fvictim.txt', '..%5Cvictim.txt', '..%2F..%2Foutside.txt', 'a%2Fb', 'a%5Cb', 'a%3Ab', 'ALPHA', 'nul', '%00', 'x'.repeat(41), '.%2E', '%E0%A4%A'];
    const routes: Array<[string, (id: string) => string]> = [['DELETE', (id) => `/api/mods/${id}`], ['PUT', (id) => `/api/mods/${id}`], ['POST', (id) => `/api/mods/${id}/enable`], ['POST', (id) => `/api/mods/${id}/disable`], ['POST', (id) => `/api/mods/${id}/reinstall`]];
    const out: unknown[] = [];
    for (const id of bad) {
      for (const [method, url] of routes) {
        const r = await w.call(method, url(id), { body: { label: 'x' } });
        out.push([method, id, r.status, r.json?.error]);
      }
    }
    // The redactor that hides secrets in every answer looks at secrets.json's time on each response; that is not the mod id at work.
    const spied = touched.filter((c) => !c.includes('secrets.json'));
    vi.restoreAllMocks();
    expect(out.every((x) => (x as unknown[])[2] === 400 || (x as unknown[])[2] === 404)).toBe(true);
    expect(out.filter((x) => (x as unknown[])[2] === 400 && (x as unknown[])[3] !== BAD_ID_WORDS)).toEqual([]);
    // the ids that are not an id at all never reach a file call (the 404s are plain no-route answers)
    expect(spied).toEqual([]);
    expect(read(victim).toString()).toBe('keep me');
    expect(read(path.join(w.root, 'outside.txt')).toString()).toBe('keep me too');
    expect(ids(await w.list())).toContain('alpha');
  });

  it('removing a provider a session uses: the running turn finishes, the next reply is refused with the 9.4 words', async () => {
    const f = await startFakeProvider();
    closers.push(() => f.close());
    const w = await boot({ prep: (dir) => {
      fs.mkdirSync(path.join(dir, 'mods', 'live'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'mods', 'live', 'mod.json'), JSON.stringify(prov('live', { baseUrl: `${f.url}/v1`, auth: { style: 'none', keyEnv: [] }, price: { input: 0, output: 0 } })));
    } });
    const s = await w.call('POST', '/api/sessions', { body: { cwd: w.proj, engine: 'live' } });
    expect(s.status, s.text).toBe(200);
    const id = s.json.id as string;
    f.push({ text: 'the whole answer', hangMs: 500 });
    const first = await w.call('POST', `/api/sessions/${id}/message`, { body: { text: 'hello' } });
    expect(first.status, first.text).toBe(200);
    await until(() => f.requests.some((r) => r.path.endsWith('/chat/completions')));
    const gone = await w.call('DELETE', '/api/mods/live');
    expect(gone.status).toBe(200);
    const mid = (await w.state()).sessions.find((x) => x.id === id)!;
    expect(mid.provider.status).toBe('missing');
    await until(() => w.store.readLog(id).some((r) => r.type === 'turn_ended'), 10_000);
    expect(JSON.stringify(w.store.readLog(id))).toContain('the whole answer');
    const next = await w.call('POST', `/api/sessions/${id}/message`, { body: { text: 'again' } });
    expect([next.status, next.json.error]).toEqual([409, 'This session uses live, which is not installed. Install it in Settings > Providers, or start a new session.']);
    expect(f.requests.filter((r) => r.path.endsWith('/chat/completions'))).toHaveLength(1);
  });
});

describe('POST /api/mods/:id/reinstall', () => {
  it('replaces the installed copy from the catalog and leaves the secrets file untouched', async () => {
    const w = await boot();
    await w.call('POST', '/api/mods/install', { body: { ids: ['alpha'] } });
    setKey(w.dir, 'alpha', KEY);
    const secrets = path.join(w.dir, 'secrets.json');
    const secretsBytes = read(secrets);
    const secretsTime = fs.statSync(secrets).mtimeMs;
    const catalogBytes = read(path.join(w.catalogDir, 'alpha', 'mod.json'));
    expect((await w.call('PUT', '/api/mods/alpha', { body: { label: 'My own label', baseUrl: 'https://mine.test/v1' } })).status).toBe(200);
    expect(read(w.modFile('alpha'))).not.toEqual(catalogBytes);
    const r = await w.call('POST', '/api/mods/alpha/reinstall');
    expect([r.status, r.json]).toEqual([200, { ok: true, id: 'alpha', reloaded: true }]);
    expect(read(w.modFile('alpha'))).toEqual(catalogBytes);
    expect((await w.state()).providers.find((p) => p.id === 'alpha')!.label).toBe('ALPHA');
    expect(read(secrets)).toEqual(secretsBytes);
    expect(fs.statSync(secrets).mtimeMs).toBe(secretsTime);
    expect(readSecrets(w.dir).get('alpha')).toBe(KEY);
    expect(fs.readdirSync(w.dir).filter((n) => n.startsWith('.mod-'))).toEqual([]);
    expect(fs.readdirSync(path.join(w.dir, 'mods'))).toEqual(['alpha']);
  });

  it('refuses a built-in mod, a custom endpoint, a missing mod, and a catalog copy that is invalid; the old copy stays', async () => {
    const w = await boot();
    await w.call('POST', '/api/mods/install', { body: { ids: ['alpha'] } });
    await w.call('POST', '/api/mods/custom', { body: { id: 'mine', label: 'Mine', baseUrl: 'https://x.test/v1', protocol: 'openai-chat', defaultModel: 'm' } });
    const post = async (id: string) => { const r = await w.call('POST', `/api/mods/${id}/reinstall`); return [r.status, r.json.error]; };
    expect(await post('claude-code')).toEqual([409, '`claude-code` is built in and has no catalog copy to install.']);
    expect(await post('mine')).toEqual([404, '`mine` is not in the catalog, so there is nothing to install again.']);
    expect(await post('nothere')).toEqual([404, 'No mod `nothere` is installed.']);
    const before = read(w.modFile('alpha'));
    fs.writeFileSync(path.join(w.catalogDir, 'alpha', 'mod.json'), JSON.stringify(prov('alpha', { baseUrl: 'file:///x' })));
    expect(await post('alpha')).toEqual([400, '`alpha`: `baseUrl` must be an http or https address (got "file:///x").']);
    expect(read(w.modFile('alpha'))).toEqual(before);
  });
});

describe('reload', () => {
  it('a read that fails as a whole keeps the old registry and reports the problem; the next good read recovers', async () => {
    const w = await boot();
    await w.call('POST', '/api/mods/install', { body: { ids: ['alpha'] } });
    expect(ids(w.mods)).toContain('alpha');
    // the mods folder becomes a file: it cannot be read
    fs.rmSync(path.join(w.dir, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(w.dir, 'mods'), 'not a folder');
    const r = await w.call('POST', '/api/mods/alpha/disable');
    expect(r.status).toBe(200);
    expect(r.json.reloaded).toBe(false);
    expect(r.json.problems.join(' ')).toMatch(/mods folder could not be read/);
    // the old state still answers
    expect((await w.list()).mods.find((m) => m.id === 'alpha')).toMatchObject({ enabled: true });
    expect((await w.state()).providers.map((p) => p.id)).toEqual(['alpha', 'claude-code']);
    expect(ids(w.mods)).toContain('alpha');
    fs.rmSync(path.join(w.dir, 'mods'));
    expect((await w.call('POST', '/api/mods/claude-code/enable')).json.reloaded).toBe(true);
    expect((await w.state()).providers.map((p) => p.id)).toEqual(['claude-code']); // alpha was off and its folder is gone
  });

  it('swaps the registry inside the same Mods object, so an engine factory built earlier sees it', async () => {
    const w = await boot();
    const factory = makeEngineFrom(w.mods, { env: {}, home: w.dir });
    expect(() => factory({ provider: 'alpha', onApprove: async () => ({ behavior: 'deny' }), onLive: () => {} } as never)).toThrow('The provider "alpha" is not installed.');
    await w.call('POST', '/api/mods/install', { body: { ids: ['alpha'] } });
    expect(() => factory({ provider: 'alpha', onApprove: async () => ({ behavior: 'deny' }), onLive: () => {} } as never)).not.toThrow();
  });

  it('error bodies are plain words: no stack, no path, no key', async () => {
    const w = await boot();
    const probes = [
      await w.call('PUT', '/api/mods/nothere', { body: { label: 'x' } }),
      await w.call('POST', '/api/mods/custom', { body: { id: 'a', label: 'A', baseUrl: 'file:///etc/passwd', protocol: 'openai-chat', defaultModel: 'm', key: KEY } }),
      await w.call('DELETE', '/api/mods/claude-code'),
      await w.call('POST', '/api/mods/install', { body: { ids: ['nope', 'badcat'] } }),
    ];
    for (const r of probes) {
      expect(r.text).not.toContain(w.root);
      expect(r.text).not.toContain(KEY);
      expect(r.text).not.toMatch(/\bat \S+ \(|\.ts:\d+/);
    }
  });
});

describe('size caps', () => {
  it('an edit that would make the manifest larger than 256 KB is refused and writes nothing', async () => {
    const w = await boot();
    await w.call('POST', '/api/mods/custom', { body: { id: 'mine', label: 'Mine', baseUrl: 'http://127.0.0.1:9/v1', protocol: 'openai-chat', defaultModel: 'm1' } });
    const before = read(w.modFile('mine'));
    const r = await w.call('PUT', '/api/mods/mine', { body: { description: 'x'.repeat(300_000) } });
    expect([r.status, r.json.error]).toEqual([400, 'The manifest is larger than 256 KB.']);
    expect(read(w.modFile('mine'))).toEqual(before);
  });

  it('an install list longer than 50 ids is refused as a whole', async () => {
    const w = await boot();
    const r = await w.call('POST', '/api/mods/install', { body: { ids: Array.from({ length: 51 }, (_, i) => `p${i}`) } });
    expect([r.status, r.json.error]).toEqual([400, 'ids must be a list of provider ids.']);
  });
});
