// Milestone P, Task 21 (spec 7.6, 7.8, 8.1, 8.2, 8.3, 7.5): the key routes, the consent store and its question, Test connection.
// A real server over HTTP on a temp Reins folder, the real loader and wires, fake provider servers that record every request. No network,
// fake keys only. Every response the test client receives is checked for the key before the test sees it.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkEnvFrom, consentFrom, hostSend, keyEnvNames, makeEngineFrom, probeFrom, startMods } from '../src/engines.js';
import { HELD_MARKER, MAX_CURRENT, MAX_HOLDBACK, MAX_RETAINED, Redactor, StreamRedactor, clearKey, readSecrets, setKey } from '../src/secrets.js';
import { ConsentNeeded, ProviderChanged, makeSend } from '../src/send.js';
import { startServer, type Server } from '../src/server.js';
import { openSession } from '../src/session.js';
import { openStore, redactingStore, type Store } from '../src/store.js';
import type { Mods, ProviderManifest } from '../src/mods/types.js';
import { startFakeProvider } from './fake-provider.js';
import { until } from './helpers.js';
import { PROBE, openQuestions } from './http-helpers.js';
import { rig } from './loop-harness.js';

const KEY = 'sk-test-0123456789abcdef';
const KEY2 = 'sk-second-9876543210fedcba';
// One key per provider, so a key that is retired or leaked is never hidden by another provider's identical one.
const KEY_KO = 'sk-other-aaaa1111bbbb2222';
const KEY_DEAD = 'sk-dead-cccc3333dddd4444';
const KEY_MS = 'sk-msgs-eeee5555ffff6666';
const KEY_NEW = 'sk-rotated-7777gggg8888hhhh';
const NEEDLES = [KEY, KEY2, KEY_KO, KEY_DEAD, KEY_MS, KEY_NEW].flatMap((k) => [k, k.slice(0, 8)]);
const PRICE = { input: 1, output: 2 };
const POSIX = process.platform !== 'win32';
if (!POSIX) console.log('mods-keys: the 0600 mode test is skipped: Windows ignores file modes (spec 8.1).');

type Fake = Awaited<ReturnType<typeof startFakeProvider>>;
const rm = (d: string) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the OS */ } };
const hostOf = (f: Fake) => new URL(f.url).host;
const originOf = (f: Fake) => new URL(f.url).origin;
const chat = (f: Fake) => f.requests.filter((r) => r.path.endsWith('/chat/completions'));
const para = (tag: string, n = 3000) => `${tag} ${'w'.repeat(n)}`;
const pause = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const prov = (id: string, over: Record<string, unknown> = {}) => ({
  reins: 1, id, kind: 'provider', version: '1.0.0', label: id, protocol: 'openai-chat', untested: true, defaultModel: 'm',
  models: [{ id: 'm', context: 8000, maxOutput: 100, price: PRICE }], auth: { style: 'bearer', keyEnv: [`${id.toUpperCase()}_API_KEY`] }, ...over,
});
function writeMod(dir: string, m: Record<string, unknown>) {
  const folder = path.join(dir, 'mods', String(m.id));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'mod.json'), JSON.stringify(m, null, 2));
}

interface Res { status: number; json: any; text: string }
interface World {
  root: string; dir: string; proj: string; catalogDir: string; mods: Mods; store: Store; srv: Server; a: Fake; b: Fake; deadPort: number; redactor: Redactor;
  call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, o?: { body?: unknown; raw?: string; auth?: boolean; headers?: Record<string, string> }): Promise<Res>;
  checked(): number;
  restart(): Promise<void>;
}
const worlds: World[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const w of worlds.splice(0)) {
    await w.srv.close();
    w.store.close();
    w.mods.dispose();
    await w.a.close();
    await w.b.close();
    rm(w.root);
  }
});

/**
 * `alwaysSend`: the server and the engines send through a `send` whose consent callback always says yes, so the ONLY guard left is the one
 * under test (the session's question, the route's check, the live list's check). Without it the store-backed `send` is a second guard.
 */
async function boot(o: { alwaysSend?: boolean; testTimeoutMs?: number; fileStore?: boolean; extra?: (a: Fake, b: Fake) => Array<Record<string, unknown>> } = {}): Promise<World> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-keys-')));
  const dir = path.join(root, '.reins');
  const proj = path.join(root, 'proj');
  const catalogDir = path.join(root, 'catalog');
  fs.mkdirSync(proj, { recursive: true });
  const a = await startFakeProvider();
  const b = await startFakeProvider();
  const dead = await startFakeProvider();
  const deadPort = Number(new URL(dead.url).port);
  await dead.close();
  writeMod(dir, prov('kp', { label: 'Keyed', baseUrl: `${a.url}/v1` }));
  writeMod(dir, prov('kl', { label: 'Keyless', baseUrl: `${a.url}/v1`, auth: { style: 'none', keyEnv: [] }, price: { input: 0, output: 0 } }));
  writeMod(dir, prov('ko', { label: 'Other', baseUrl: `${b.url}/v1`, defaultModel: 'om', models: [{ id: 'om', price: PRICE }] }));
  writeMod(dir, prov('dead', { label: 'Dead', baseUrl: `http://127.0.0.1:${deadPort}/v1` }));
  for (const m of o.extra?.(a, b) ?? []) writeMod(dir, m);
  fs.mkdirSync(path.join(catalogDir, 'cat'), { recursive: true });
  fs.writeFileSync(path.join(catalogDir, 'cat', 'mod.json'), JSON.stringify(prov('cat', { label: 'Cat', baseUrl: `${a.url}/v1` }), null, 2));
  setKey(dir, 'kp', KEY);
  setKey(dir, 'ko', KEY_KO);
  setKey(dir, 'dead', KEY_DEAD);
  const mods = await startMods({ dir, env: {} });
  expect(mods.mods.flatMap((m) => m.problems)).toEqual([]);
  const redactor = new Redactor({ home: dir, env: {}, keyEnvNames: () => keyEnvNames(mods) });
  const open = () => openStore(o.fileStore ? path.join(root, 'reins.db') : ':memory:');
  let store = open();
  const yes = makeSend({ secrets: () => readSecrets(dir), env: {}, redactor, consent: () => true });
  const start = (s: Store) => startServer({
    store: s, dir, mods, env: {}, catalogDir, redactor, probe: async () => PROBE,
    ...(o.alwaysSend ? { send: yes } : {}), ...(o.testTimeoutMs ? { testTimeoutMs: o.testTimeoutMs } : {}),
    makeEngine: makeEngineFrom(mods, { env: {}, home: dir, ...(o.alwaysSend ? { send: yes } : {}) }, (id, origin) => s.hasConsent(id, origin)),
  });
  const srv = await start(store);
  let checked = 0;
  const w: World = {
    root, dir, proj, catalogDir, mods, store, srv, a, b, deadPort, redactor,
    checked: () => checked,
    call: (method, url, c = {}) => new Promise((resolve, reject) => {
      const payload = c.raw ?? (c.body !== undefined ? JSON.stringify(c.body) : undefined);
      const req = http.request({
        host: '127.0.0.1', port: w.srv.port, path: url, method, agent: false,
        headers: {
          ...(c.auth === false ? {} : { authorization: `Bearer ${w.srv.token}` }),
          ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
          ...(c.headers ?? {}),
        },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (text += d));
        res.on('end', () => {
          // Every body, status line and header of every response is checked for the key and for its 8-character start.
          const whole = `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}\n${JSON.stringify(res.headers)}\n${text}`;
          for (const n of NEEDLES) if (whole.includes(n)) return reject(new Error(`A response to ${method} ${url} holds the key (${n.length} characters of it).`));
          checked++;
          let json: unknown;
          try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      });
      req.on('error', reject);
      req.end(payload);
    }),
    async restart() {
      await w.srv.close();
      w.store.close();
      store = open();
      w.store = store;
      w.srv = await start(store);
    },
  };
  worlds.push(w);
  return w;
}

// ---- helpers over the session API

const session = async (w: World, engine: string) => {
  const r = await w.call('POST', '/api/sessions', { body: { cwd: w.proj, engine } });
  expect(r.status, r.text).toBe(200);
  return r.json.id as string;
};
const say = (w: World, id: string, text: string) => w.call('POST', `/api/sessions/${id}/message`, { body: { text } });
const turns = (w: World, id: string) => w.store.readLog(id).filter((r) => r.type === 'turn_ended').length;
const trusts = (w: World, id: string) => openQuestions(w.store.readLog(id)).filter((q) => q.kind === 'trust');
const askedTrust = async (w: World, id: string) => {
  await until(() => trusts(w, id).length > 0);
  return trusts(w, id)[0]!;
};
const answer = (w: World, id: string, q: { id: string }, a: string) => w.call('POST', `/api/sessions/${id}/answer`, { body: { questionId: q.id, answer: a } });
const idle = (w: World, id: string) => until(() => {
  const last = w.store.readLog(id).at(-1);
  return last?.type === 'status' && (last.data as { status?: string }).status === 'idle';
});
const questionsAsked = (w: World, id: string) => w.store.readLog(id).filter((r) => r.type === 'question').length;
const notes = (w: World, id: string) => w.store.readLog(id).filter((r) => r.type === 'note').map((r) => (r.data as { text: string }).text);
const asks = (w: World, host: string, keyed = true) => keyed
  ? `This session sends your prompts, the files the agent reads, and your key to ${host}. Go on? [y / n]`
  : `This session sends your prompts and the files the agent reads to ${host}. Go on? [y / n]`;
// A yes names the origin it is for (A4): this one reads the provider's own, as the dialog gets it from the Test connection challenge.
const grant = async (w: World, id: string) => {
  const row = (await w.call('GET', '/api/mods')).json.mods.find((m: { id: string }) => m.id === id);
  const origin = new URL(row.manifest.baseUrl).origin;
  expect((await w.call('POST', `/api/mods/${id}/consent`, { body: { origin } })).status).toBe(200);
};

// ---- 1. no response holds the key

