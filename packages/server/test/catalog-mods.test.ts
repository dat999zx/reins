// Milestone P, Task 26 (spec 7.1): the 11 catalog manifests in packages/server/catalog. Data only; these tests guard its shape.
// The real validator and the real install route, the real protocol mods, no network and no key.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { keyEnvNames, makeEngineFrom, startMods } from '../src/engines.js';
import { isModId, validateMod } from '../src/mods/loader.js';
import type { Mods } from '../src/mods/types.js';
import { Redactor, readSecrets } from '../src/secrets.js';
import { makeSend } from '../src/send.js';
import { startServer, type Server } from '../src/server.js';
import { openStore, type Store } from '../src/store.js';
import { PROBE } from './http-helpers.js';

const CATALOG = fileURLToPath(new URL('../catalog/', import.meta.url));
// Spec 7.1, copied: id, protocol, base address, key variable names.
const TABLE: Array<[string, string, string, string[]]> = [
  ['anthropic', 'anthropic-messages', 'https://api.anthropic.com', ['ANTHROPIC_API_KEY']],
  ['openai', 'openai-chat', 'https://api.openai.com/v1', ['OPENAI_API_KEY']],
  ['openrouter', 'openai-chat', 'https://openrouter.ai/api/v1', ['OPENROUTER_API_KEY']],
  ['deepseek', 'openai-chat', 'https://api.deepseek.com/v1', ['DEEPSEEK_API_KEY']],
  ['gemini', 'openai-chat', 'https://generativelanguage.googleapis.com/v1beta/openai', ['GEMINI_API_KEY', 'GOOGLE_API_KEY']],
  ['zai', 'openai-chat', 'https://api.z.ai/api/paas/v4', ['GLM_API_KEY', 'ZAI_API_KEY']],
  ['minimax', 'anthropic-messages', 'https://api.minimax.io/anthropic', ['MINIMAX_API_KEY']],
  ['fireworks', 'openai-chat', 'https://api.fireworks.ai/inference/v1', ['FIREWORKS_API_KEY']],
  ['ollama-cloud', 'openai-chat', 'https://ollama.com/v1', ['OLLAMA_API_KEY']],
  ['ollama', 'openai-chat', 'http://localhost:11434/v1', []],
  ['lm-studio', 'openai-chat', 'http://localhost:1234/v1', []],
];
const LOCAL = ['ollama', 'lm-studio'];
const KEY_ENV = /^[A-Z][A-Z0-9_]*_(API_KEY|KEY|TOKEN)$/; // spec 5.3

interface Model { id: string; price?: unknown; _source?: unknown }
interface Entry { id: string; protocol: string; baseUrl: string; auth: { style: string; keyEnv: string[] }; price?: unknown; untested?: unknown; defaultModel: string; models: Model[] }

const folders = fs.readdirSync(CATALOG, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const entries: Array<{ folder: string; raw: Record<string, unknown> & Entry }> = folders.map((folder) => ({ folder, raw: JSON.parse(fs.readFileSync(path.join(CATALOG, folder, 'mod.json'), 'utf8')) }));

const rm = (d: string) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the OS */ } };
const worlds: Array<{ root: string; srv: Server; store: Store; mods: Mods }> = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) {
    await w.srv.close();
    w.store.close();
    w.mods.dispose();
    rm(w.root);
  }
});

async function boot() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-catalog-')));
  const dir = path.join(root, '.reins');
  fs.mkdirSync(dir, { recursive: true });
  const mods = await startMods({ dir, env: {} });
  const redactor = new Redactor({ home: dir, env: {}, keyEnvNames: () => keyEnvNames(mods) });
  const send = makeSend({ secrets: () => readSecrets(dir), env: {}, redactor, consent: () => true });
  const store = openStore(':memory:');
  const srv = await startServer({
    store, dir, mods, env: {}, catalogDir: CATALOG, redactor, send, consent: () => undefined, probe: async () => PROBE,
    makeEngine: makeEngineFrom(mods, { env: {}, home: dir, send }),
  });
  worlds.push({ root, srv, store, mods });
  const call = (method: string, url: string, body?: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({
      host: '127.0.0.1', port: srv.port, path: url, method, agent: false,
      headers: { authorization: `Bearer ${srv.token}`, ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }));
    });
    req.on('error', reject);
    req.end(payload);
  });
  return { mods, call };
}

