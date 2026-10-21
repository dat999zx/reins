// Milestone P, Task 29 phase C (S4, S5): the import summary says where prompts go, which saved key and which key variables it would use, a
// user mod cannot make itself the default provider, and the trust route trusts exactly the installed bytes the user was shown.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyEnvNames, makeEngineFrom, startMods } from '../src/engines.js';
import { importPreview, type ModEnv } from '../src/mods/actions.js';
import { hashFiles } from '../src/mods/loader.js';
import { Redactor, readSecrets, setKey } from '../src/secrets.js';
import { makeSend } from '../src/send.js';
import { startServer, type Server } from '../src/server.js';
import { openStore, type Store } from '../src/store.js';
import type { Mods } from '../src/mods/types.js';
import { PROBE } from './http-helpers.js';

const KEY = 'sk-test-0123456789abcdef';
const rm = (d: string) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the OS */ } };

interface World { root: string; dir: string; mods: Mods; store: Store; srv: Server; marker: string; call: (method: string, url: string, body?: unknown) => Promise<{ status: number; json: any; text: string }>; env: (over?: Partial<ModEnv>) => ModEnv }
const worlds: World[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const w of worlds.splice(0)) { await w.srv.close(); w.store.close(); w.mods.dispose(); rm(w.root); }
});