describe('no route answers with the key (spec 8.1, 8.3)', () => {
  it('every route that touches a key, a consent or a connection answers without it, the checks run on each response', async () => {
    const w = await boot();
    const before = w.checked();
    w.a.list.status = 401;
    w.a.list.errorBody = JSON.stringify({ error: { message: `bad key ${KEY} and ${KEY.slice(0, 12)}` } });
    expect((await w.call('PUT', '/api/mods/kp/key', { body: { key: KEY2 } })).json).toEqual({ ok: true, keyStatus: { state: 'set', source: 'Reins' } });
    await grant(w, 'kp');
    const t = await w.call('POST', '/api/mods/kp/test');
    expect(t.json.result).toBe('bad-key');
    w.a.list.status = 500;
    w.a.list.errorBody = `${KEY} ${KEY2} ${'x'.repeat(400)}`;
    expect((await w.call('POST', '/api/mods/kp/test')).json.result).toBe('unreachable');
    await w.call('GET', '/api/mods');
    await w.call('GET', '/api/state');
    await w.call('DELETE', '/api/mods/kp/key');
    await w.call('PUT', '/api/mods/kp/key', { body: { key: 'bad\nkey' } });
    await w.call('PUT', '/api/mods/kp/key', { body: { key: 'x'.repeat(5000) } });
    await w.call('PUT', '/api/mods/kp/key', { raw: '{"key": "' });
    await w.call('POST', '/api/mods/kp/consent', { body: { revoke: true } });
    await w.call('POST', '/api/mods/zz-unknown/test');
    expect(w.checked() - before).toBeGreaterThanOrEqual(12);
  });
});

// ---- 2. one mutation per key-bearing route: the fake saw NO request

