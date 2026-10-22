// M2 Task 24a, item C: a block with no code (a data block) reads as "no code, nothing to trust" in the import summary and in the Settings list,
// never as an untrusted or empty state. A code block next to it still asks for trust.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEngineFrom, redactEnvNames, startMods } from '../src/engines.js';
import { Redactor } from '../src/secrets.js';
import { startServer, type Server } from '../src/server.js';
import { openStore, redactingStore, type Store } from '../src/store.js';
import type { Mods } from '../src/mods/types.js';
import { planOf, summaryLines } from '../../app/src/importLines.js';
import { statusOf, rowInfo, type ModRow } from '../../app/src/providersStatus.js';
import { PROBE } from './http-helpers.js';

const ASK = fileURLToPath(new URL('./fixtures/mods/toy-ask/', import.meta.url));
const BEEP = fileURLToPath(new URL('./fixtures/mods/toy-beep/', import.meta.url));
const files = (dir: string) => Object.fromEntries(fs.readdirSync(dir).map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]));
const NONE = 'has no code, so there is nothing to trust';

let root: string, mods: Mods, store: Store, srv: Server;
const call = (method: string, url: string, body?: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
  const payload = body === undefined ? undefined : JSON.stringify(body);
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

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-dbs-')));
  const dir = path.join(root, '.reins');
  fs.mkdirSync(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  mods = await startMods({ dir, env });
  const redactor = new Redactor({ home: dir, env, keyEnvNames: () => redactEnvNames(mods) });
  store = redactingStore(openStore(':memory:'), redactor);
  srv = await startServer({
    store, dir, mods, env, redactor, catalogDir: path.join(root, 'no-catalog'), probe: async () => PROBE,
    makeEngine: makeEngineFrom(mods, { env, home: dir }, (id, origin) => store.hasConsent(id, origin)),
  });
});
afterAll(async () => {
  await srv.close();
  store.close();
  mods.dispose();
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the OS */ }
});

describe('a data block says it has no code', () => {
  it('the import summary lists it, has no code prompt and no trust choice, and can be imported as it is', async () => {
    const p = await call('POST', '/api/mods/import/preview', { file: { reinsMod: 1, files: files(ASK) } });
    expect(p.status).toBe(200);
    const s = p.json.summary;
    expect(s).toMatchObject({ id: 'toy-ask', kind: 'block', hasCode: false });
    expect(s.adds).toContain(NONE);
    expect(s.codePrompt).toBeUndefined();
    expect(s.hash).toBeUndefined();
    expect(s.warnings).toEqual([]);
    expect(summaryLines(s).join('\n')).not.toMatch(/Has code/);
    expect(planOf(s, [])).toMatchObject({ canImport: true, trustChoice: false });
  });

  it('a code block does not say it, and still asks for trust', async () => {
    const p = await call('POST', '/api/mods/import/preview', { file: { reinsMod: 1, files: files(BEEP) } });
    expect(p.json.summary.adds).not.toContain(NONE);
    expect(planOf(p.json.summary, [])).toMatchObject({ trustChoice: true });
  });

  it('the Settings list shows it as ready, not waiting for trust, and shows what it adds', async () => {
    const i = await call('POST', '/api/mods/import', { file: { reinsMod: 1, files: files(ASK) } });
    expect(i.status).toBe(200);
    const row = (await call('GET', '/api/mods')).json.mods.find((m: { id: string }) => m.id === 'toy-ask') as ModRow & { adds?: string[] };
    expect(row.trust).toBe('none');
    expect(row.hash).toBeUndefined();
    expect(row.adds).toContain(NONE);
    expect(statusOf(row)).toBe('ready');
    expect(rowInfo(row).canTrust).toBe(false);
  });
});