describe('the catalog folder', () => {
  it('holds exactly the 11 providers of the spec table, and never the built-in one', () => {
    expect(folders).toEqual(TABLE.map((t) => t[0]).sort());
    expect(folders).not.toContain('claude-code');
  });

  it('every id equals its folder, is unique, is a valid id and is not a bundled name', async () => {
    const { mods } = await boot();
    const bundled = new Set(mods.mods.filter((m) => m.source === 'bundled').map((m) => m.id));
    expect(bundled.has('claude-code')).toBe(true);
    const seen = new Set<string>();
    for (const { folder, raw } of entries) {
      expect(raw.id).toBe(folder);
      expect(isModId(raw.id)).toBe(true);
      expect(bundled.has(raw.id)).toBe(false);
      expect(seen.has(raw.id)).toBe(false);
      seen.add(raw.id);
    }
  });

  it('every manifest passes the real validator', async () => {
    const { mods } = await boot();
    const kinds = new Map(mods.mods.filter((m) => m.source === 'bundled').map((m) => [m.id, m.kind] as [string, string]));
    for (const { folder, raw } of entries) {
      expect(validateMod(raw, { folder, source: 'user' }, folder, kinds, mods.registry), folder).toEqual([]);
    }
  });

  it('matches the spec table: protocol, base address and key names', () => {
    for (const [id, protocol, baseUrl, keyEnv] of TABLE) {
      const e = entries.find((x) => x.folder === id)!.raw;
      expect([id, e.protocol, e.baseUrl, e.auth.keyEnv]).toEqual([id, protocol, baseUrl, keyEnv]);
    }
  });

  it('key variable names follow the 5.3 pattern', () => {
    for (const { raw } of entries) for (const name of raw.auth.keyEnv) expect(name, raw.id).toMatch(KEY_ENV);
  });

  it('every address is https except the two local programs, which are free and need no key', () => {
    for (const { raw } of entries) {
      if (LOCAL.includes(raw.id)) {
        expect(raw.baseUrl.startsWith('http://localhost:'), raw.id).toBe(true);
        expect(raw.price, raw.id).toEqual({ input: 0, output: 0 });
        expect(raw.auth, raw.id).toEqual({ style: 'none', keyEnv: [] });
      } else {
        expect(raw.baseUrl.startsWith('https://'), raw.id).toBe(true);
        expect(raw.auth.style, raw.id).not.toBe('none');
      }
    }
  });

  it('every priced model names an https source, and every entry is marked untested', () => {
    for (const { raw } of entries) {
      expect(raw.untested, raw.id).toBe(true);
      for (const m of raw.models) {
        if (m.price !== undefined) {
          expect(typeof m._source, `${raw.id} ${m.id}`).toBe('string');
          expect(String(m._source).startsWith('https://'), `${raw.id} ${m.id}`).toBe(true);
        }
      }
    }
  });

  it('the default model is in the list, and a list never names a model twice', () => {
    for (const { raw } of entries) {
      const ids = raw.models.map((m) => m.id);
      expect(ids, raw.id).toContain(raw.defaultModel);
      expect(new Set(ids).size, raw.id).toBe(ids.length);
    }
  });
});

describe('the catalog through the install route', () => {
  it('offers all 11 untested, installs them, and the list shows them without problems', async () => {
    const w = await boot();
    const before = (await w.call('GET', '/api/mods')).json;
    expect(before.chooser.map((c: { id: string }) => c.id)).toEqual(TABLE.map((t) => t[0]).sort());
    expect(before.chooser.every((c: { untested: boolean }) => c.untested === true)).toBe(true);

    const ids = TABLE.map((t) => t[0]);
    const r = await w.call('POST', '/api/mods/install', { ids });
    expect(r.status).toBe(200);
    expect(r.json.results).toEqual(ids.map((id) => ({ id, ok: true })));
    expect(r.json.reloaded).toBe(true);
    expect(r.json.problems).toBeUndefined();

    const after = (await w.call('GET', '/api/mods')).json;
    expect(after.problems).toEqual([]);
    expect(after.chooser).toEqual([]);
    for (const id of ids) {
      const row = after.mods.find((m: { id: string }) => m.id === id);
      expect(row, id).toMatchObject({ id, kind: 'provider', enabled: true, bundled: false, source: 'installed', problems: [] });
      expect(row.manifest.untested, id).toBe(true);
    }
  });
});