describe('(a) the session: the first reply asks before anything is sent (spec 7.8)', () => {
  it('asks the exact words, sends nothing until the answer, then sends once with the key and never asks again', async () => {
    const w = await boot({ alwaysSend: true });
    const id = await session(w, 'kp');
    expect((await say(w, id, 'hello')).status).toBe(200);
    const q = await askedTrust(w, id);
    expect(q.prompt).toBe(asks(w, hostOf(w.a)));
    await pause();
    expect(w.a.requests).toHaveLength(0);
    w.a.push({ text: 'hi' });
    await answer(w, id, q, 'y');
    await until(() => turns(w, id) === 1);
    expect(chat(w.a)).toHaveLength(1);
    expect(chat(w.a)[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(w.store.hasConsent('kp', originOf(w.a))).toBe(true);
    w.a.push({ text: 'again' });
    await say(w, id, 'second');
    await until(() => turns(w, id) === 2);
    expect(questionsAsked(w, id)).toBe(1);
  });

  it('with the store-backed send alone (no seam, no injected send) the first reply is also refused before any request', async () => {
    const w = await boot();
    const id = await session(w, 'kp');
    await say(w, id, 'hello');
    const q = await askedTrust(w, id);
    await pause();
    expect(w.a.requests).toHaveLength(0);
    await answer(w, id, q, 'n');
    await idle(w, id);
    expect(w.a.requests).toHaveLength(0);
  });

  it('a keyless provider asks too, in words that do not mention a key, and is asked once', async () => {
    const w = await boot({ alwaysSend: true });
    const id = await session(w, 'kl');
    await say(w, id, 'hello');
    const q = await askedTrust(w, id);
    expect(q.prompt).toBe(asks(w, hostOf(w.a), false));
    expect(q.prompt).not.toContain('key');
    expect(chat(w.a)).toHaveLength(0);
    w.a.push({ text: 'hi' });
    await answer(w, id, q, 'y');
    await until(() => turns(w, id) === 1);
    expect(chat(w.a)[0]!.headers.authorization).toBeUndefined();
    w.a.push({ text: 'again' });
    await say(w, id, 'second');
    await until(() => turns(w, id) === 2);
    expect(questionsAsked(w, id)).toBe(1);
  });
});

describe('"n" and "y" (spec 7.8)', () => {
  it('"n" sends nothing, ends the turn with a plain note, records nothing, and the next reply asks again', async () => {
    const w = await boot({ alwaysSend: true });
    const id = await session(w, 'kp');
    await say(w, id, 'hello');
    await answer(w, id, await askedTrust(w, id), 'n');
    await idle(w, id);
    expect(w.a.requests).toHaveLength(0);
    expect(notes(w, id)).toContain(`Nothing was sent: you did not allow ${hostOf(w.a)}.`);
    expect(w.store.hasConsent('kp', originOf(w.a))).toBe(false);
    await say(w, id, 'again');
    await until(() => trusts(w, id).length === 1);
    expect(questionsAsked(w, id)).toBe(2);
    expect(w.a.requests).toHaveLength(0);
  });

  it('"y" is remembered across a restart of the server (same store), and not for another id on the same address', async () => {
    const w = await boot({ alwaysSend: true, fileStore: true });
    const id = await session(w, 'kp');
    await say(w, id, 'hello');
    w.a.push({ text: 'hi' });
    await answer(w, id, await askedTrust(w, id), 'y');
    await until(() => turns(w, id) === 1);
    await w.restart();
    const again = await session(w, 'kp');
    w.a.push({ text: 'hi again' });
    await say(w, again, 'hello');
    await until(() => turns(w, again) === 1);
    expect(questionsAsked(w, again)).toBe(0);
    // Another id with the very same origin has no yes of its own.
    const other = await session(w, 'kl');
    await say(w, other, 'hello');
    expect((await askedTrust(w, other)).prompt).toBe(asks(w, hostOf(w.a), false));
    expect(w.store.hasConsent('kl', originOf(w.a))).toBe(false);
  });

  it('a revoke makes the next reply on a running session ask again, and nothing is sent until the answer', async () => {
    const w = await boot({ alwaysSend: true });
    const id = await session(w, 'kp');
    await grant(w, 'kp');
    w.a.push({ text: 'one' });
    await say(w, id, 'first');
    await until(() => turns(w, id) === 1);
    expect(questionsAsked(w, id)).toBe(0);
    expect((await w.call('POST', '/api/mods/kp/consent', { body: { revoke: true } })).json).toEqual({ ok: true, consent: 'needed' });
    const sent = w.a.requests.length;
    await say(w, id, 'second');
    const q = await askedTrust(w, id);
    await pause();
    expect(w.a.requests).toHaveLength(sent);
    w.a.push({ text: 'two' });
    await answer(w, id, q, 'y');
    await until(() => turns(w, id) === 2);
    expect(w.a.requests.length).toBe(sent + 1);
  });
});

describe('(d) a changed base address asks again (spec 7.8)', () => {
  it('after PUT baseUrl to the other fake the reply asks, the new origin sees no request, and Test connection says needs-consent', async () => {
    const w = await boot({ alwaysSend: true });
    await grant(w, 'kp');
    const edit = await w.call('PUT', '/api/mods/kp', { body: { baseUrl: `${w.b.url}/v1` } });
    expect(edit.status, edit.text).toBe(200);
    const id = await session(w, 'kp');
    await say(w, id, 'hello');
    const q = await askedTrust(w, id);
    expect(q.prompt).toBe(asks(w, hostOf(w.b)));
    await pause();
    expect(w.b.requests).toHaveLength(0);
    expect(w.a.requests).toHaveLength(0);
    expect((await w.call('POST', '/api/mods/kp/test')).json.result).toBe('needs-consent');
    expect(w.b.requests).toHaveLength(0);
    const listed = (await w.call('GET', '/api/mods')).json.mods.find((m: { id: string }) => m.id === 'kp');
    expect(listed).toMatchObject({ consent: 'needed', host: hostOf(w.b) });
    // Back at the first address the old yes still stands: it was for that origin.
    await w.call('PUT', '/api/mods/kp', { body: { baseUrl: `${w.a.url}/v1` } });
    expect((await w.call('GET', '/api/mods')).json.mods.find((m: { id: string }) => m.id === 'kp')).toMatchObject({ consent: 'granted' });
  });

  it('with the store-backed send alone a changed origin has no yes either (consent is not kept by id)', async () => {
    const w = await boot();
    w.store.grantConsent('kp', originOf(w.a));
    await w.call('PUT', '/api/mods/kp', { body: { baseUrl: `${w.b.url}/v1` } });
    expect(w.store.hasConsent('kp', originOf(w.b))).toBe(false);
    expect((await w.call('POST', '/api/mods/kp/test')).json.result).toBe('needs-consent');
    expect(w.b.requests).toHaveLength(0);
  });
});

describe('(c) the live model list asks before a keyed provider is fetched (spec 7.2, 7.8)', () => {
  it('no request however often the state is read; after the yes the list is fetched once with the key', async () => {
    const w = await boot({ alwaysSend: true });
    for (let i = 0; i < 3; i++) await w.call('GET', '/api/state');
    await pause();
    // The keyless provider on the same fake is listed without a yes; a request that carries a key is what must not happen.
    expect(w.a.requests.filter((r) => r.headers.authorization)).toEqual([]);
    expect(w.b.requests).toHaveLength(0);
    await grant(w, 'kp');
    await w.call('GET', '/api/state');
    await until(() => w.a.listRequests().some((r) => r.headers.authorization === `Bearer ${KEY}`));
    await w.call('GET', '/api/state');
    await pause();
    expect(w.a.listRequests().filter((r) => r.headers.authorization)).toHaveLength(1);
    expect(w.b.requests).toHaveLength(0);
  });

  it('a keyless provider is fetched without consent, with no key header; its first reply still asks', async () => {
    const w = await boot({ alwaysSend: true });
    await w.call('GET', '/api/state');
    await until(() => w.a.listRequests().length > 0);
    expect(w.a.listRequests().every((r) => r.headers.authorization === undefined)).toBe(true);
    expect(w.store.hasConsent('kl', originOf(w.a))).toBe(false);
    const id = await session(w, 'kl');
    await say(w, id, 'hello');
    await askedTrust(w, id);
    expect(chat(w.a)).toHaveLength(0);
  });

  it('the first-run probe of an engine makes no request at all', async () => {
    const w = await boot();
    const r = await probeFrom(w.mods, 'kp', { env: {}, home: w.dir });
    expect(r.loggedIn).toBe(true);
    expect(w.a.requests).toHaveLength(0);
  });
});

describe('(e) a subagent on another provider asks before it opens (spec 10.3, 7.8)', () => {
  const FRONT = '---\nreins: 1\nname: w\nbudget: { turns: 20, minutes: 20 }\nalways: []\n---\n\n';
  const SUB = `${FRONT}## subagent research\nmodel: ko:om\n> Look.\n\n## phase use\n> Use it.\n`;

  async function setup(alwaysSend: boolean) {
    const w = await boot({ alwaysSend });
    const row = w.store.createSession({ id: 's1', cwd: w.proj, engine: 'kp', model: 'm' });
    w.store.grantConsent('kp', originOf(w.a)); // the session's own provider is allowed; only the subagent's is not
    const yes = makeSend({ secrets: () => readSecrets(w.dir), env: {}, redactor: w.redactor, consent: () => true });
    const s = openSession({
      store: w.store, dir: w.dir, providers: checkEnvFrom(w.mods, { env: {}, home: w.dir }), consent: consentFrom(w.mods, w.store),
      makeEngine: makeEngineFrom(w.mods, { env: {}, home: w.dir, ...(alwaysSend ? { send: yes } : {}) }, (id, origin) => w.store.hasConsent(id, origin)),
    }, row, true);
    const file = path.join(w.proj, 'w.reins.md');
    fs.writeFileSync(file, SUB);
    const open = () => openQuestions(w.store.readLog('s1'));
    const seen = new Set<string>();
    // Answers every question but the one about the subagent's provider, which the test answers itself.
    const asked = async () => {
      await until(() => {
        for (const q of open()) if (q.kind === 'trust' && !q.prompt.includes(hostOf(w.b)) && !seen.has(q.id)) { seen.add(q.id); s.answer(q.id, 'y'); }
        return open().some((q) => q.prompt.includes(hostOf(w.b)));
      });
      return open().find((q) => q.prompt.includes(hostOf(w.b)))!;
    };
    return { w, s, file, asked };
  }

  it('asks about the subagent provider, nothing reaches it before the answer, and a yes lets the request go with its key', async () => {
    const x = await setup(true);
    x.w.b.push({ text: 'found it' });
    x.w.a.push({ text: 'REINS: done' });
    expect(x.s.runFile(x.file)).toEqual({ ok: true });
    const q = await x.asked();
    expect(q.prompt).toBe(asks(x.w, hostOf(x.w.b)));
    await pause();
    expect(x.w.b.requests).toHaveLength(0);
    x.s.answer(q.id, 'y');
    await x.s.idle();
    expect(chat(x.w.b)).toHaveLength(1);
    expect(chat(x.w.b)[0]!.headers.authorization).toBe(`Bearer ${KEY_KO}`);
    expect(x.w.store.hasConsent('ko', originOf(x.w.b))).toBe(true);
  });

  it('a no pauses the step and the other provider sees nothing', async () => {
    const x = await setup(true);
    expect(x.s.runFile(x.file)).toEqual({ ok: true });
    x.s.answer((await x.asked()).id, 'n');
    await until(() => openQuestions(x.w.store.readLog('s1')).some((q) => q.kind === 'resume'));
    expect(JSON.stringify(x.w.store.readLog('s1'))).toContain(`Nothing was sent: you did not allow ${hostOf(x.w.b)}.`);
    expect(x.w.b.requests).toHaveLength(0);
    expect(x.w.store.hasConsent('ko', originOf(x.w.b))).toBe(false);
    x.s.answer(openQuestions(x.w.store.readLog('s1')).find((q) => q.kind === 'resume')!.id, 'stop');
    await x.s.idle();
  });
});

describe('(f) a compaction call is guarded like a reply (spec 4.8, 7.8)', () => {
  it('after a revoke the compaction asks, sends nothing on a no, and on a yes makes its one summary call', async () => {
    const w = await boot({ alwaysSend: true });
    const id = await session(w, 'kp');
    await grant(w, 'kp');
    for (let n = 1; n <= 4; n++) {
      w.a.push({ text: para(`A${n}`) });
      await say(w, id, para(`Q${n}`));
      await until(() => turns(w, id) === n);
    }
    await w.call('POST', '/api/mods/kp/consent', { body: { revoke: true } });
    const sent = w.a.requests.length;
    expect((await w.call('POST', `/api/sessions/${id}/compress`)).status).toBe(200);
    const q = await askedTrust(w, id);
    await pause();
    expect(w.a.requests).toHaveLength(sent);
    await answer(w, id, q, 'n');
    await idle(w, id);
    expect(w.a.requests).toHaveLength(sent);
    expect(w.store.readLog(id).some((r) => r.type === 'engine' && (r.data as { type?: string }).type === 'compacted')).toBe(false);
    // The same compaction after a yes goes: it is the question that held it, not a compaction that cannot run.
    w.a.push({ text: 'SUMMARY TEXT' });
    expect((await w.call('POST', `/api/sessions/${id}/compress`)).status).toBe(200);
    await answer(w, id, await askedTrust(w, id), 'y');
    await idle(w, id);
    expect(w.a.requests).toHaveLength(sent + 1);
  });
});

describe('(h) the production host\'s send is the last guard (spec 7.8)', () => {
  const engineOn = (w: World, provider: string) => {
    const make = makeEngineFrom(w.mods, { env: {}, home: w.dir }, (id, origin) => w.store.hasConsent(id, origin));
    return make({ provider, onApprove: async () => ({ behavior: 'allow' }), onLive: () => {} });
  };

  it('an engine with nothing above it sends nothing without a yes for the current address, and sends with the key after it', async () => {
    const w = await boot();
    const s = await engineOn(w, 'kp').open({ cwd: w.proj, policy: () => ({}) as never });
    const refused = await s.turn('hello').then((r) => r, (e: Error) => e);
    expect(JSON.stringify(refused instanceof Error ? refused.message : refused)).toContain('not been allowed');
    expect(w.a.requests).toHaveLength(0);
    w.store.grantConsent('kp', originOf(w.b)); // a yes for another origin is no yes for this one
    await s.turn('hello').catch(() => {});
    expect(w.a.requests).toHaveLength(0);
    w.store.grantConsent('kp', originOf(w.a));
    w.a.push({ text: 'hi' });
    expect((await s.turn('hello')).text).toBe('hi');
    expect(chat(w.a)[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    await s.close();
  });

  it('the live model list through the host\'s send is refused without a yes, for a keyed provider', async () => {
    const w = await boot();
    const wire = (w.mods.registry.get('protocol-impl', 'openai-chat') as { wire: { listModels(p: unknown, h: unknown, s: AbortSignal): Promise<string[] | undefined> } }).wire;
    const manifest = (w.mods.registry.get('provider', 'kp') as { manifest: unknown }).manifest;
    const host = hostSend(w.mods, { env: {}, home: w.dir }, (id, origin) => w.store.hasConsent(id, origin));
    expect(await wire.listModels(manifest, { ...host, env: {}, home: w.dir }, AbortSignal.timeout(2000))).toBeUndefined();
    expect(w.a.requests).toHaveLength(0);
  });
});

describe('(b) Test connection asks before it sends (spec 7.6, 7.8)', () => {
  it('without a yes the answer is needs-consent and the fake saw no request, even through a send that would allow it', async () => {
    for (const alwaysSend of [false, true]) {
      const w = await boot({ alwaysSend });
      const r = await w.call('POST', '/api/mods/kp/test');
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ result: 'needs-consent', host: hostOf(w.a) });
      await pause(50);
      expect(w.a.requests).toHaveLength(0);
      w.mods.dispose(); // M3 Task 3: the next boot registers the default pack again; a loaded set must be gone first
    }
  });
});

describe('(g) the consent route takes the origin from the manifest only (spec 7.8)', () => {
  it('refuses an origin that is not the provider\'s own, records nothing, and accepts its own', async () => {
    const w = await boot();
    const foreign = await w.call('POST', '/api/mods/kp/consent', { body: { origin: originOf(w.b) } });
    expect(foreign.status).toBe(409);
    expect(w.store.hasConsent('kp', originOf(w.b))).toBe(false);
    expect(w.store.hasConsent('kp', originOf(w.a))).toBe(false);
    const evil = await w.call('POST', '/api/mods/kp/consent', { body: { origin: 'https://evil.test' } });
    expect(evil.status).toBe(409);
    expect(w.store.hasConsent('kp', 'https://evil.test')).toBe(false);
    expect((await w.call('POST', '/api/mods/kp/consent', { body: { origin: 7 } })).status).toBe(400);
    const ok = await w.call('POST', '/api/mods/kp/consent', { body: { origin: originOf(w.a) } });
    expect(ok.json).toEqual({ ok: true, consent: 'granted', origin: originOf(w.a) });
    expect(w.store.hasConsent('kp', originOf(w.a))).toBe(true);
    expect(w.store.hasConsent('kp', originOf(w.b))).toBe(false);
  });

  it('refuses a body that names no origin (A4), refuses a provider Reins does not send to, and DELETE revokes', async () => {
    const w = await boot();
    expect((await w.call('POST', '/api/mods/kp/consent')).status).toBe(409);
    expect(w.store.hasConsent('kp', originOf(w.a))).toBe(false);
    expect((await w.call('POST', '/api/mods/kp/consent', { body: { origin: originOf(w.a) } })).json).toMatchObject({ consent: 'granted' });
    expect((await w.call('POST', '/api/mods/claude-code/consent')).status).toBe(404);
    expect((await w.call('POST', '/api/mods/nope/consent')).status).toBe(404);
    expect((await w.call('POST', '/api/mods/..%2Fx/consent')).status).toBe(400);
    expect((await w.call('DELETE', '/api/mods/kp/consent')).json).toEqual({ ok: true, consent: 'needed' });
    expect(w.store.hasConsent('kp', originOf(w.a))).toBe(false);
  });
});

describe('removing and re-installing a provider (spec 7.8)', () => {
  it('Remove deletes the consent entries of every origin; a provider added again with the same id and address asks again', async () => {
    const w = await boot();
    w.store.grantConsent('kp', originOf(w.a));
    w.store.grantConsent('kp', originOf(w.b));
    w.store.grantConsent('ko', originOf(w.b));
    expect((await w.call('DELETE', '/api/mods/kp')).status).toBe(200);
    expect(w.store.hasConsent('kp', originOf(w.a))).toBe(false);
    expect(w.store.hasConsent('kp', originOf(w.b))).toBe(false);
    expect(w.store.hasConsent('ko', originOf(w.b))).toBe(true); // another id is not touched
    const back = await w.call('POST', '/api/mods/custom', { body: { id: 'kp', label: 'Keyed', protocol: 'openai-chat', baseUrl: `${w.a.url}/v1`, auth: { style: 'bearer', keyEnv: 'KP_API_KEY' }, defaultModel: 'm' } });
    expect(back.status, back.text).toBe(200);
    expect((await w.call('GET', '/api/mods')).json.mods.find((m: { id: string }) => m.id === 'kp')).toMatchObject({ consent: 'needed' });
  });

  it('Re-install from the catalog asks again; nothing is regranted', async () => {
    const w = await boot();
    expect((await w.call('POST', '/api/mods/install', { body: { ids: ['cat'] } })).status).toBe(200);
    await grant(w, 'cat');
    expect((await w.call('GET', '/api/mods')).json.mods.find((m: { id: string }) => m.id === 'cat')).toMatchObject({ consent: 'granted' });
    expect((await w.call('POST', '/api/mods/cat/reinstall')).status).toBe(200);
    expect(w.store.hasConsent('cat', originOf(w.a))).toBe(false);
    expect((await w.call('GET', '/api/mods')).json.mods.find((m: { id: string }) => m.id === 'cat')).toMatchObject({ consent: 'needed' });
  });
});

describe('what the lists report (spec 8.1, 7.8)', () => {
  it('/api/mods and /api/state carry the key STATE and the consent state, and a provider Reins does not send to carries neither', async () => {
    const w = await boot();
    const mods = (await w.call('GET', '/api/mods')).json.mods as Array<Record<string, any>>;
    expect(mods.find((m) => m.id === 'kp')).toMatchObject({ host: hostOf(w.a), key: { state: 'set', source: 'Reins' }, consent: 'needed' });
    expect(mods.find((m) => m.id === 'kl')).toMatchObject({ key: { state: 'none' }, consent: 'needed' });
    expect(mods.find((m) => m.id === 'claude-code')).not.toHaveProperty('consent');
    await grant(w, 'kp');
    const state = (await w.call('GET', '/api/state')).json;
    expect(state.groups.find((g: { id: string }) => g.id === 'kp')).toMatchObject({ consent: 'granted' });
    expect(state.groups.find((g: { id: string }) => g.id === 'ko')).toMatchObject({ consent: 'needed' });
    expect(state.groups.find((g: { id: string }) => g.id === 'claude-code')).not.toHaveProperty('consent');
  });
});

// ---- 4. Test connection

describe('Test connection: the five results (spec 7.6)', () => {
  const test = async (w: World, id = 'kp') => (await w.call('POST', `/api/mods/${id}/test`)).json as { result: string; message: string; host: string; models?: number };

  it('ok: "Reached <host>: N models.", one GET of the list, the key only on the provider\'s own origin, no model call', async () => {
    const w = await boot();
    await grant(w, 'kp');
    const r = await test(w);
    expect(r).toEqual({ result: 'ok', message: `Reached ${hostOf(w.a)}: 2 models.`, host: hostOf(w.a), models: 2 });
    expect(w.a.requests).toHaveLength(1);
    expect(w.a.requests[0]).toMatchObject({ path: '/v1/models', headers: { authorization: `Bearer ${KEY}` } });
    expect(chat(w.a)).toHaveLength(0);
    expect(w.b.requests).toHaveLength(0);
  });

  it('401 and 403: "The key was refused.", the provider\'s words (which hold the key) are not shown, one request, no retry', async () => {
    for (const status of [401, 403]) {
      const w = await boot();
      await grant(w, 'kp');
      w.a.list.status = status;
      w.a.list.errorBody = `nope ${KEY}`;
      expect(await test(w)).toEqual({ result: 'bad-key', message: 'The key was refused.', host: hostOf(w.a) });
      expect(w.a.requests).toHaveLength(1);
      w.mods.dispose(); // M3 Task 3: as above
    }
  });

  it('404: the host answered but has no model list', async () => {
    const w = await boot();
    await grant(w, 'kp');
    w.a.list.status = 404;
    expect(await test(w)).toEqual({ result: 'not-found', message: `Reached ${hostOf(w.a)}; it has no model list, so the first reply will tell.`, host: hostOf(w.a) });
    expect(w.a.requests).toHaveLength(1);
  });

  it('a closed port: unreachable, with the cause', async () => {
    const w = await boot();
    await grant(w, 'dead');
    const r = await test(w, 'dead');
    expect(r.result).toBe('unreachable');
    expect(r.message).toMatch(new RegExp(`^Cannot reach 127\\.0\\.0\\.1:${w.deadPort}: `));
  });

  it('a 302: redirected, the redirect is not followed, so the other origin sees nothing and the key goes only to the first', async () => {
    const w = await boot();
    await grant(w, 'kp');
    w.a.list.redirectTo = `${w.b.url}/v1/models`;
    w.a.list.redirectStatus = 302;
    const r = await test(w);
    expect(r).toEqual({ result: 'redirected', message: 'Keyed answered with a redirect to another address; Reins does not follow it with your key.', host: hostOf(w.a) });
    expect(w.a.requests).toHaveLength(1);
    expect(w.b.requests).toHaveLength(0);
  });

  it('no answer in time: unreachable, one request, no retry', async () => {
    const w = await boot({ testTimeoutMs: 150 });
    await grant(w, 'kp');
    w.a.list.hangMs = 3000;
    const r = await test(w);
    expect(r.result).toBe('unreachable');
    expect(r.message).toBe(`Cannot reach ${hostOf(w.a)}: no answer in 0.2 seconds.`);
    await pause(300);
    expect(w.a.requests).toHaveLength(1);
  });

  it('a server error: unreachable, the provider\'s words cut to 200 characters with the key hidden, one request', async () => {
    const w = await boot();
    await grant(w, 'kp');
    w.a.list.status = 500;
    w.a.list.errorBody = `${'e'.repeat(150)}${KEY}${'f'.repeat(400)}`;
    const r = await test(w);
    expect(r.result).toBe('unreachable');
    expect(r.message).toContain('it answered 500.');
    expect(r.message).toContain('[key Reins]');
    expect(r.message.length).toBeLessThan(`Cannot reach ${hostOf(w.a)}: it answered 500. `.length + 205);
    expect(w.a.requests).toHaveLength(1);
  });

  it('a key that is not set: bad-key with the missing-key words, no request', async () => {
    const w = await boot();
    await grant(w, 'kp');
    clearKey(w.dir, 'kp');
    expect((await test(w)).message).toBe('Keyed has no key. Set KP_API_KEY, or add a key in Settings > Providers.');
    expect(w.a.requests).toHaveLength(0);
  });

  it('a keyless provider: the list is asked without a yes (it holds no prompt and no key) and with no key header', async () => {
    const w = await boot();
    expect(await test(w, 'kl')).toMatchObject({ result: 'ok' });
    expect(w.a.requests).toHaveLength(1);
    expect(w.a.requests[0]!.headers.authorization).toBeUndefined();
  });

  it('a provider that is not installed, or that Reins does not send to, is a 404; a bad id is a 400', async () => {
    const w = await boot();
    expect((await w.call('POST', '/api/mods/nope/test')).status).toBe(404);
    expect((await w.call('POST', '/api/mods/claude-code/test')).status).toBe(404);
    expect((await w.call('POST', '/api/mods/..%2Fx/test')).status).toBe(400);
  });
});

// ---- 6. key routes

describe('PUT / DELETE /api/mods/:id/key (spec 8.1)', () => {
  const put = (w: World, id: string, key: unknown) => w.call('PUT', `/api/mods/${id}/key`, { body: { key } });

  it('stores the key in the secrets file, answers only its state, the Redactor knows it at once and a later leak is masked', async () => {
    const w = await boot();
    const r = await put(w, 'kp', KEY2);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, keyStatus: { state: 'set', source: 'Reins' } });
    expect(readSecrets(w.dir).get('kp')).toBe(KEY2);
    expect(w.redactor.has(`prefix ${KEY2} suffix`)).toBe(true);
    expect(w.redactor.redact(`leak: ${KEY2}`)).toBe('leak: [key Reins]');
    // The new key is the one that is sent.
    await grant(w, 'kp');
    await w.call('POST', '/api/mods/kp/test');
    expect(w.a.requests[0]!.headers.authorization).toBe(`Bearer ${KEY2}`);
    // And a provider's later echo of it comes back masked.
    w.a.list.status = 500;
    w.a.list.errorBody = `echo ${KEY2}`;
    const echoed = await w.call('POST', '/api/mods/kp/test');
    expect(echoed.json.message).toContain('[key Reins]');
  });

  it.skipIf(!POSIX)('the secrets file is mode 0600', async () => {
    const w = await boot();
    await put(w, 'kp', KEY2);
    expect(fs.statSync(path.join(w.dir, 'secrets.json')).mode & 0o777).toBe(0o600);
  });

  it('the key is in no file of the Reins folder but secrets.json (not mod.json, not the log, not the database), and not in the state or the events', async () => {
    const w = await boot({ alwaysSend: true, fileStore: true });
    await put(w, 'kp', KEY2);
    await grant(w, 'kp');
    const id = await session(w, 'kp');
    w.a.push({ text: 'hi' });
    await say(w, id, 'hello');
    await until(() => turns(w, id) === 1);
    expect(chat(w.a)[0]!.headers.authorization).toBe(`Bearer ${KEY2}`);
    await w.call('GET', '/api/state');
    const files: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk : (f: string) => files.push(f))(path.join(d, e.name)); };
    walk(w.root);
    for (const f of files) {
      if (path.basename(f) === 'secrets.json' || f.includes(`${path.sep}catalog${path.sep}`)) continue;
      const bytes = fs.readFileSync(f).toString('latin1');
      expect(bytes.includes(KEY2), f).toBe(false);
    }
    expect(JSON.stringify(w.store.readLog(id))).not.toContain(KEY2);
    expect(fs.readFileSync(path.join(w.dir, 'mods', 'kp', 'mod.json'), 'utf8')).not.toContain(KEY2);
  });

  it('refuses control characters, line breaks, empty and blank text, 5,000 characters and a non-string, and keeps the old key', async () => {
    const w = await boot();
    for (const bad of ['a\nb', 'a\rb', 'a\u0000b', 'a\u001bb', 'a\u007fb', `${KEY2}\n`, '', '   ', 'x'.repeat(5000), 12, null, ['a'], { k: 1 }]) {
      const r = await put(w, 'kp', bad);
      expect(r.status, JSON.stringify(bad).slice(0, 40)).toBe(400);
      expect(typeof r.json.error).toBe('string');
    }
    expect((await w.call('PUT', '/api/mods/kp/key', { body: {} })).status).toBe(400);
    expect(readSecrets(w.dir).get('kp')).toBe(KEY);
    expect((await put(w, 'kp', 'x'.repeat(4096))).status).toBe(200);
  });

  it('a provider that is not installed is a 404, a keyless one and the CLI provider a 409, nothing is written for them', async () => {
    const w = await boot();
    expect((await put(w, 'nope', KEY2)).status).toBe(404);
    expect((await put(w, 'kl', KEY2)).status).toBe(409);
    expect((await put(w, 'claude-code', KEY2)).status).toBe(409);
    expect([...readSecrets(w.dir).keys()].sort()).toEqual(['dead', 'ko', 'kp']);
  });

  it('a bad id is refused before the file system is touched', async () => {
    const w = await boot();
    // Not statSync: the response filter (the Redactor) looks at secrets.json's stamp on every reply, whatever the route.
    const names = ['readFileSync', 'writeFileSync', 'renameSync', 'mkdirSync', 'lstatSync', 'existsSync', 'readdirSync', 'rmSync'] as const;
    const spies = names.map((n) => vi.spyOn(fs, n));
    for (const id of ['..%2Fx', 'a%2Fb', 'CON', '%00', 'A', 'x'.repeat(41)]) {
      const r = await put(w, id, KEY2);
      expect(r.status, id).toBe(400);
      expect((await w.call('DELETE', `/api/mods/${id}/key`)).status, id).toBe(400);
    }
    const touched = spies.flatMap((s) => s.mock.calls).filter((c) => typeof c[0] === 'string' && (c[0] as string).startsWith(w.root));
    expect(touched).toEqual([]);
    expect(readSecrets(w.dir).get('kp')).toBe(KEY);
  });

  it('DELETE clears the key and answers the state; the old key is no longer sent', async () => {
    const w = await boot();
    expect((await w.call('DELETE', '/api/mods/kp/key')).json).toEqual({ ok: true, keyStatus: { state: 'missing' } });
    expect(readSecrets(w.dir).has('kp')).toBe(false);
    expect((await w.call('DELETE', '/api/mods/kp/key')).status).toBe(200); // clearing nothing is fine
    expect((await w.call('DELETE', '/api/mods/zz-gone/key')).status).toBe(200);
  });

  it('needs the token, the Host and the Origin of the server like its neighbours, and a body over 1 MB is a 413; nothing is stored', async () => {
    const w = await boot();
    expect((await w.call('PUT', '/api/mods/kp/key', { auth: false, body: { key: KEY2 } })).status).toBe(401);
    expect((await w.call('PUT', '/api/mods/kp/key', { headers: { host: 'evil.test' }, body: { key: KEY2 } })).status).toBe(403);
    expect((await w.call('PUT', '/api/mods/kp/key', { headers: { origin: 'https://evil.test' }, body: { key: KEY2 } })).status).toBe(403);
    expect((await w.call('POST', '/api/mods/kp/consent', { auth: false, body: {} })).status).toBe(401);
    expect((await w.call('POST', '/api/mods/kp/test', { auth: false })).status).toBe(401);
    expect((await w.call('PUT', '/api/mods/kp/key', { raw: JSON.stringify({ key: 'k'.repeat(1024 * 1024 + 10) }) })).status).toBe(413);
    expect(readSecrets(w.dir).get('kp')).toBe(KEY);
    expect(w.store.hasConsent('kp', originOf(w.a))).toBe(false);
  });
});

