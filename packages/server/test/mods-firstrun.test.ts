// Milestone P, Task 24 (spec 7.3): the two server pieces of the first-run screen. `POST /api/mods/first-run/done` (Skip, and a first install)
// and the `local` flag of a chooser entry (a local program that answers a plain GET of its model list within a second). A real server over HTTP on
// a temp Reins folder, a temp catalog, the fake provider server. No network, no key.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyEnvNames, makeEngineFrom, startMods } from '../src/engines.js';
import { Redactor, readSecrets } from '../src/secrets.js';
import { makeSend } from '../src/send.js';
import { startServer, type Server } from '../src/server.js';
import { openStore, type Store } from '../src/store.js';
import type { Mods } from '../src/mods/types.js';
import { startFakeProvider } from './fake-provider.js';
import { PROBE } from './http-helpers.js';

const rm = (d: string) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the OS */ } };

const prov = (id: string, over: Record<string, unknown> = {}) => ({
  reins: 1, id, kind: 'provider', version: '1.0.0', label: id.toUpperCase(), description: `The ${id} test provider`, protocol: 'openai-chat',
  baseUrl: `https://api.${id}.test/v1`, auth: { style: 'bearer', keyEnv: [`${id.toUpperCase()}_API_KEY`] },
  defaultModel: `${id}-m`, models: [{ id: `${id}-m`, label: 'M', price: { input: 1, output: 2 } }], untested: true, ...over,
});
const keyless = (id: string, baseUrl: string, over: Record<string, unknown> = {}) => prov(id, { baseUrl, auth: { style: 'none', keyEnv: [] }, price: { input: 0, output: 0 }, ...over });

interface World {
  root: string; dir: string; mods: Mods; store: Store; srv: Server;
  call: (method: string, url: string, o?: { body?: unknown; auth?: boolean; headers?: Record<string, string> }) => Promise<{ status: number; json: any }>;
  list: () => Promise<{ firstRun: boolean; chooser: Array<{ id: string; local: boolean }> }>;
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

async function boot(catalog: Record<string, unknown>, o: { prep?: (dir: string) => void } = {}): Promise<World> {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-firstrun-')));
  const dir = path.join(root, '.reins');
  const catalogDir = path.join(root, 'catalog');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, m] of Object.entries(catalog)) {
    fs.mkdirSync(path.join(catalogDir, id), { recursive: true });
    fs.writeFileSync(path.join(catalogDir, id, 'mod.json'), JSON.stringify(m, null, 2));
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
    const payload = c.body !== undefined ? JSON.stringify(c.body) : undefined;
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
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
  const w: World = { root, dir, mods, store, srv, call, list: async () => (await call('GET', '/api/mods')).json };
  worlds.push(w);
  return w;
}

const flagsOf = async (w: World) => Object.fromEntries((await w.list()).chooser.map((c) => [c.id, c.local]));
/** A fetch that records the address of every call and then does the real thing. */
function spyFetch(): string[] {
  const real = globalThis.fetch;
  const seen: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    seen.push(String(input instanceof Request ? input.url : input));
    return real(input, init);
  });
  return seen;
}

describe('POST /api/mods/first-run/done', () => {
  it('writes the marker and makes the empty mods folder; the list then says it is not the first run; it can be repeated', async () => {
    const w = await boot({ alpha: prov('alpha') });
    expect(fs.existsSync(path.join(w.dir, 'mods'))).toBe(false);
    expect((await w.list()).firstRun).toBe(true);
    for (let i = 0; i < 2; i++) {
      const r = await w.call('POST', '/api/mods/first-run/done');
      expect([r.status, r.json]).toEqual([200, { ok: true }]);
    }
    expect(fs.readdirSync(path.join(w.dir, 'mods'))).toEqual([]);
    expect(fs.readFileSync(path.join(w.dir, 'first-run-done'), 'utf8')).toBe('');
    expect((await w.list()).firstRun).toBe(false);
    // nothing was installed, no secret was made, no temp name was left
    expect((await w.list()).chooser.map((c) => c.id)).toEqual(['alpha']);
    expect(fs.existsSync(path.join(w.dir, 'secrets.json'))).toBe(false);
    expect(fs.readdirSync(w.dir).filter((n) => n.startsWith('.mod-'))).toEqual([]);
  });

  it('needs the token, the Host and the Origin like every /api route, and answers 404 to GET', async () => {
    const w = await boot({});
    expect((await w.call('POST', '/api/mods/first-run/done', { auth: false })).status).toBe(401);
    expect((await w.call('POST', '/api/mods/first-run/done', { headers: { origin: 'http://evil.test' } })).status).toBe(403);
    expect((await w.call('POST', '/api/mods/first-run/done', { headers: { host: 'evil.test' } })).status).toBe(403);
    expect((await w.call('GET', '/api/mods/first-run/done')).status).toBe(404);
    expect(fs.existsSync(path.join(w.dir, 'first-run-done'))).toBe(false);
  });

  it('an install that put a provider in also writes the marker; one that put none in does not', async () => {
    const w = await boot({ alpha: prov('alpha') });
    const no = await w.call('POST', '/api/mods/install', { body: { ids: ['nope'] } });
    expect(no.json.results).toEqual([{ id: 'nope', ok: false, error: 'is not in the catalog.' }]);
    expect(fs.existsSync(path.join(w.dir, 'first-run-done'))).toBe(false);
    expect((await w.call('POST', '/api/mods/install', { body: { ids: ['alpha'] } })).json.results).toEqual([{ id: 'alpha', ok: true }]);
    expect(fs.existsSync(path.join(w.dir, 'first-run-done'))).toBe(true);
    expect((await w.list()).firstRun).toBe(false);
  });
});

