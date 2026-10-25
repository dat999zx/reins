// Milestone P, Task 27: "a provider is one folder". A toy protocol (a code mod) and a toy provider (a data mod) go through every surface with no
// edit under packages/*/src: install by import, trust, key, consent, the state, a workflow with an approval, the receipt, the conversation file,
// export and import into a second home, disable, enable, remove. The fixtures are in test/fixtures/mods; the wire sends to a fake server.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyEnvNames, makeEngineFrom, redactEnvNames, startMods } from '../src/engines.js';
import { CODE_PROMPT } from '../src/mods/actions.js';
import type { Mods } from '../src/mods/types.js';
import { Redactor } from '../src/secrets.js';
import { startServer, type Server } from '../src/server.js';
import { openStore, redactingStore, type LogRow, type Store } from '../src/store.js';
import { startFakeProvider } from './fake-provider.js';
import { until } from './helpers.js';
import { PROBE, openQuestions } from './http-helpers.js';

const KEY = 'sk-test-0123456789abcdef';
const FIXTURES = fileURLToPath(new URL('./fixtures/mods/', import.meta.url));
const rm = (d: string) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the OS */ } };

type Fake = Awaited<ReturnType<typeof startFakeProvider>>;
interface Res { status: number; json: any; text: string }
interface World {
  root: string; dir: string; proj: string; fake: Fake; mods: Mods; store: Store; srv: Server;
  call: (method: string, url: string, body?: unknown) => Promise<Res>;
}
const worlds: World[] = [];
const marker = path.join(fs.realpathSync.native(os.tmpdir()), `reins-toy-marker-${process.pid}.log`);

beforeAll(() => {
  rm(marker);
  process.env.TOY_MARKER = marker; // the toy wire writes a line here when its code is loaded
});
afterAll(async () => {
  delete process.env.TOY_MARKER;
  rm(marker);
  for (const w of worlds.splice(0)) {
    await w.srv.close();
    w.store.close();
    w.mods.dispose();
    await w.fake.close();
    rm(w.root);
  }
});

/** A real server over HTTP on a temp Reins folder: the real loader, the real engine factory, the store's consent, a fake provider server. */
async function boot(): Promise<World> {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-toy-')));
  const dir = path.join(root, '.reins');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  const fake = await startFakeProvider();
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TOY_API_KEY;
  const mods = await startMods({ dir, env });
  const redactor = new Redactor({ home: dir, env, keyEnvNames: () => redactEnvNames(mods) });
  const store = redactingStore(openStore(':memory:'), redactor);
  const srv = await startServer({
    store, dir, mods, env, redactor, catalogDir: path.join(root, 'no-catalog'), probe: async () => PROBE,
    makeEngine: makeEngineFrom(mods, { env, home: dir }, (id, origin) => store.hasConsent(id, origin)),
  });
  const call: World['call'] = (method, url, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: srv.port, path: url, method, agent: false,
      headers: { authorization: `Bearer ${srv.token}`, ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) },
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
  const w: World = { root, dir, proj, fake, mods, store, srv, call };
  worlds.push(w);
  return w;
}

/** A fixture folder as the files of an export file; `__PORT__` becomes the fake server's port. */
const fixture = (id: string, port: string) => ({
  reinsMod: 1,
  files: Object.fromEntries(fs.readdirSync(path.join(FIXTURES, id)).map((n) => [n, fs.readFileSync(path.join(FIXTURES, id, n), 'utf8').replaceAll('__PORT__', port)])),
});
const portOf = (w: World) => new URL(w.fake.url).port;
const preview = (w: World, file: unknown) => w.call('POST', '/api/mods/import/preview', { file });
const importMod = (w: World, file: unknown, trust?: boolean) => w.call('POST', '/api/mods/import', { file, ...(trust ? { trust } : {}) });
const modOf = async (w: World, id: string) => ((await w.call('GET', '/api/mods')).json.mods as Array<Record<string, any>>).find((m) => m.id === id);
const state = async (w: World) => (await w.call('GET', '/api/state')).json as { sessions: Array<Record<string, any>>; groups: Array<Record<string, any>>; providers: Array<Record<string, any>> };
const marked = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean) : []);
const rows = (w: World, id: string, type: string): LogRow[] => w.store.readLog(id).filter((r) => r.type === type);
const folderFiles = (w: World, id: string) => Object.fromEntries(fs.readdirSync(path.join(w.dir, 'mods', id)).sort().map((n) => [n, fs.readFileSync(path.join(w.dir, 'mods', id, n))]));