// ---- fix round (the Codex review of Task 21)

const engineFor = (w: World, provider: string) => {
  const make = makeEngineFrom(w.mods, { env: {}, home: w.dir }, (id, origin) => w.store.hasConsent(id, origin));
  return make({ provider, onApprove: async () => ({ behavior: 'allow' }), onLive: () => {} });
};
const rejection = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: Error) => e))?.message ?? '';

describe('an engine that is already open never sends to an address other than the consented one (blocker 1)', () => {
  it.each([true, false])('the session: an address edited while its engine is open asks again, and neither fake sees a request first (always-yes send: %s)', async (alwaysSend) => {
    const w = await boot({ alwaysSend });
    await grant(w, 'kp');
    const id = await session(w, 'kp');
    w.a.push({ text: 'one' });
    await say(w, id, 'first');
    await until(() => turns(w, id) === 1);
    expect((await w.call('PUT', '/api/mods/kp', { body: { baseUrl: `${w.b.url}/v1` } })).status).toBe(200);
    const sentToA = w.a.requests.length;
    await say(w, id, 'second');
    const q = await askedTrust(w, id);
    expect(q.prompt).toBe(asks(w, hostOf(w.b)));
    await pause();
    expect(w.a.requests).toHaveLength(sentToA);
    expect(w.b.requests).toHaveLength(0);
    w.b.push({ text: 'to b' });
    await answer(w, id, q, 'y');
    await until(() => turns(w, id) === 2);
    expect(w.a.requests).toHaveLength(sentToA);
    expect(chat(w.b)).toHaveLength(1);
    expect(chat(w.b)[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(w.store.hasConsent('kp', originOf(w.b))).toBe(true);
  });

  it('the host send: an engine opened for one address sends nothing after the provider moved, even where the old address is still consented', async () => {
    const w = await boot();
    w.store.grantConsent('kp', originOf(w.a));
    const s = await engineFor(w, 'kp').open({ cwd: w.proj, policy: () => ({}) as never });
    w.a.push({ text: 'one' });
    expect((await s.turn('first')).text).toBe('one');
    await w.call('PUT', '/api/mods/kp', { body: { baseUrl: `${w.b.url}/v1` } });
    w.store.grantConsent('kp', originOf(w.b)); // the consent is not what holds it back
    const before = w.a.requests.length;
    expect(await rejection(s.turn('second'))).toBe('The address of Keyed changed. The next reply asks again.');
    expect(w.a.requests).toHaveLength(before);
    expect(w.b.requests).toHaveLength(0);
    await s.close();
  });

  it.each([['removed', () => ['DELETE', '/api/mods/kp'] as const], ['switched off', () => ['POST', '/api/mods/kp/disable'] as const]])('the host send: a provider %s while its engine is open sends nothing, consent or not', async (_how, how) => {
    const w = await boot();
    w.store.grantConsent('kp', originOf(w.a));
    const s = await engineFor(w, 'kp').open({ cwd: w.proj, policy: () => ({}) as never });
    w.a.push({ text: 'one' });
    await s.turn('first');
    const [method, url] = how();
    expect((await w.call(method, url)).status).toBe(200);
    w.store.grantConsent('kp', originOf(w.a));
    const before = w.a.requests.length;
    expect(await rejection(s.turn('second'))).toBe('Keyed is no longer installed or is switched off, so nothing was sent.');
    expect(w.a.requests).toHaveLength(before);
    await s.close();
  });

  it('a yes counts only for the address the question showed: an address that changed while it was open grants nothing and the new one is asked', async () => {
    const w = await boot();
    const id = await session(w, 'kp');
    await say(w, id, 'hello');
    const q = await askedTrust(w, id);
    expect(q.prompt).toBe(asks(w, hostOf(w.a)));
    await w.call('PUT', '/api/mods/kp', { body: { baseUrl: `${w.b.url}/v1` } });
    await answer(w, id, q, 'y');
    await until(() => trusts(w, id).some((x) => x.prompt === asks(w, hostOf(w.b))));
    expect(w.store.hasConsent('kp', originOf(w.a))).toBe(false);
    expect(w.store.hasConsent('kp', originOf(w.b))).toBe(false);
    expect(w.a.requests).toHaveLength(0);
    expect(w.b.requests).toHaveLength(0);
    await answer(w, id, trusts(w, id)[0]!, 'n');
    await idle(w, id);
  });

  it('the consent is looked at again for every request: a revoke while the engine is open stops the next request', async () => {
    const w = await boot();
    w.store.grantConsent('kp', originOf(w.a));
    const s = await engineFor(w, 'kp').open({ cwd: w.proj, policy: () => ({}) as never });
    w.a.push({ text: 'one' });
    expect((await s.turn('first')).text).toBe('one');
    expect(chat(w.a)).toHaveLength(1);
    w.store.revokeConsent('kp');
    expect(await rejection(s.turn('second'))).toContain('not been allowed');
    expect(chat(w.a)).toHaveLength(1);
    await s.close();
  });
});

describe('a retired key stays masked (blocker 2)', () => {
  it('Test connection with a slow 500 that echoes the Authorization header: the key is deleted meanwhile and the answer holds no part of it', async () => {
    const w = await boot();
    await grant(w, 'kp');
    w.a.list.status = 500;
    w.a.list.echoAuth = true;
    w.a.list.hangMs = 500;
    const pending = w.call('POST', '/api/mods/kp/test'); // the call() wrapper fails the test if any answer holds the key or its start
    await until(() => w.a.requests.length === 1, 3000).catch(() => {});
    await pause(100);
    expect((await w.call('DELETE', '/api/mods/kp/key')).json.keyStatus).toEqual({ state: 'missing' });
    expect(readSecrets(w.dir).has('kp')).toBe(false);
    const r = await pending;
    expect(r.json.result).toBe('unreachable');
    expect(r.json.message).toContain('[key Reins]');
    expect(r.text).not.toContain(KEY.slice(8));
  });

  it('a key replaced while a reply is in flight: the old value is masked in the reply that echoes it', async () => {
    const w = await boot();
    w.store.grantConsent('kp', originOf(w.a));
    const s = await engineFor(w, 'kp').open({ cwd: w.proj, policy: () => ({}) as never });
    w.a.push({ text: `echo ${KEY} end`, hangMs: 500 });
    const turn = s.turn('hello');
    await until(() => w.a.requests.length === 1, 3000).catch(() => {});
    await pause(100);
    expect((await w.call('PUT', '/api/mods/kp/key', { body: { key: KEY_NEW } })).status).toBe(200);
    const res = await turn;
    expect(res.text).toBe('echo [key Reins] end');
    await s.close();
  });

  it('a Redactor keeps what it learned when the key leaves the file (refresh adds, never removes)', () => {
    const w = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'reins-ret-')) };
    try {
      setKey(w.dir, 'p', KEY);
      const red = new Redactor({ home: w.dir, env: {}, keyEnvNames: () => [] });
      clearKey(w.dir, 'p');
      red.refresh();
      expect(red.redact(`echo ${KEY}`)).toBe('echo [key Reins]');
      setKey(w.dir, 'p', KEY_NEW); // a rotation
      red.refresh();
      expect(red.redact(`${KEY} ${KEY_NEW}`)).toBe('[key Reins] [key Reins]');
    } finally {
      rm(w.dir);
    }
  });

  it('retired keys are bounded at 1,000 (the literal, not the constant): the oldest retired one goes when a 1,001st is retired', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-cap-'));
    try {
      const env: NodeJS.ProcessEnv = {};
      const red = new Redactor({ home: dir, env, keyEnvNames: () => ['ROT_API_KEY'] });
      const v = (i: number) => `rotated-key-${String(i).padStart(5, '0')}`;
      for (let i = 0; i <= 1000; i++) { env.ROT_API_KEY = v(i); red.refresh(); } // v0 .. v999 retired (1,000 of them), v1000 current
      expect(MAX_RETAINED).toBe(1000);
      expect(red.has(v(0))).toBe(true);
      expect(red.has(v(1000))).toBe(true);
      env.ROT_API_KEY = v(1001);
      red.refresh(); // a 1,001st is retired: the first one retired is let go
      expect(red.has(v(0))).toBe(false);
      expect(red.has(v(1))).toBe(true);
      expect(red.has(v(1001))).toBe(true);
    } finally {
      rm(dir);
    }
  });

  it('the redacting store keeps a retired key out of what it writes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-rs-'));
    const inner = openStore(':memory:');
    try {
      setKey(dir, 'p', KEY);
      const red = new Redactor({ home: dir, env: {}, keyEnvNames: () => [] });
      const store = redactingStore(inner, red);
      clearKey(dir, 'p');
      red.refresh();
      store.appendLog('s1', { type: 'note', data: { text: `the old key was ${KEY}` } });
      expect(JSON.stringify(inner.readLog('s1'))).not.toContain(KEY);
      expect(JSON.stringify(inner.readLog('s1'))).toContain('[key Reins]');
    } finally {
      inner.close();
      rm(dir);
    }
  });

  it('a key that is about to be attached is learned by the sender, even if the redactor never saw it in the file', async () => {
    const w = await boot();
    const red = new Redactor({ home: path.join(w.root, 'elsewhere'), env: {}, keyEnvNames: () => [] }); // reads no file: knows nothing
    const send = makeSend({ secrets: () => readSecrets(w.dir), env: {}, redactor: red, consent: () => true });
    w.a.list.status = 500;
    w.a.list.echoAuth = true;
    const err = await rejection(send((w.mods.registry.get('provider', 'kp') as { manifest: never }).manifest, `${w.a.url}/v1/models`, { method: 'GET' }));
    expect(err).not.toContain(KEY);
    expect(err).not.toContain(KEY.slice(8)); // the whole key was learned, not its start
    expect(err).toContain('Bearer [key Reins]');
  });
});