describe('the local flag of a chooser entry', () => {
  it('is true for a keyless entry on a local address that answers 2xx, false for a closed port, a key, a status or a redirect', async () => {
    const fake = await startFakeProvider();
    closers.push(() => fake.close());
    const other = await startFakeProvider();
    closers.push(() => other.close());
    const closed = await startFakeProvider();
    const closedUrl = closed.url;
    await closed.close();
    const w = await boot({
      up: keyless('up', `${fake.url}/v1`),
      down: keyless('down', `${closedUrl}/v1`),
      keyed: prov('keyed', { baseUrl: `${fake.url}/v1` }),
      own: keyless('own', `${fake.url}/v1`, { modelsUrl: `${fake.url}/v1/models` }),
    });
    expect(await flagsOf(w)).toEqual({ up: true, down: false, keyed: false, own: true });
    // the probe is one plain GET: the default headers only, no key, no cookie, no body
    const asked = fake.requests.filter((r) => r.path === '/v1/models');
    expect(asked).toHaveLength(2);
    for (const r of asked) {
      expect(Object.keys(r.headers).filter((h) => /^(authorization|cookie|x-api-key|content-type|content-length)$/i.test(h))).toEqual([]);
      expect(r.body).toBeUndefined();
    }
    // a failing status is false
    fake.list.status = 503;
    expect(await flagsOf(w)).toMatchObject({ up: false, own: false });
    // a redirect is refused, not followed
    fake.list.status = undefined;
    fake.list.redirectTo = `${other.url}/v1/models`;
    expect(await flagsOf(w)).toMatchObject({ up: false });
    expect(other.requests).toEqual([]);
  });

  it('is only asked on the first run: once it is done the list makes no request to a local address', async () => {
    const fake = await startFakeProvider();
    closers.push(() => fake.close());
    const w = await boot({ up: keyless('up', `${fake.url}/v1`) });
    expect(await flagsOf(w)).toEqual({ up: true });
    const before = fake.requests.length;
    await w.call('POST', '/api/mods/first-run/done');
    expect(await flagsOf(w)).toEqual({ up: false });
    expect(fake.requests.length).toBe(before);
  });

  it('never sends a request to an address that is not local', async () => {
    const fake = await startFakeProvider();
    closers.push(() => fake.close());
    const seen = spyFetch();
    const w = await boot({
      far: keyless('far', 'http://models.far-away.test/v1'),
      lan: keyless('lan', 'http://192.168.1.5:11434/v1'),
      near: keyless('near', `${fake.url}/v1`),
    });
    expect(await flagsOf(w)).toEqual({ far: false, lan: false, near: true });
    expect(seen.filter((u) => !u.startsWith(fake.url))).toEqual([]);
    expect(seen.filter((u) => u.startsWith(fake.url))).toEqual([`${fake.url}/v1/models`]);
    expect(fake.requests.map((r) => r.path)).toEqual(['/v1/models']);
  });

  it('asks every loopback spelling and nothing that only looks like one', async () => {
    const seen = spyFetch();
    const w = await boot({
      v6: keyless('v6', 'http://[::1]:9/v1'),
      v4: keyless('v4', 'http://127.0.0.2:9/v1'),
      name: keyless('name', 'http://localhost:9/v1'),
      lookalike: keyless('lookalike', 'http://127.0.0.1.example.test:9/v1'),
      any: keyless('any', 'http://0.0.0.0:9/v1'),
      userinfo: keyless('userinfo', 'http://user:pw@127.0.0.1:9/v1'),
    });
    const flags = await flagsOf(w);
    expect(Object.values(flags).every((v) => v === false)).toBe(true);
    expect(seen.filter((u) => u.includes(':9/')).sort()).toEqual(['http://127.0.0.2:9/v1/models', 'http://[::1]:9/v1/models', 'http://localhost:9/v1/models']);
  });

  it('waits at most a second for a slow program, all entries together, and after an install (the first run is over) nothing is asked', async () => {
    const slow = await startFakeProvider();
    closers.push(() => slow.close());
    slow.list.hangMs = 4000;
    const w = await boot({
      s1: keyless('s1', `${slow.url}/v1`), s2: keyless('s2', `${slow.url}/v1`), s3: keyless('s3', `${slow.url}/v1`), s4: keyless('s4', `${slow.url}/v1`),
    });
    const t0 = Date.now();
    expect(await flagsOf(w)).toEqual({ s1: false, s2: false, s3: false, s4: false });
    expect(Date.now() - t0).toBeLessThan(2500);
    await w.call('POST', '/api/mods/install', { body: { ids: ['s1'] } });
    const before = slow.requests.length;
    expect(Object.keys(await flagsOf(w))).toEqual(['s2', 's3', 's4']);
    expect(slow.requests.length - before).toBe(0);
  }, 30_000);
});