async function boot(): Promise<World> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29c-')));
  const dir = path.join(root, '.reins');
  fs.mkdirSync(dir, { recursive: true });
  const mods = await startMods({ dir, env: {} });
  const redactor = new Redactor({ home: dir, env: {}, keyEnvNames: () => keyEnvNames(mods) });
  const send = makeSend({ secrets: () => readSecrets(dir), env: {}, redactor, consent: () => true });
  const store = openStore(':memory:');
  const srv = await startServer({
    store, dir, mods, env: {}, catalogDir: path.join(root, 'no-catalog'), redactor, send, consent: () => undefined, probe: async () => PROBE,
    makeEngine: makeEngineFrom(mods, { env: {}, home: dir, send }),
  });
  const call: World['call'] = (method, url, body) => new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({
      host: '127.0.0.1', port: srv.port, path: url, method, agent: false,
      headers: { authorization: `Bearer ${srv.token}`, ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (text += d));
      res.on('end', () => { let json: unknown; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; } resolve({ status: res.statusCode ?? 0, json, text }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
  const w: World = {
    root, dir, mods, store, srv, call, marker: path.join(root, 'marker.log'),
    env: (over = {}) => ({
      home: dir, catalogDir: path.join(root, 'no-catalog'), mods, consent: { has: () => false, grant: () => {}, revoke: () => {} },
      send: async () => new Response(''), env: {}, redact: (t: string) => t, holdsSecret: (t: string) => t.includes(KEY), ...over,
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
const file = (m: unknown) => ({ reinsMod: 1, files: { 'mod.json': JSON.stringify(m, null, 2) } });
const reachOf = (r: { body: any }): string[] => r.body.summary.reach;

describe('import summary: where it goes (S4)', () => {
  it('a keyless provider still says where prompts and files go', async () => {
    const w = await boot();
    const r = importPreview(w.env(), file(prov('acme', { auth: { style: 'none', keyEnv: [] } })));
    expect(reachOf(r)).toEqual(['sends your prompts and files to api.acme.test']);
  });
  it('a provider with no auth block at all says it too', async () => {
    const w = await boot();
    const m: Record<string, unknown> = prov('acme');
    delete m.auth;
    expect(reachOf(importPreview(w.env(), file(m)))).toEqual(['sends your prompts and files to api.acme.test']);
  });
  it('plain http to another machine says "over plain http"; localhost does not', async () => {
    const w = await boot();
    expect(reachOf(importPreview(w.env(), file(prov('acme', { baseUrl: 'http://api.acme.test/v1' }))))[0]).toBe('sends your prompts and files to api.acme.test over plain http');
    expect(reachOf(importPreview(w.env(), file(prov('acme', { baseUrl: 'http://localhost:1234/v1', auth: { style: 'none', keyEnv: [] } }))))[0]).toBe('sends your prompts and files to localhost:1234');
  });
  it('a protocol mod has no such line', async () => {
    const w = await boot();
    const r = importPreview(w.env(), file({ reins: 1, id: 'plain-wire', kind: 'protocol', version: '1.0.0', label: 'P' }));
    expect((r.body as any).summary.reach).toEqual([]);
  });
  it('says "uses the key saved for <id>" when Reins holds one for that id, and never shows the value', async () => {
    const w = await boot();
    expect(reachOf(importPreview(w.env(), file(prov('acme'))))).not.toContain('uses the key saved for acme');
    setKey(w.dir, 'acme', KEY);
    const r = importPreview(w.env(), file(prov('acme')));
    expect(reachOf(r)).toContain('uses the key saved for acme');
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    // another id does not pick it up; a keyless mod under that id never sends it
    expect(reachOf(importPreview(w.env(), file(prov('other'))))).not.toContain('uses the key saved for other');
    expect(reachOf(importPreview(w.env(), file(prov('acme', { auth: { style: 'none', keyEnv: [] } }))))).toEqual(['sends your prompts and files to api.acme.test']);
  });
  it('says "reads <ENV>" for each key variable that is set now, and only those', async () => {
    const w = await boot();
    const m = file(prov('acme', { auth: { style: 'bearer', keyEnv: ['ACME_API_KEY', 'ACME_OTHER_KEY'] } }));
    expect(reachOf(importPreview(w.env({ env: {} }), m))).toEqual(['sends your prompts and files to api.acme.test']);
    expect(reachOf(importPreview(w.env({ env: { ACME_OTHER_KEY: 'x'.repeat(20) } }), m))).toEqual(['sends your prompts and files to api.acme.test', 'reads ACME_OTHER_KEY']);
    expect(reachOf(importPreview(w.env({ env: { ACME_API_KEY: '' } }), m))).toEqual(['sends your prompts and files to api.acme.test']);
  });
  it('the lines arrive in the HTTP preview too', async () => {
    const w = await boot();
    const r = await w.call('POST', '/api/mods/import/preview', { file: file(prov('acme')) });
    expect(r.status).toBe(200);
    expect(r.json.summary.reach[0]).toBe('sends your prompts and files to api.acme.test');
  });
});

describe('a user mod cannot be the default provider (S4)', () => {
  const WORDS = 'A mod cannot make itself the default provider. Choose the default in Settings.';
  it('import refuses default: true with plain words and writes nothing', async () => {
    const w = await boot();
    const r = await w.call('POST', '/api/mods/import', { file: file(prov('aaa', { default: true })) });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toContain(WORDS);
    expect(fs.existsSync(path.join(w.dir, 'mods', 'aaa'))).toBe(false);
  });
  it('the preview refuses it too; default: false is fine', async () => {
    const w = await boot();
    expect((await w.call('POST', '/api/mods/import/preview', { file: file(prov('aaa', { default: true })) })).status).toBe(400);
    expect((await w.call('POST', '/api/mods/import/preview', { file: file(prov('aaa', { default: false })) })).status).toBe(200);
  });
  it('a custom endpoint and an edit cannot carry it either', async () => {
    const w = await boot();
    expect((await w.call('POST', '/api/mods/custom', { id: 'cust', label: 'C', protocol: 'openai-chat', baseUrl: 'https://c.test/v1', defaultModel: 'm', default: true })).status).toBe(400);
    expect((await w.call('POST', '/api/mods/custom', { id: 'cust', label: 'C', protocol: 'openai-chat', baseUrl: 'https://c.test/v1', defaultModel: 'm' })).status).toBe(200);
    expect((await w.call('PUT', '/api/mods/cust', { default: true })).status).toBe(400);
  });
  it('a folder already on disk with default: true does not load as a provider; the bundled default still does', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29c-d-'));
    try {
      const d = path.join(root, 'mods', 'aaa');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'mod.json'), JSON.stringify(prov('aaa', { default: true })));
      const mods = await startMods({ dir: root, env: {} });
      try {
        expect(mods.mods.find((m) => m.id === 'aaa')?.problems.join(' ')).toContain(WORDS);
        expect(mods.mods.find((m) => m.id === 'claude-code')?.problems).toEqual([]);
      } finally { mods.dispose(); }
    } finally { rm(root); }
  });
});

describe('the list reply (C4a)', () => {
  it('carries the real secrets path, so the page never shows a placeholder', async () => {
    const w = await boot();
    const r = await w.call('GET', '/api/mods');
    expect(r.json.secretsPath).toBe(path.join(w.dir, 'secrets.json'));
  });
});

describe('POST /api/mods/:id/trust (S5)', () => {
  const codeFiles = (w: World, version: string): Record<string, string> => ({
    'mod.json': JSON.stringify({ reins: 1, id: 'wirey', kind: 'protocol', version, label: 'Wirey', main: 'index.js' }),
    'index.js': `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(w.marker)}, ${JSON.stringify(`ran ${version}`)} + '\\n');\nexport default function activate() {}\n`,
  });
  const hashOf = (files: Record<string, string>) => hashFiles(Object.entries(files).map(([rel, t]) => ({ rel, bytes: Buffer.from(t, 'utf8') })));
  const ran = (w: World) => (fs.existsSync(w.marker) ? fs.readFileSync(w.marker, 'utf8').split('\n').filter(Boolean) : []);
  const entry = async (w: World) => ((await w.call('GET', '/api/mods')).json.mods as any[]).find((m) => m.id === 'wirey');

  it('imported without trust it waits; the list carries its hash and the code prompt; Trust with that hash runs it once', async () => {
    const w = await boot();
    const files = codeFiles(w, '1.0.0');
    expect((await w.call('POST', '/api/mods/import', { file: { reinsMod: 1, files } })).status).toBe(200);
    expect(ran(w)).toEqual([]);
    const e = await entry(w);
    expect(e.trust).toBe('needs-trust');
    expect(e.hash).toBe(hashOf(files));
    expect(e.codePrompt).toContain('runs its own code inside Reins');
    const r = await w.call('POST', '/api/mods/wirey/trust', { hash: e.hash });
    expect(r.status).toBe(200);
    expect(r.json.trust).toBe('trusted');
    expect(ran(w)).toEqual(['ran 1.0.0']);
    expect((await entry(w)).trust).toBe('trusted');
  });
  it('bytes that changed since the list was read are not trusted', async () => {
    const w = await boot();
    const files = codeFiles(w, '1.0.0');
    await w.call('POST', '/api/mods/import', { file: { reinsMod: 1, files } });
    const shown = (await entry(w)).hash;
    fs.appendFileSync(path.join(w.dir, 'mods', 'wirey', 'index.js'), '// changed after the preview\n');
    const r = await w.call('POST', '/api/mods/wirey/trust', { hash: shown });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain('changed since you looked');
    expect(ran(w)).toEqual([]);
    expect(fs.existsSync(path.join(w.dir, 'mod-trust.json'))).toBe(false);
  });
  it('the hash is checked against the installed folder, not the loader\'s memory of it', async () => {
    const w = await boot();
    const files = codeFiles(w, '1.0.0');
    await w.call('POST', '/api/mods/import', { file: { reinsMod: 1, files } });
    expect((await w.call('POST', '/api/mods/wirey/trust', { hash: 'a'.repeat(64) })).status).toBe(409);
    expect((await w.call('POST', '/api/mods/wirey/trust', {})).status).toBe(400);
    expect((await w.call('POST', '/api/mods/wirey/trust', { hash: 5 })).status).toBe(400);
  });
  it('guards: not installed, bundled, a mod with no code, a bad id', async () => {
    const w = await boot();
    expect((await w.call('POST', '/api/mods/nope/trust', { hash: 'a' })).status).toBe(404);
    expect((await w.call('POST', '/api/mods/claude-code/trust', { hash: 'a' })).status).toBe(409);
    await w.call('POST', '/api/mods/import', { file: file(prov('acme')) });
    expect((await w.call('POST', '/api/mods/acme/trust', { hash: 'a' })).status).toBe(409);
    expect((await w.call('POST', '/api/mods/..%2Fx/trust', { hash: 'a' })).status).toBe(400);
  });
  it('a folder that holds a link is not trusted', async () => {
    const w = await boot();
    const files = codeFiles(w, '1.0.0');
    await w.call('POST', '/api/mods/import', { file: { reinsMod: 1, files } });
    const shown = (await entry(w)).hash;
    try { fs.symlinkSync(path.join(w.root, 'elsewhere'), path.join(w.dir, 'mods', 'wirey', 'extra'), 'junction'); } catch { return; } // no link rights here
    expect((await w.call('POST', '/api/mods/wirey/trust', { hash: shown })).status).toBe(409);
    expect(ran(w)).toEqual([]);
  });
});