describe('a key shorter than 8 characters is refused (blocker 3, spec 8.3)', () => {
  it('PUT key: 7 refused, 8 accepted, a padded 7 refused, nothing written when refused', async () => {
    const w = await boot();
    for (const short of ['1234567', '  1234567  ', 'abc']) {
      const r = await w.call('PUT', '/api/mods/kp/key', { body: { key: short } });
      expect(r.status, short).toBe(400);
      expect(r.json.error).toContain('at least 8 characters');
      expect(readSecrets(w.dir).get('kp')).toBe(KEY);
    }
    expect((await w.call('PUT', '/api/mods/kp/key', { body: { key: '12345678' } })).status).toBe(200);
    expect(readSecrets(w.dir).get('kp')).toBe('12345678');
  });

  it('POST custom: a 7 character key refuses the endpoint and writes nothing; 8 adds it', async () => {
    const w = await boot();
    const body = (key: string) => ({ id: 'np', label: 'Np', protocol: 'openai-chat', baseUrl: `${w.a.url}/v1`, auth: { style: 'bearer', keyEnv: 'NP_API_KEY' }, defaultModel: 'm', key });
    const r = await w.call('POST', '/api/mods/custom', { body: body('1234567') });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('at least 8 characters');
    expect(fs.existsSync(path.join(w.dir, 'mods', 'np'))).toBe(false);
    expect(readSecrets(w.dir).has('np')).toBe(false);
    const ok = await w.call('POST', '/api/mods/custom', { body: body('12345678') });
    expect(ok.status, ok.text).toBe(200);
    expect(readSecrets(w.dir).get('np')).toBe('12345678');
  });
});