/** Answers yes to every open approval card (a tool request) and the folder's trust question until `done` is true. */
const approveUntil = (w: World, id: string, done: () => boolean) => until(() => {
  for (const q of openQuestions(w.store.readLog(id))) if (q.kind === 'tool' || q.kind === 'trust') void w.call('POST', `/api/sessions/${id}/answer`, { questionId: q.id, answer: 'y' });
  return done();
}, 20_000);

const WORDS = (id: string) => `This session uses ${id}, which is not installed. Install it in Settings > Providers, or start a new session.`;

describe('a provider is one folder: a toy wire and a toy provider go through every surface', () => {
  let a: World;
  let exportedToy: Res;
  let exportedWire: Res;
  let session: string;

  beforeAll(async () => {
    a = await boot();
  });

  it('install the code mod: preview, import without trust (it does not run), then trust', async () => {
    const wire = fixture('toy-echo', portOf(a));
    const p = await preview(a, wire);
    expect(p.status, p.text).toBe(200);
    expect(p.json.summary).toMatchObject({ id: 'toy-echo', kind: 'protocol', hasCode: true, trusted: false, codePrompt: CODE_PROMPT });

    const first = await importMod(a, wire);
    expect([first.status, first.json.trust]).toEqual([200, 'needs-trust']);
    expect(marked()).toEqual([]); // not run
    expect(fs.existsSync(path.join(a.dir, 'mod-cache'))).toBe(false);
    expect(await modOf(a, 'toy-echo')).toMatchObject({ trust: 'needs-trust', enabled: true });
    expect((await modOf(a, 'toy-echo'))!.problems.join(' ')).toContain('needs trust');
    expect(a.mods.registry.has('protocol-impl', 'toy-echo')).toBe(false);

    const second = await importMod(a, wire, true);
    expect([second.status, second.json.trust]).toEqual([200, 'trusted']);
    expect(marked()).toEqual(['toy-echo loaded']);
    expect(await modOf(a, 'toy-echo')).toMatchObject({ trust: 'trusted', problems: [] });
    expect(a.mods.registry.has('protocol-impl', 'toy-echo')).toBe(true);
  });

  it('install the data provider; it lists with its status; the key and the consent make it ready', async () => {
    const toy = fixture('toy', portOf(a));
    expect((await preview(a, toy)).json.summary).toMatchObject({ id: 'toy', kind: 'provider', hasCode: false });
    const r = await importMod(a, toy);
    expect([r.status, r.json.trust]).toEqual([200, 'none']);
    expect(marked()).toHaveLength(1); // the data mod ran nothing, and the wire was not loaded again
    expect(await modOf(a, 'toy')).toMatchObject({ enabled: true, source: 'custom', problems: [], key: { state: 'missing' }, consent: 'needed' });
    expect((await state(a)).groups.find((g) => g.id === 'toy')).toMatchObject({ status: 'needs-key', consent: 'needed' });

    expect((await a.call('PUT', '/api/mods/toy/key', { key: KEY })).status).toBe(200);
    expect(fs.readFileSync(path.join(a.dir, 'secrets.json'), 'utf8')).toContain(KEY); // plain text in the home, as the guide says
    const c = await a.call('POST', '/api/mods/toy/consent', { origin: a.fake.url });
    expect([c.status, c.json.consent, c.json.origin]).toEqual([200, 'granted', a.fake.url]);

    expect(await modOf(a, 'toy')).toMatchObject({ key: { state: 'set' }, consent: 'granted', host: `127.0.0.1:${portOf(a)}` });
    const s = await state(a);
    expect(s.groups.find((g) => g.id === 'toy')).toMatchObject({ label: 'Toy', status: 'installed', consent: 'granted', models: [expect.objectContaining({ id: 'echo-1' })] });
    expect(s.providers.map((p) => p.id)).toContain('toy');
    expect(keyEnvNames(a.mods)).toContain('TOY_API_KEY');
  });

  it('a workflow on toy:echo-1 asks for approval, is approved, and the receipt has its cost', async () => {
    const made = await a.call('POST', '/api/sessions', { cwd: a.proj, engine: 'toy' });
    expect(made.status, made.text).toBe(200);
    session = made.json.id;
    const sw = await a.call('POST', `/api/sessions/${session}/settings`, { model: 'toy:echo-1' });
    expect(sw.status, sw.text).toBe(200);
    expect((await state(a)).sessions.find((x) => x.id === session)).toMatchObject({ engine: 'toy', model: 'echo-1', composite: 'toy:echo-1', provider: { status: 'ok' } });

    const file = path.join(a.proj, 'toy.reins.md');
    fs.writeFileSync(file, '---\nreins: 1\nname: toy\nbudget: { turns: 20, minutes: 20 }\nalways: []\n---\n\n## model toy:echo-1\n\n## phase go\n> Go.\n');
    a.fake.push({ text: 'the first reply is not read' }, { text: `the second reply holds the key ${KEY}` });
    const run = await a.call('POST', `/api/sessions/${session}/run`, { path: file });
    expect(run.status, run.text).toBe(200);
    await approveUntil(a, session, () => rows(a, session, 'receipt').length === 1);

    // one approval card, for the shell tool, and it was answered yes
    const cards = rows(a, session, 'question').map((r) => r.data as { kind: string; prompt: string; detail?: string }).filter((q) => q.kind === 'tool');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.prompt).toMatch(/^\? Allow (Bash|PowerShell): echo toy-ok/);
    expect(rows(a, session, 'answer').map((r) => (r.data as { answer: string }).answer)).toContain('y');
    expect(rows(a, session, 'run_finished')).toHaveLength(1);

    // the cost: (100 + 200) input x 1 + (20 + 30) output x 2, per million tokens
    expect((rows(a, session, 'receipt')[0]!.data as { totalCostUsd: number }).totalCostUsd).toBeCloseTo(4e-4, 9);
    expect(rows(a, session, 'turn_ended').map((r) => (r.data as { cost: number }).cost)).toEqual([expect.closeTo(4e-4, 9)]);

    // two requests reached the fake, both with the key in the bearer header and nowhere else
    const sent = a.fake.requests.filter((r) => r.path.endsWith('/chat/completions'));
    expect(sent).toHaveLength(2);
    for (const r of sent) expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(sent.map((r) => r.body))).not.toContain(KEY);
  });

  it('the conversation file exists and no event, log row, state or file holds the key', async () => {
    const convoId = a.store.getSession(session)!.engineSessionId; // the engine's own id names the file
    expect(convoId).toBeTruthy();
    const convo = path.join(a.dir, 'conversations', `${convoId}.jsonl`);
    expect(fs.existsSync(convo)).toBe(true);
    const saved = fs.readFileSync(convo, 'utf8');
    expect(saved).toContain('toy-ok'); // the tool result is in it
    expect(saved).not.toContain(KEY); // the provider's reply held the key, and it was redacted on the way in
    const log = JSON.stringify(a.store.readLog(session));
    expect(log).toContain('toy-ok');
    expect(log).not.toContain(KEY);
    for (const url of ['/api/state', '/api/mods']) expect((await a.call('GET', url)).text).not.toContain(KEY);
    exportedToy = await a.call('GET', '/api/mods/toy/export');
    exportedWire = await a.call('GET', '/api/mods/toy-echo/export');
    expect([exportedToy.status, exportedWire.status]).toEqual([200, 200]);
    // the export is the mod's own files and nothing else (the reply is also redacted, so the shape is the stronger check)
    expect(Object.keys(exportedToy.json)).toEqual(['reinsMod', 'files']);
    expect(Object.keys(exportedToy.json.files)).toEqual(['mod.json']);
    expect(Object.keys(exportedWire.json.files).sort()).toEqual(['index.js', 'mod.json']);
    expect(exportedToy.text).not.toContain(KEY);
    expect(exportedWire.text).not.toContain(KEY);
    expect(exportedToy.text).not.toContain('secrets');
  });

  it('export of both and import into a second clean home gives byte-identical files', async () => {
    const b = await boot();
    expect((await importMod(b, exportedWire.json)).json.trust).toBe('needs-trust');
    expect((await importMod(b, exportedWire.json, true)).json.trust).toBe('trusted');
    expect((await importMod(b, exportedToy.json)).status).toBe(200);
    for (const id of ['toy-echo', 'toy']) {
      const here = folderFiles(a, id);
      const there = folderFiles(b, id);
      expect(Object.keys(there)).toEqual(Object.keys(here));
      for (const name of Object.keys(here)) expect(there[name]!.equals(here[name]!)).toBe(true);
    }
    expect((await b.call('GET', '/api/mods/toy/export')).json).toEqual(exportedToy.json);
    expect((await b.call('GET', '/api/mods/toy-echo/export')).json).toEqual(exportedWire.json);
    expect(await modOf(b, 'toy-echo')).toMatchObject({ trust: 'trusted', problems: [] });
    expect(await modOf(b, 'toy')).toMatchObject({ enabled: true, problems: [], key: { state: 'missing' }, consent: 'needed' }); // keys and yes answers stay in their home
  });

  it('disable greys the session with the 9.4 words and refuses a reply; enable restores it', async () => {
    expect((await a.call('POST', '/api/mods/toy/disable')).status).toBe(200);
    expect(await modOf(a, 'toy')).toMatchObject({ enabled: false });
    expect((await state(a)).sessions.find((x) => x.id === session)!.provider).toEqual({ status: 'missing', words: WORDS('toy') });
    expect((await state(a)).groups.map((g) => g.id)).not.toContain('toy');
    const refused = await a.call('POST', `/api/sessions/${session}/message`, { text: 'are you there?' });
    expect([refused.status, refused.json.error]).toEqual([409, WORDS('toy')]);

    expect((await a.call('POST', '/api/mods/toy/enable')).status).toBe(200);
    expect((await state(a)).sessions.find((x) => x.id === session)!.provider).toEqual({ status: 'ok' });
    expect((await state(a)).groups.map((g) => g.id)).toContain('toy');
    a.fake.push({ text: 'one' }, { text: 'two' });
    const turns = rows(a, session, 'turn_ended').length;
    const ok = await a.call('POST', `/api/sessions/${session}/message`, { text: 'are you there?' });
    expect(ok.status, ok.text).toBe(200);
    await approveUntil(a, session, () => rows(a, session, 'turn_ended').length === turns + 1);
    expect(JSON.stringify(a.store.readLog(session))).toContain('echo-1 saw');
  });

  it('remove makes every surface forget the provider, then the wire', async () => {
    const before = a.mods.registry;
    expect((await a.call('DELETE', '/api/mods/toy')).status).toBe(200);
    expect(fs.existsSync(path.join(a.dir, 'mods', 'toy'))).toBe(false);
    expect(await modOf(a, 'toy')).toBeUndefined(); // the list
    const s = await state(a);
    expect(s.groups.map((g) => g.id)).not.toContain('toy'); // the model picker data
    expect(s.providers.map((p) => p.id)).not.toContain('toy');
    expect(s.sessions.find((x) => x.id === session)!.provider).toEqual({ status: 'missing', words: WORDS('toy') });
    expect(a.mods.registry.has('provider', 'toy')).toBe(false); // the registry
    expect(keyEnvNames(a.mods)).not.toContain('TOY_API_KEY');
    expect(a.store.hasConsent('toy', a.fake.url)).toBe(false); // the yes goes with the mod
    expect(a.mods.registry).not.toBe(before); // a new state was swapped in ...
    expect(before.has('provider', 'toy')).toBe(false); // ... and the old one was disposed, not only dropped
    expect(before.has('protocol-impl', 'toy-echo')).toBe(false);
    expect((await a.call('POST', `/api/sessions/${session}/message`, { text: 'hello?' })).json.error).toBe(WORDS('toy'));

    const wireBefore = a.mods.registry;
    expect(wireBefore.has('protocol-impl', 'toy-echo')).toBe(true);
    expect((await a.call('DELETE', '/api/mods/toy-echo')).status).toBe(200);
    expect(await modOf(a, 'toy-echo')).toBeUndefined();
    expect(a.mods.registry.has('protocol-impl', 'toy-echo')).toBe(false);
    expect(a.mods.registry.has('protocol', 'toy-echo')).toBe(false);
    expect(wireBefore.has('protocol-impl', 'toy-echo')).toBe(false); // disposed
    const trustFile = path.join(a.dir, 'mod-trust.json');
    expect(fs.existsSync(trustFile) ? fs.readFileSync(trustFile, 'utf8') : '').not.toContain('toy-echo'); // the trust goes with the mod
    expect(marked()).toHaveLength(2); // loaded once per home however many reloads there were (the second home has its own code cache)
  });
});