describe('Test connection reads the body like a request (should-fix)', () => {
  const wires = (a: Fake, b: Fake) => {
    void b;
    return [
      prov('ms', { label: 'Msgs', protocol: 'anthropic-messages', baseUrl: a.url, auth: { style: 'header', keyEnv: ['MS_API_KEY'] } }),
      prov('msl', { label: 'MsgsFree', protocol: 'anthropic-messages', baseUrl: a.url, auth: { style: 'none', keyEnv: [] }, price: { input: 0, output: 0 } }),
    ];
  };
  const test = async (w: World, id: string) => (await w.call('POST', `/api/mods/${id}/test`)).json as { result: string; message: string };

  it('the Messages wire: a keyed provider (default key header, ?limit=1000 list) and a keyless one both reach the list', async () => {
    const w = await boot({ extra: wires });
    expect((await w.call('PUT', '/api/mods/ms/key', { body: { key: KEY_MS } })).status).toBe(200);
    await grant(w, 'ms');
    expect(await test(w, 'ms')).toMatchObject({ result: 'ok', message: `Reached ${hostOf(w.a)}: 2 models.` });
    expect(w.a.requests.at(-1)!.headers['x-api-key']).toBe(KEY_MS);
    expect(await test(w, 'msl')).toMatchObject({ result: 'ok' }); // keyless: no consent asked, the exact list address with its fixed query is recognised
    expect(w.a.requests.at(-1)!.headers['x-api-key']).toBeUndefined();
    expect(w.a.requests.at(-1)!.headers.authorization).toBeUndefined();
  });

  it.each([['kp'], ['ms']])('%s: a 200 whose body never ends is unreachable at the limit, not ok', async (id) => {
    const w = await boot({ extra: wires, testTimeoutMs: 300 });
    await w.call('PUT', '/api/mods/ms/key', { body: { key: KEY_MS } });
    await grant(w, id);
    w.a.list.stall = true;
    const t0 = Date.now();
    const r = await test(w, id);
    expect(r.result).toBe('unreachable');
    expect(r.message).toContain('no answer in');
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(w.a.listRequests()).toHaveLength(1);
  });

  it.each([['kp'], ['ms']])('%s: HTML, or JSON that is no list, is said plainly and is not ok', async (id) => {
    const w = await boot({ extra: wires });
    await w.call('PUT', '/api/mods/ms/key', { body: { key: KEY_MS } });
    await grant(w, id);
    for (const [raw, type] of [['<html><body>Sign in</body></html>', 'text/html'], ['{"oops": true}', 'application/json'], ['not json at all', 'application/json']] as const) {
      w.a.list.rawBody = raw;
      w.a.list.rawType = type;
      const r = await test(w, id);
      expect(r.result).toBe('not-found');
      expect(r.message).toBe(`Reached ${hostOf(w.a)}, but it answered with something that is not a model list, so the first reply will tell.`);
    }
  });

  it('a list over 1 MB is refused (the read stops at the cap), a smaller one is read', async () => {
    const w = await boot();
    await grant(w, 'kp');
    w.a.list.data = Array.from({ length: 40000 }, (_, i) => ({ id: `model-${String(i).padStart(8, '0')}-${'x'.repeat(20)}` }));
    const big = await test(w, 'kp');
    expect(big.result).toBe('unreachable');
    expect(big.message).toContain('larger than 1 MB');
    w.a.list.data = Array.from({ length: 1500 }, (_, i) => ({ id: `model-${i}` }));
    expect(await test(w, 'kp')).toMatchObject({ result: 'ok', message: `Reached ${hostOf(w.a)}: 1500 models.` });
  });

  it('the live list and Test connection read ONE request definition from the wire', async () => {
    const w = await boot({ extra: wires });
    for (const id of ['kp', 'ms', 'msl']) {
      const req = (w.mods.registry.get('protocol-impl', id === 'kp' ? 'openai-chat' : 'anthropic-messages') as { wire: { listRequest(p: unknown): { url: string; manifest: { auth?: { header?: string } } } } }).wire
        .listRequest((w.mods.registry.get('provider', id) as { manifest: unknown }).manifest);
      expect(req.url).toBe(id === 'kp' ? `${w.a.url}/v1/models` : `${w.a.url}/v1/models?limit=1000`);
      if (id === 'ms') expect(req.manifest.auth?.header).toBe('x-api-key');
    }
  });
});

describe('boundaries of Test connection and of the key route (should-fix)', () => {
  const test = async (w: World) => (await w.call('POST', '/api/mods/kp/test')).json as { result: string; message: string };

  it('a key of 4,096 characters is stored, one of 4,097 is refused', async () => {
    const w = await boot();
    expect((await w.call('PUT', '/api/mods/kp/key', { body: { key: 'k'.repeat(4096) } })).status).toBe(200);
    expect((await w.call('PUT', '/api/mods/kp/key', { body: { key: 'k'.repeat(4097) } })).status).toBe(400);
    expect(readSecrets(w.dir).get('kp')).toBe('k'.repeat(4096));
  });

  it('with no option the abort comes at 8 seconds', async () => {
    const w = await boot();
    await grant(w, 'kp');
    w.a.list.hangMs = 30_000;
    const t0 = Date.now();
    const r = await test(w);
    const took = Date.now() - t0;
    expect(r.result).toBe('unreachable');
    expect(r.message).toBe(`Cannot reach ${hostOf(w.a)}: no answer in 8 seconds.`);
    expect(took).toBeGreaterThan(7500);
    expect(took).toBeLessThan(10_500);
  }, 20_000);

  it('the provider\'s words are cut to 200 characters', async () => {
    const w = await boot();
    await grant(w, 'kp');
    w.a.list.status = 500;
    w.a.list.errorBody = 'a'.repeat(201);
    const r = await test(w);
    expect(r.message).toContain('a'.repeat(200));
    expect(r.message).not.toContain('a'.repeat(201));
  });

  it('a revoke while the engine is open stops the next request (the consent is not remembered per request)', async () => {
    const w = await boot();
    w.store.grantConsent('kp', originOf(w.a));
    const s = await engineFor(w, 'kp').open({ cwd: w.proj, policy: () => ({}) as never });
    w.a.push({ text: 'ok' });
    expect((await s.turn('one')).text).toBe('ok');
    w.store.revokeConsent('kp');
    w.a.push({ text: 'must not be asked' });
    await s.turn('two').catch(() => {});
    expect(chat(w.a)).toHaveLength(1);
    await s.close();
  });
});

describe('a key in the address is refused (should-fix)', () => {
  it('PUT and DELETE with a query string are 400 before the body is read, nothing is stored and the query is not echoed', async () => {
    const w = await boot();
    const r = await w.call('PUT', '/api/mods/kp/key?key=abc12345query', { body: { key: KEY2 } });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain('abc12345');
    expect(readSecrets(w.dir).get('kp')).toBe(KEY);
    expect((await w.call('PUT', '/api/mods/kp/key?x=1', { body: { key: KEY2 } })).status).toBe(400);
    expect((await w.call('DELETE', '/api/mods/kp/key?key=abc12345query')).status).toBe(400);
    expect(readSecrets(w.dir).get('kp')).toBe(KEY);
  });
});

describe('every new route gives the neighbours\' refusals (should-fix)', () => {
  const routes: Array<[string, 'PUT' | 'DELETE' | 'POST', string, unknown]> = [
    ['key PUT', 'PUT', '/api/mods/kp/key', { key: KEY2 }],
    ['key DELETE', 'DELETE', '/api/mods/kp/key', undefined],
    ['consent POST', 'POST', '/api/mods/kp/consent', {}],
    ['consent DELETE', 'DELETE', '/api/mods/kp/consent', undefined],
    ['test POST', 'POST', '/api/mods/kp/test', undefined],
  ];
  it.each(routes)('%s: no token is 401, a wrong Host or Origin is 403, and nothing happened', async (_name, method, url, body) => {
    const w = await boot();
    w.store.grantConsent('kp', originOf(w.a));
    const o = (extra: { auth?: boolean; headers?: Record<string, string> }) => ({ ...(body !== undefined ? { body } : {}), ...extra });
    expect((await w.call(method, url, o({ auth: false }))).status).toBe(401);
    expect((await w.call(method, url, o({ headers: { authorization: 'Bearer wrong' } }))).status).toBe(401);
    expect((await w.call(method, url, o({ headers: { host: 'evil.test' } }))).status).toBe(403);
    expect((await w.call(method, url, o({ headers: { origin: 'https://evil.test' } }))).status).toBe(403);
    expect(readSecrets(w.dir).get('kp')).toBe(KEY);
    expect(w.store.hasConsent('kp', originOf(w.a))).toBe(true);
    expect(w.a.requests).toHaveLength(0);
  });
});

// ---- fix round 2 (the second Codex review of Task 21)

describe('the installed provider is looked at once more, right before the request starts (B1)', () => {
  const A = 'http://a.test';
  const B = 'http://b.test';
  const installed = (baseUrl: string, over: Record<string, unknown> = {}) => ({ id: 'sp', kind: 'provider', label: 'Sp', baseUrl, ...over });
  const manifest = (over: Record<string, unknown> = {}) => ({
    reins: 1, id: 'sp', kind: 'provider', version: '1', label: 'Sp', protocol: 'openai-chat', baseUrl: `${A}/v1`,
    auth: { style: 'bearer', keyEnv: ['SP_KEY'] }, defaultModel: 'm', models: [{ id: 'm' }], ...over,
  }) as unknown as ProviderManifest;
  const rig2 = (o: { consent?: () => boolean | Promise<boolean>; current?: () => unknown; keyless?: boolean; listUrl?: string } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-send2-'));
    const calls: string[] = [];
    const fetchSpy = (async (url: string) => { calls.push(String(url)); return new Response('{"data":[]}', { status: 200 }); }) as unknown as typeof fetch;
    const red = new Redactor({ home: dir, env: {}, keyEnvNames: () => [] });
    const send = makeSend({
      secrets: () => new Map([['sp', KEY]]), env: {}, redactor: red, consent: o.consent ?? (() => true), fetch: fetchSpy,
      ...(o.current ? { current: o.current as never } : {}),
      ...(o.listUrl ? { listUrl: () => o.listUrl } : {}),
    });
    return { send, calls, red, done: () => rm(dir) };
  };
  const refusal = (p: Promise<unknown>) => p.then(() => undefined, (e: Error) => e);

  it.each([['an async consent', true], ['a synchronous consent', false]])('the provider moves while %s is awaited: no request goes to either address', async (_n, isAsync) => {
    let now = installed(`${A}/v1`);
    const swap = () => { now = installed(`${B}/v1`); return true; };
    const x = rig2({ consent: isAsync ? async () => { await pause(20); return swap(); } : swap, current: () => now });
    const e = await refusal(x.send(manifest(), `${A}/v1/chat/completions`, { method: 'POST', body: '{}' }));
    expect(e).toBeInstanceOf(ProviderChanged);
    expect(e!.message).toBe('The address of Sp changed. The next reply asks again.');
    expect(x.calls).toEqual([]);
    x.done();
  });

  it('a current() that throws, or knows nothing, or returns another kind or another id, sends nothing', async () => {
    const cases: Array<[string, () => unknown]> = [
      ['throws', () => { throw new Error('registry broke'); }],
      ['nothing', () => undefined],
      ['another kind', () => installed(`${A}/v1`, { kind: 'protocol' })],
      ['another id', () => installed(`${A}/v1`, { id: 'other' })],
      ['not an object', () => 'sp'],
      ['an address that is not one', () => installed('not a web address')],
    ];
    for (const [name, current] of cases) {
      const x = rig2({ current });
      const e = await refusal(x.send(manifest(), `${A}/v1/chat/completions`, { method: 'POST', body: '{}' }));
      expect(e, name).toBeInstanceOf(ProviderChanged);
      expect(x.calls, name).toEqual([]);
      x.done();
    }
  });

  it('control: an installed provider at the same address sends', async () => {
    const x = rig2({ current: () => installed(`${A}/v1`) });
    await x.send(manifest(), `${A}/v1/chat/completions`, { method: 'POST', body: '{}' });
    expect(x.calls).toEqual([`${A}/v1/chat/completions`]);
    x.done();
  });
});

describe('the keyless exemption is the exact list request and nothing else (should-fix)', () => {
  const LIST = 'http://a.test/v1/models?limit=1000';
  const free = () => ({
    reins: 1, id: 'sp', kind: 'provider', version: '1', label: 'Sp', protocol: 'openai-chat', baseUrl: 'http://a.test/v1',
    auth: { style: 'none', keyEnv: [] }, defaultModel: 'm', models: [{ id: 'm' }],
  }) as unknown as ProviderManifest;
  const go = async (url: string, init: RequestInit, purpose: 'models' | 'chat' = 'models') => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-list-'));
    const calls: string[] = [];
    const send = makeSend({
      secrets: () => new Map(), env: {}, redactor: new Redactor({ home: dir, env: {}, keyEnvNames: () => [] }), consent: () => false,
      listUrl: () => LIST, fetch: (async (u: string) => { calls.push(String(u)); return new Response('{"data":[]}'); }) as unknown as typeof fetch,
    });
    const e = await send(free(), url, init, purpose).then(() => undefined, (x: Error) => x);
    rm(dir);
    return { e, calls };
  };

  it('the exact list address, GET, no body: sent with no consent', async () => {
    const r = await go(LIST, { method: 'GET' });
    expect(r.e).toBeUndefined();
    expect(r.calls).toEqual([LIST]);
  });

  it.each([
    ['an unrelated path on the same origin', 'http://a.test/v1/chat/completions', { method: 'GET' }, 'models'],
    ['the list path with another query', 'http://a.test/v1/models?limit=5', { method: 'GET' }, 'models'],
    ['the list path with no query', 'http://a.test/v1/models', { method: 'GET' }, 'models'],
    ['a POST to the list address', LIST, { method: 'POST' }, 'models'],
    ['a GET that carries a body', LIST, { method: 'GET', body: 'prompt text' }, 'models'],
    ['the list address asked as a chat', LIST, { method: 'GET' }, 'chat'],
  ] as const)('%s needs consent and sends nothing', async (_n, url, init, purpose) => {
    const r = await go(url, init as RequestInit, purpose);
    expect(r.e).toBeInstanceOf(ConsentNeeded);
    expect(r.calls).toEqual([]);
  });
});

describe('a key in use is protected, never evicted (B2)', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reins-prot-'));
  const red = (dir: string, env: NodeJS.ProcessEnv = {}, names: string[] = []) => new Redactor({ home: dir, env, keyEnvNames: () => names });

  it.each([1000, 5000])('a learned key survives %i junk values learned after it', (n) => {
    const dir = tmp();
    try {
      const r = red(dir);
      expect(r.learn(KEY, 'Real')).toBe(true);
      for (let i = 0; i < n; i++) expect(r.learn(`junk-value-${String(i).padStart(6, '0')}`, 'Junk')).toBe(true);
      expect(r.redact(`x ${KEY} y`)).toBe('x [key Real] y');
    } finally {
      rm(dir);
    }
  });

  it('the key in the file survives a refresh that adds 1,000 env values after it', () => {
    const dir = tmp();
    try {
      setKey(dir, 'p', KEY);
      const env: NodeJS.ProcessEnv = {};
      const names = Array.from({ length: 1000 }, (_, i) => `E${i}_API_KEY`);
      names.forEach((n, i) => { env[n] = `env-secret-value-${String(i).padStart(5, '0')}`; });
      const r = red(dir, env, names);
      r.refresh();
      expect(r.redact(KEY)).toBe('[key Reins]');
      expect(r.redact('env-secret-value-00000')).toBe('[key E0_API_KEY]');
      expect(r.redact('env-secret-value-00999')).toBe('[key E999_API_KEY]');
    } finally {
      rm(dir);
    }
  });

  it('a key that a send holds survives its deletion and 1,100 rotations; once released it is retired, still hidden', () => {
    const dir = tmp();
    try {
      const env: NodeJS.ProcessEnv = { ROT_API_KEY: KEY };
      const r = red(dir, env, ['ROT_API_KEY']);
      const release = r.hold(KEY, 'ROT_API_KEY')!;
      delete env.ROT_API_KEY;
      r.refresh();
      for (let i = 0; i < 1100; i++) { env.ROT_API_KEY = `rotation-key-${String(i).padStart(5, '0')}`; r.refresh(); }
      expect(r.redact(KEY)).toBe('[key ROT_API_KEY]');
      release();
      expect(r.redact(KEY)).toBe('[key ROT_API_KEY]'); // newest retired
      release(); // twice does nothing
      expect(r.redact(KEY)).toBe('[key ROT_API_KEY]');
    } finally {
      rm(dir);
    }
  });

  it('a key that nothing holds is let go after 1,000 newer retired ones (the control of the test above)', () => {
    const dir = tmp();
    try {
      const env: NodeJS.ProcessEnv = { ROT_API_KEY: KEY };
      const r = red(dir, env, ['ROT_API_KEY']);
      for (let i = 0; i < 1100; i++) { env.ROT_API_KEY = `rotation-key-${String(i).padStart(5, '0')}`; r.refresh(); }
      expect(r.redact(KEY)).toBe(KEY);
    } finally {
      rm(dir);
    }
  });

  it('past 10,000 protected values, learn and hold refuse in plain terms instead of evicting', () => {
    const dir = tmp();
    try {
      const r = red(dir);
      r.learn(KEY, 'Real');
      for (let i = 1; i < MAX_CURRENT; i++) r.learn(`junk-value-${String(i).padStart(6, '0')}`, 'J');
      expect(r.learn('one-more-junk-value', 'J')).toBe(false);
      expect(r.hold('another-key-to-hold', 'J')).toBeUndefined();
      expect(r.redact(KEY)).toBe('[key Real]');
      expect(r.has('one-more-junk-value')).toBe(false);
    } finally {
      rm(dir);
    }
  });

  it('the sender holds the key until the answer is over: error, refusal and a good reply read to its end', async () => {
    const dir = tmp();
    try {
      const events: string[] = [];
      const stub = {
        ...red(dir), redact: (t: string) => t, has: () => false, safeLength: (t: string) => t.length,
        hold: (_v: string, _n: string) => { events.push('hold'); return () => events.push('release'); },
      };
      const make = (f: typeof fetch) => makeSend({ secrets: () => new Map([['sp', KEY]]), env: {}, redactor: stub, consent: () => true, fetch: f });
      const m = { reins: 1, id: 'sp', kind: 'provider', version: '1', label: 'Sp', protocol: 'openai-chat', baseUrl: 'http://a.test/v1', auth: { style: 'bearer', keyEnv: ['SP_KEY'] }, defaultModel: 'm', models: [{ id: 'm' }] } as unknown as ProviderManifest;
      await make((async () => new Response('bad', { status: 500 })) as unknown as typeof fetch)(m, 'http://a.test/v1/x', {}).catch(() => {});
      expect(events).toEqual(['hold', 'release']);
      events.length = 0;
      await make((async () => { throw new Error('down'); }) as unknown as typeof fetch)(m, 'http://a.test/v1/x', {}).catch(() => {});
      expect(events).toEqual(['hold', 'release']);
      events.length = 0;
      const res = await make((async () => new Response('data: hi\n\n', { status: 200 })) as unknown as typeof fetch)(m, 'http://a.test/v1/x', {});
      expect(events).toEqual(['hold']); // the body is not read yet: still held
      expect(await res.text()).toBe('data: hi\n\n');
      expect(events).toEqual(['hold', 'release']);
      events.length = 0;
      const res2 = await make((async () => new Response('more text', { status: 200 })) as unknown as typeof fetch)(m, 'http://a.test/v1/x', {});
      await res2.body!.cancel();
      expect(events).toEqual(['hold', 'release']); // a cancelled reply lets go too
    } finally {
      rm(dir);
    }
  });

  it('a send is refused, nothing sent, when the redactor has no room to protect its key', async () => {
    const dir = tmp();
    try {
      let sent = 0;
      const stub = { ...red(dir), hold: () => undefined };
      const send = makeSend({ secrets: () => new Map([['sp', KEY]]), env: {}, redactor: stub, consent: () => true, fetch: (async () => { sent++; return new Response('{}'); }) as unknown as typeof fetch });
      const m = { reins: 1, id: 'sp', kind: 'provider', version: '1', label: 'Sp', protocol: 'openai-chat', baseUrl: 'http://a.test/v1', auth: { style: 'bearer', keyEnv: ['SP_KEY'] }, defaultModel: 'm', models: [{ id: 'm' }] } as unknown as ProviderManifest;
      const e = await send(m, 'http://a.test/v1/x', {}).then(() => undefined, (x: Error) => x);
      expect(e?.message).toBe('Too many keys are in use to keep them all hidden, so nothing was sent.');
      expect(sent).toBe(0);
    } finally {
      rm(dir);
    }
  });
});

describe('the stream holdback is bounded (should-fix)', () => {
  const setup = (key: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-stream-'));
    setKey(dir, 'p', key);
    return { dir, r: new Redactor({ home: dir, env: {}, keyEnvNames: () => [] }) };
  };

  it('128 characters of repeated key text, then the end: no key text comes out', () => {
    const { dir, r } = setup('aaaaaaaa');
    try {
      const sr = new StreamRedactor(r);
      const out = sr.push('a'.repeat(128)) + sr.end();
      expect(out).not.toContain('aaaaaaaa');
      expect(out).toContain('[key Reins]');
    } finally {
      rm(dir);
    }
  });

  it('100,000 characters in chunks: the hold never passes 64 KiB, the held text becomes the marker, no key text is out', () => {
    const { dir, r } = setup('aaaaaaaa');
    try {
      const sr = new StreamRedactor(r);
      let out = '';
      for (let i = 0; i < 100; i++) {
        out += sr.push('a'.repeat(1000));
        expect((sr as unknown as { pending: string }).pending.length).toBeLessThanOrEqual(MAX_HOLDBACK);
      }
      out += sr.end();
      expect(MAX_HOLDBACK).toBe(65536);
      expect(out).not.toContain('aaaaaaaa');
      expect(out).toContain(HELD_MARKER);
      expect(HELD_MARKER).toBe('[hidden: text that looked like a key]');
    } finally {
      rm(dir);
    }
  });
});

describe('Test connection counts only valid model ids (should-fix)', () => {
  const wires2 = (a: Fake) => [
    prov('ms', { label: 'Msgs', protocol: 'anthropic-messages', baseUrl: a.url, auth: { style: 'header', keyEnv: ['MS_API_KEY'] } }),
  ];
  it.each([['kp'], ['ms']])('%s: [null, 42, {}] is not a model list; a mix counts the valid ids only', async (id) => {
    const w = await boot({ extra: (a) => wires2(a) });
    await w.call('PUT', '/api/mods/ms/key', { body: { key: KEY_MS } });
    await grant(w, id);
    const test = async () => (await w.call('POST', `/api/mods/${id}/test`)).json as { result: string; message: string };
    w.a.list.data = [null, 42, {}];
    expect(await test()).toMatchObject({ result: 'not-found', message: `Reached ${hostOf(w.a)}, but it answered with something that is not a model list, so the first reply will tell.` });
    w.a.list.data = [null, { id: 'one' }, 42, 'two', {}, { id: 'one' }, { id: 7 }];
    expect(await test()).toMatchObject({ result: 'ok', message: `Reached ${hostOf(w.a)}: 2 models.` });
    w.a.list.data = [];
    expect(await test()).toMatchObject({ result: 'ok', message: `Reached ${hostOf(w.a)}: 0 models.` });
  });
});

describe('the custom endpoint\'s key has the key route\'s maximum (should-fix)', () => {
  it('4,096 characters are accepted, 4,097 refused, nothing written when refused', async () => {
    const w = await boot();
    const body = (id: string, key: string) => ({ id, label: id, protocol: 'openai-chat', baseUrl: `${w.a.url}/v1`, auth: { style: 'bearer', keyEnv: 'NP_API_KEY' }, defaultModel: 'm', key });
    const over = await w.call('POST', '/api/mods/custom', { body: body('np1', 'k'.repeat(4097)) });
    expect(over.status).toBe(400);
    expect(fs.existsSync(path.join(w.dir, 'mods', 'np1'))).toBe(false);
    expect(readSecrets(w.dir).has('np1')).toBe(false);
    const ok = await w.call('POST', '/api/mods/custom', { body: body('np2', 'k'.repeat(4096)) });
    expect(ok.status, ok.text).toBe(200);
    expect(readSecrets(w.dir).get('np2')).toBe('k'.repeat(4096));
  });
});

// ---- 7. S16

describe('the loop harness pre-grants consent (S16)', () => {
  it('a loop test in the Task 10 style asks no question and replies, with the unedited harness', async () => {
    const r = await rig('openai-chat');
    try {
      r.push({ text: 'ok' });
      const s = await r.open();
      expect((await s.turn('hi')).text).toBe('ok');
      expect(r.fake.requests).toHaveLength(1);
    } finally {
      await r.cleanup();
    }
  });
});
