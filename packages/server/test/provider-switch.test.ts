// Milestone P, Task 19 (spec 7.2, 9.1, 9.3, 9.4, 8.2): switches between providers, the missing-provider state, the live model lists.
// Real mods on the bundled wire, fake provider servers, a temp Reins folder, a real server over HTTP.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanIds, createLiveModels, MAX_LIVE_ID, MAX_LIVE_IDS } from '../src/live-models.js';
import { makeEngineFrom, startMods } from '../src/engines.js';
import type { Mods, SendWithKey } from '../src/mods/types.js';
import { Redactor, readSecrets, setKey } from '../src/secrets.js';
import { makeSend } from '../src/send.js';
import { startServer, type ProviderGroup, type Server, type SessionProviderState } from '../src/server.js';
import type { Consent, MakeEngine } from '../src/session.js';
import { openStore, type Store } from '../src/store.js';
import { startFakeProvider } from './fake-provider.js';
import { until } from './helpers.js';
import { PROBE, openQuestions, request } from './http-helpers.js';

const KEY = 'sk-test-0123456789abcdef';
const PRICE = { input: 1, output: 2 };
type Fake = Awaited<ReturnType<typeof startFakeProvider>>;
type StateSession = { id: string; engine: string; model?: string; status: string } & SessionProviderState;

function writeMod(dir: string, id: string, manifest: Record<string, unknown>) {
  const folder = path.join(dir, 'mods', id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'mod.json'), JSON.stringify({ reins: 1, id, kind: 'provider', version: '1.0.0', protocol: 'openai-chat', ...manifest }, null, 2));
}
const bearer = (name: string) => ({ style: 'bearer', keyEnv: [name] });
const NONE = { style: 'none', keyEnv: [] };

/** A temp Reins folder with `mods/`, a project folder, and every fake provider closed at the end. */
function folder(prefix: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const dir = path.join(root, '.reins');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  return { root, dir, proj };
}
const chat = (f: Fake) => f.requests.filter((r) => r.path.endsWith('/chat/completions'));

const api = (srv: Server) => ({
  get: (url: string) => request(srv, 'GET', url),
  post: (url: string, body?: unknown) => request(srv, 'POST', url, body === undefined ? {} : { body }),
});

// ---- switches, the missing provider, typed ids

interface World {
  root: string; dir: string; proj: string; mods: Mods; p: Fake; q: Fake; store: Store; srv: Server;
  made: string[]; sends: Array<{ id: string; url: string; purpose: string | undefined }>;
}
let w: World;

beforeAll(async () => {
  const { root, dir, proj } = folder('reins-switch-');
  const p = await startFakeProvider();
  const q = await startFakeProvider();
  writeMod(dir, 'p', {
    label: 'Fake P', baseUrl: `${p.url}/v1`, auth: bearer('P_API_KEY'), defaultModel: 'm', defaultEffort: 'low',
    efforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }],
    models: [{ id: 'm', price: PRICE }, { id: 'm2', price: PRICE }],
  });
  writeMod(dir, 'other', { label: 'Other', baseUrl: `${q.url}/v1`, auth: bearer('OTHER_API_KEY'), defaultModel: 'om', models: [{ id: 'om', price: PRICE }] });
  writeMod(dir, 'nokey', { label: 'No Key', baseUrl: `${p.url}/v1`, auth: bearer('NOKEY_API_KEY'), defaultModel: 'km', models: [{ id: 'km', price: PRICE }] });
  setKey(dir, 'p', KEY);
  setKey(dir, 'other', KEY);
  const env: NodeJS.ProcessEnv = { ...process.env, REINS_HOME: root };
  for (const name of ['P_API_KEY', 'OTHER_API_KEY', 'NOKEY_API_KEY']) delete env[name];
  const mods = await startMods({ dir, env });
  expect(mods.mods.flatMap((m) => m.problems)).toEqual([]);
  const redactor = new Redactor({ home: dir, env: {}, keyEnvNames: () => ['P_API_KEY', 'OTHER_API_KEY'] });
  const real = makeSend({ secrets: () => readSecrets(dir), env: {}, redactor, consent: () => true });
  const sends: World['sends'] = [];
  const send: SendWithKey = (m, url, init, purpose) => {
    sends.push({ id: m.id, url, purpose });
    return real(m, url, init, purpose);
  };
  // The factory is spied: a refused switch must never get as far as opening an engine.
  const made: string[] = [];
  const build = makeEngineFrom(mods, { env: {}, home: dir, send });
  const makeEngine: MakeEngine = (a) => { made.push(a.provider); return build(a); };
  const store = openStore(':memory:');
  // Rows from before the server starts: a provider that is not installed, and the retired id.
  store.createSession({ id: 'gone1', cwd: proj, engine: 'zz', model: 'zm' });
  store.appendLog('gone1', { type: 'message', data: { role: 'user', text: 'an earlier question' } });
  store.createSession({ id: 'old1', cwd: proj, engine: 'claude', model: 'old' });
  store.appendLog('old1', { type: 'message', data: { role: 'user', text: 'an older question' } });
  // The user's yes (spec 7.8, Task 21) for the providers that answer in this file; their live lists are empty, so no extra ids show.
  for (const [id, fake] of [['p', p], ['other', q], ['nokey', p]] as const) store.grantConsent(id, new URL(fake.url).origin);
  p.list.data = [];
  q.list.data = [];
  const srv = await startServer({ store, dir, mods, env: {}, send, probe: async () => PROBE, makeEngine });
  w = { root, dir, proj, mods, p, q, store, srv, made, sends };
});

afterAll(async () => {
  await w.srv.close();
  w.store.close();
  w.mods.dispose();
  await w.p.close();
  await w.q.close();
  fs.rmSync(w.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const A = () => api(w.srv);
const create = async (engine: string) => {
  const r = await A().post('/api/sessions', { cwd: w.proj, engine });
  expect(r.status, r.text).toBe(200);
  return r.json.id as string;
};
const turns = (id: string) => w.store.readLog(id).filter((r) => r.type === 'turn_ended');
const say = async (id: string, text: string) => {
  const before = turns(id).length;
  const r = await A().post(`/api/sessions/${id}/message`, { text });
  expect(r.status, r.text).toBe(200);
  await until(() => turns(id).length === before + 1);
};
const settings = (id: string, body: unknown) => A().post(`/api/sessions/${id}/settings`, body);
const state = async () => (await A().get('/api/state')).json as { sessions: StateSession[]; groups: ProviderGroup[]; providers: Array<{ id: string; models: unknown[] }> };
const labelOf = async (id: string) => (await state()).groups.find((g) => g.id === id)!.label;
const row = (id: string) => w.store.getSession(id)!;

/** Answers every trust question of a run until it ends (or `until` gives up). */
async function finish(id: string) {
  await until(() => {
    for (const q of openQuestions(w.store.readLog(id))) if (q.kind === 'trust') void A().post(`/api/sessions/${id}/answer`, { questionId: q.id, answer: 'y' });
    return w.store.readLog(id).some((r) => r.type === 'run_finished' || r.type === 'run_stopped' || r.type === 'run_detached');
  }, 20_000);
}
let n = 0;
const putWorkflow = (body: string) => {
  const file = path.join(w.proj, `w${++n}.reins.md`);
  fs.writeFileSync(file, `---\nreins: 1\nname: w\nbudget: { turns: 20, minutes: 20 }\nalways: []\n---\n\n${body}`);
  return file;
};

describe('a switch between two loop providers keeps the conversation (spec 9.3)', () => {
  it('moves the row, keeps the history and the per-model totals, and the next turn is charged right', async () => {
    const id = await create('p');
    w.p.push({ text: 'one' });
    await say(id, 'first question');
    const first = turns(id)[0]!.data as { cost: number };
    expect(first.cost).toBeCloseTo(2e-5, 9);

    const r = await settings(id, { model: 'other:om' });
    expect(r.status, r.text).toBe(200);
    expect([row(id).engine, row(id).model]).toEqual(['other', 'om']);
    expect(w.store.readLog(id).filter((x) => x.type === 'settings').map((x) => x.data)).toEqual([{ model: 'om', engine: 'other', effort: '' }]);

    w.q.push({ text: 'two' });
    await say(id, 'second question');
    const sent = JSON.stringify(chat(w.q).at(-1)!.body);
    expect(sent).toContain('first question');
    expect(sent).toContain('one');
    expect(chat(w.q).at(-1)!.body.model).toBe('om');

    // The second turn costs one call, not the first turn's call again.
    expect((turns(id)[1]!.data as { cost: number }).cost).toBeCloseTo(2e-5, 9);
    const sid = row(id).engineSessionId!;
    const byModel = w.store.getEngineModels(sid)!;
    expect(Object.keys(byModel).sort()).toEqual(['m', 'om']);
    expect(byModel.m).toBeCloseTo(2e-5, 9);
    expect(byModel.om).toBeCloseTo(2e-5, 9);
    expect(w.store.getEngineTotal(sid)).toBeCloseTo(4e-5, 9);
  });

  it('a reasoning level the new provider does not list is dropped from the row', async () => {
    const id = await create('p');
    expect(row(id).effort).toBe('low');
    expect((await settings(id, { model: 'other:om' })).status).toBe(200);
    expect(row(id)).not.toHaveProperty('effort');
  });

  it('a switch while a turn runs is refused like a model switch on one provider', async () => {
    const id = await create('p');
    w.p.push({ text: 'slow', hangMs: 1500 });
    expect((await A().post(`/api/sessions/${id}/message`, { text: 'go' })).status).toBe(200);
    await until(() => w.p.requests.some((x) => x.path.endsWith('/chat/completions') && JSON.stringify(x.body).includes('"go"')));
    const same = await settings(id, { model: 'm2' });
    const other = await settings(id, { model: 'other:om' });
    expect(same.status).toBe(409);
    expect([other.status, other.json.error]).toEqual([same.status, same.json.error]);
    expect([row(id).engine, row(id).model]).toEqual(['p', 'm']);
    await until(() => turns(id).length === 1);
  });

  it('a model of the same name on another provider is still a switch', async () => {
    const id = await create('p');
    expect((await settings(id, { model: 'other:m' })).status).toBe(200);
    expect([row(id).engine, row(id).model]).toEqual(['other', 'm']);
  });
});

describe('a switch across the two kinds of conversation is refused before anything opens (spec 9.3)', () => {
  const words = (from: string, to: string) => `${from} keeps its own conversation, so Reins cannot move it to ${to}. Start a new session for ${to}.`;

  it('the CLI to a loop provider', async () => {
    const id = await create('claude-code');
    const before = { ...row(id) };
    w.made.length = 0;
    const r = await settings(id, { model: 'p:m' });
    expect([r.status, r.json.error]).toEqual([409, words(await labelOf('claude-code'), 'Fake P')]);
    expect(row(id)).toEqual(before);
    expect(w.made).toEqual([]);
    expect(w.store.readLog(id).some((x) => x.type === 'settings')).toBe(false);
  });

  it('a loop provider to the CLI', async () => {
    const id = await create('p');
    const before = { ...row(id) };
    w.made.length = 0;
    const r = await settings(id, { model: 'claude-code:claude-sonnet-5-5' });
    expect([r.status, r.json.error]).toEqual([409, words('Fake P', await labelOf('claude-code'))]);
    expect(row(id)).toEqual(before);
    expect(w.made).toEqual([]);
  });

  it('a mid-run model block that crosses the kinds keeps the model (the run-start check refuses it first)', async () => {
    const id = await create('p');
    const refused = await A().post(`/api/sessions/${id}/run`, { path: putWorkflow('## model claude-code:claude-sonnet-5-5\n\n## phase go\n> Go.\n') });
    expect([refused.status, refused.json.error]).toEqual([400, words('Fake P', await labelOf('claude-code'))]);
    expect(row(id).engine).toBe('p');
  });

  it('the state says where each session may switch', async () => {
    const cli = await create('claude-code');
    const loop = await create('p');
    const s = await state();
    const sw = (id: string) => s.sessions.find((x) => x.id === id)!.switchTo;
    expect(sw(cli).find((x) => x.provider === 'p')).toEqual({ provider: 'p', allowed: false, why: words(s.groups.find((g) => g.id === 'claude-code')!.label, 'Fake P') });
    expect(sw(cli).find((x) => x.provider === 'claude-code')).toEqual({ provider: 'claude-code', allowed: true });
    expect(sw(loop).find((x) => x.provider === 'other')).toEqual({ provider: 'other', allowed: true });
    expect(sw(loop).find((x) => x.provider === 'claude-code')!.allowed).toBe(false);
    expect(sw(loop).find((x) => x.provider === 'nokey')!.why).toBe('No Key has no key. Set NOKEY_API_KEY, or add a key in Settings > Providers.');
  });
});

describe('a provider that is not installed or has no key is refused and nothing changes', () => {
  it('no key: 409 with the words', async () => {
    const id = await create('p');
    const before = { ...row(id) };
    const r = await settings(id, { model: 'nokey:km' });
    expect([r.status, r.json.error]).toEqual([409, 'No Key has no key. Set NOKEY_API_KEY, or add a key in Settings > Providers.']);
    expect(row(id)).toEqual(before);
  });

  it('not installed: 400 with the 9.2 words', async () => {
    const id = await create('p');
    const before = { ...row(id) };
    const r = await settings(id, { model: 'zzz:x' });
    expect([r.status, r.json.error]).toEqual([400, 'Unknown model zzz:x: no provider `zzz` is installed. To name a model on another provider, write <provider>:<model>, for example p:zzz:x.']);
    expect(row(id)).toEqual(before);
  });
});

describe('a mid-run model block that names another loop provider moves the session', () => {
  it('the steps after it run on the other provider', async () => {
    const id = await create('p');
    w.p.requests.length = 0;
    w.q.requests.length = 0;
    w.q.push({ text: 'REINS: done' });
    const r = await A().post(`/api/sessions/${id}/run`, { path: putWorkflow('## model other:om\n\n## phase go\n> Go.\n') });
    expect(r.status, r.text).toBe(200);
    await finish(id);
    expect([row(id).engine, row(id).model]).toEqual(['other', 'om']);
    expect(chat(w.q)).toHaveLength(1);
    expect(chat(w.q)[0]!.body.model).toBe('om');
    expect(chat(w.p)).toHaveLength(0);
  });

  it('the first reply failing puts the provider, model and reasoning back (undoSwitch)', async () => {
    const id = await create('p');
    w.q.requests.length = 0;
    w.q.push({ status: 400, body: JSON.stringify({ error: { message: 'bad request' } }) });
    expect((await settings(id, { model: 'other:om' })).status).toBe(200);
    expect(row(id).engine).toBe('other');
    const r = await A().post(`/api/sessions/${id}/message`, { text: 'hello' });
    expect(r.status).toBe(200);
    await until(() => w.store.readLog(id).some((x) => x.type === 'note' && JSON.stringify(x.data).includes('did not answer')));
    expect([row(id).engine, row(id).model, row(id).effort]).toEqual(['p', 'm', 'low']);
    expect(JSON.stringify(w.store.readLog(id))).toContain('The model is back to p:m.');
  });
  it('the first reply failing after a switch to a model of the same name on another provider puts the provider back', async () => {
    const id = await create('p');
    w.q.requests.length = 0;
    w.q.push({ status: 400, body: JSON.stringify({ error: { message: 'bad request' } }) });
    expect((await settings(id, { model: 'other:m' })).status).toBe(200);
    expect([row(id).engine, row(id).model]).toEqual(['other', 'm']);
    const r = await A().post(`/api/sessions/${id}/message`, { text: 'hello' });
    expect(r.status).toBe(200);
    await until(() => w.store.readLog(id).some((x) => x.type === 'note' && JSON.stringify(x.data).includes('did not answer')));
    expect([row(id).engine, row(id).model]).toEqual(['p', 'm']);
  });
});

describe('a provider that is not installed (spec 9.4)', () => {
  it('a reply is refused with 409 and the words; the log still reads', async () => {
    const r = await A().post('/api/sessions/gone1/message', { text: 'hello' });
    expect([r.status, r.json.error]).toEqual([409, 'This session uses zz, which is not installed. Install it in Settings > Providers, or start a new session.']);
    const log = await A().get('/api/sessions/gone1/log');
    expect(log.status).toBe(200);
    expect(JSON.stringify(log.json.rows)).toContain('an earlier question');
    expect(w.store.readLog('gone1').some((x) => x.type === 'message' && JSON.stringify(x.data).includes('hello'))).toBe(false);
  });

  it('an old row with the retired id gets the "no longer exists" words', async () => {
    const r = await A().post('/api/sessions/old1/message', { text: 'hello' });
    expect([r.status, r.json.error]).toEqual([409, 'This session uses claude, which no longer exists. Start a new session.']);
    expect(JSON.stringify((await A().get('/api/sessions/old1/log')).json.rows)).toContain('an older question');
  });

  it('a card, compress and resume are refused the same way, and the header does not switch it', async () => {
    for (const [route, body] of [['card', { kind: 'steer', text: 'x' }], ['compress', {}], ['resume', { runId: 'r' }]] as const) {
      const r = await A().post(`/api/sessions/gone1/${route}`, body);
      expect([route, r.status, r.json.error]).toEqual([route, 409, 'This session uses zz, which is not installed. Install it in Settings > Providers, or start a new session.']);
    }
    const s = await settings('gone1', { model: 'p:m' });
    expect([s.status, s.json.error]).toEqual([409, 'This session uses zz, which is not installed. Install it in Settings > Providers, or start a new session.']);
    expect(row('gone1').engine).toBe('zz');
  });

  it('/api/state marks the session ok, missing or gone, and groups the models by provider with a status', async () => {
    const ok = await create('p');
    const s = await state();
    const of = (id: string) => s.sessions.find((x) => x.id === id)!;
    expect(of(ok).provider).toEqual({ status: 'ok' });
    expect(of('gone1').provider).toEqual({ status: 'missing', words: 'This session uses zz, which is not installed. Install it in Settings > Providers, or start a new session.' });
    expect(of('old1').provider).toEqual({ status: 'gone', words: 'This session uses claude, which no longer exists. Start a new session.' });
    expect(of(ok).composite).toBe('p:m');
    expect(of('gone1').composite).toBe('zz:zm');
    expect(of('gone1').switchTo.every((x) => !x.allowed)).toBe(true);
    const status = Object.fromEntries(s.groups.map((g) => [g.id, g.status]));
    expect(status.p).toBe('installed');
    expect(status.nokey).toBe('needs-key');
    expect(s.groups.find((g) => g.id === 'p')!.models.map((m) => m.id)).toEqual(['m', 'm2']);
    // The providers list keeps its old shape.
    expect(s.providers.find((x) => x.id === 'p')).not.toHaveProperty('status');
  });
});

describe('a typed model id (spec 9.1)', () => {
  it('written with its provider, an id that no list has is accepted and sent as typed', async () => {
    const id = await create('p');
    expect((await settings(id, { model: 'p:typed-x' })).status).toBe(200);
    expect(row(id).model).toBe('typed-x');
    expect((await state()).sessions.find((x) => x.id === id)!.composite).toBe('p:typed-x');
    w.p.push({ text: 'ok' });
    await say(id, 'hi');
    expect(chat(w.p).at(-1)!.body.model).toBe('typed-x');
  });

  it('a colon inside the model stays in the model (split at the first colon)', async () => {
    const id = await create('p');
    expect((await settings(id, { model: 'p:qwen3:30b' })).status).toBe(200);
    expect([row(id).engine, row(id).model]).toEqual(['p', 'qwen3:30b']);
    expect((await settings(id, { model: 'other:org/x:Q4' })).status).toBe(200);
    expect([row(id).engine, row(id).model]).toEqual(['other', 'org/x:Q4']);
  });

  it('a bare name that no list has is still refused', async () => {
    const id = await create('p');
    const r = await settings(id, { model: 'nope' });
    expect([r.status, r.json.error]).toEqual([400, "Unknown model for this session's provider."]);
  });
});

// ---- the live model lists

describe('cleanIds', () => {
  it('keeps strings of 1 to 200 characters without control characters or a secret, once each, at most 2000', () => {
    const ids = cleanIds(['a', 'a', '', 5, null, { id: 'x' }, 'b'.repeat(MAX_LIVE_ID), 'c'.repeat(MAX_LIVE_ID + 1), 'tab\there', 'sk-secret', 'd'], (t) => t.includes('sk-secret'));
    expect(ids).toEqual(['a', 'b'.repeat(MAX_LIVE_ID), 'd']);
    expect(cleanIds(Array.from({ length: MAX_LIVE_IDS + 500 }, (_, i) => `m${i}`))).toHaveLength(MAX_LIVE_IDS);
    expect(cleanIds('not a list')).toEqual([]);
  });
});

describe('the live model list (spec 7.2)', () => {
  let r: { root: string; dir: string; mods: Mods; store: Store; srv: Server; z: Fake; kl: Fake; kf: Fake; km: Fake; kb: Fake; ks: Fake; granted: Set<string>; asked: string[]; sends: World['sends'] };

  beforeAll(async () => {
    const { root, dir } = folder('reins-live-');
    const [z, kl, kf, km, kb, ks] = await Promise.all([1, 2, 3, 4, 5, 6].map(() => startFakeProvider()));
    writeMod(dir, 'kz', { label: 'Keyed', baseUrl: `${z!.url}/v1`, auth: bearer('KZ_API_KEY'), defaultModel: 'zm', models: [{ id: 'zm' }] });
    for (const [id, f] of [['kl', kl], ['kf', kf], ['km', km], ['kb', kb], ['ks', ks]] as const) {
      writeMod(dir, id, { label: id, baseUrl: `${f!.url}/v1`, auth: NONE, price: { input: 0, output: 0 }, defaultModel: `${id}-m`, models: [{ id: `${id}-m` }] });
    }
    setKey(dir, 'kz', KEY);
    const env: NodeJS.ProcessEnv = { ...process.env, REINS_HOME: root };
    delete env.KZ_API_KEY;
    const mods = await startMods({ dir, env });
    // M3 Task 3: the file's first world (the top-level beforeAll) is still loaded and holds the default pack's kinds, so this second load cannot register them again: the pack's own rows are left out.
    expect(mods.mods.filter((m) => !m.pack).flatMap((m) => m.problems)).toEqual([]);
    // The list answers: the curated id again (deduped), a key (dropped), new ids.
    z!.list.data = [{ id: 'zm' }, { id: KEY }, { id: 'zlive-b' }, { id: 'zlive-a' }];
    kl!.list.data = [{ id: 'kl-m' }, { id: 'kl-live-2' }, { id: 'kl-live-1' }];
    kf!.list.status = 500;
    km!.list.data = [{ id: 'ok-1' }, 5, null, {}, { id: 7 }, 'bare-ok', { id: 'x'.repeat(201) }, { id: 'ok-1' }, [], 'tab\there'];
    kb!.list.data = Array.from({ length: 2500 }, (_, i) => ({ id: `big-${String(i).padStart(4, '0')}` }));
    ks!.list.hangMs = 30_000;
    const redactor = new Redactor({ home: dir, env: {}, keyEnvNames: () => ['KZ_API_KEY'] });
    const real = makeSend({ secrets: () => readSecrets(dir), env: {}, redactor, consent: () => true });
    const sends: World['sends'] = [];
    const send: SendWithKey = (m, url, init, purpose) => {
      sends.push({ id: m.id, url, purpose });
      return real(m, url, init, purpose);
    };
    const granted = new Set<string>();
    const asked: string[] = [];
    const consent = (provider: string): Consent | undefined => {
      if (granted.has(provider)) return undefined;
      asked.push(provider);
      return { prompt: 'p', detail: 'd', refused: 'no', stopped: 'stopped', grant: () => { granted.add(provider); } };
    };
    const store = openStore(':memory:');
    store.putSetting('pickerLimit', 5000);
    const srv = await startServer({ store, dir, mods, env: {}, send, consent, probe: async () => PROBE, makeEngine: makeEngineFrom(mods, { env: {}, home: dir, send }) });
    r = { root, dir, mods, store, srv, z: z!, kl: kl!, kf: kf!, km: km!, kb: kb!, ks: ks!, granted, asked, sends };
  });

  afterAll(async () => {
    await r.srv.close();
    r.store.close();
    r.mods.dispose();
    for (const f of [r.z, r.kl, r.kf, r.km, r.kb, r.ks]) await f.close();
    fs.rmSync(r.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const get = async () => (await api(r.srv).get('/api/state')).json as { groups: ProviderGroup[] };
  const ids = async (provider: string) => (await get()).groups.find((g) => g.id === provider)!.models.map((m) => m.id);
  const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));
  /** Reads the state until the provider shows `count` models (the list arrives after the first read). */
  const waitIds = async (provider: string, count: number) => {
    for (let i = 0; i < 100 && (await ids(provider)).length < count; i++) await pause(40);
  };

  it('NO request for a keyed provider until consent is recorded, however often the state is read', async () => {
    for (let i = 0; i < 3; i++) {
      expect(await ids('kz')).toEqual(['zm']);
      await pause(60);
    }
    expect(r.z.listRequests()).toHaveLength(0);
    expect(r.z.requests).toHaveLength(0);
    expect(r.sends.filter((s) => s.id === 'kz')).toHaveLength(0);
  });

  it('a keyless provider fetches without consent; its ids come after the curated ones, once each, with no key header', async () => {
    await waitIds('kl', 3);
    expect(r.kl.listRequests()).toHaveLength(1);
    expect(await ids('kl')).toEqual(['kl-m', 'kl-live-1', 'kl-live-2']);
    expect(r.kl.listRequests()[0]!.headers.authorization).toBeUndefined();
    expect(r.granted.has('kl')).toBe(false);
  });

  it('once consent is recorded the keyed provider is asked once, with its key, only through send; the answer is cached', async () => {
    r.granted.add('kz');
    await waitIds('kz', 3);
    expect(await ids('kz')).toEqual(['zm', 'zlive-a', 'zlive-b']);
    for (let i = 0; i < 3; i++) await get();
    await pause(60);
    expect(r.z.listRequests()).toHaveLength(1);
    expect(r.z.listRequests()[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    const viaSend = r.sends.filter((s) => s.id === 'kz');
    expect(viaSend).toHaveLength(1);
    expect(viaSend[0]!.purpose).toBe('models');
    expect(new URL(viaSend[0]!.url).origin).toBe(new URL(r.z.url).origin);
    // The key that the list itself held is not an id, and not in the state at all.
    expect(JSON.stringify(await get())).not.toContain(KEY);
  });

  it('a failing list keeps the curated models, does not throw, and is not asked again at once', async () => {
    await until(() => r.kf.listRequests().length >= 1);
    for (let i = 0; i < 3; i++) {
      const res = await api(r.srv).get('/api/state');
      expect(res.status).toBe(200);
      expect(res.json.groups.find((g: ProviderGroup) => g.id === 'kf').models.map((m: { id: string }) => m.id)).toEqual(['kf-m']);
      await pause(60);
    }
    expect(r.kf.listRequests()).toHaveLength(1);
  });

  it('malformed entries are dropped', async () => {
    await waitIds('km', 3);
    expect(await ids('km')).toEqual(['km-m', 'bare-ok', 'ok-1']);
  });

  it('an oversized list is capped at 2000 ids', async () => {
    await waitIds('kb', 1 + MAX_LIVE_IDS);
    const list = await ids('kb');
    expect(list).toHaveLength(1 + MAX_LIVE_IDS);
    expect(list[0]).toBe('kb-m');
  });

  it('a slow list does not hold the state: the curated models come at once', async () => {
    const t = Date.now();
    expect(await ids('ks')).toEqual(['ks-m']);
    expect(Date.now() - t).toBeLessThan(2000);
    await until(() => r.ks.listRequests().length === 1);
  });

  it('a live id is a listed model for a switch, and a typed id on top of it is accepted', async () => {
    // A folder of its own: the temp folder itself holds the Reins folder of this test, and a session folder may not (p29a A10).
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-proj-'));
    const made = await api(r.srv).post('/api/sessions', { cwd: proj, engine: 'kl' });
    fs.rmSync(proj, { recursive: true, force: true });
    expect(made.status, made.text).toBe(200);
    const id = made.json.id as string;
    expect((await api(r.srv).post(`/api/sessions/${id}/settings`, { model: 'kl-live-2' })).status).toBe(200);
    expect(r.store.getSession(id)!.model).toBe('kl-live-2');
    expect((await api(r.srv).post(`/api/sessions/${id}/settings`, { model: 'kl:not-in-any-list' })).status).toBe(200);
    expect(r.store.getSession(id)!.model).toBe('not-in-any-list');
  });
});

describe('createLiveModels: a refresh that fails keeps the list it already had', () => {
  it('after the first list is cached, a later failure leaves it and is retried only after the failure window', async () => {
    let t = 0;
    let calls = 0;
    let fail = false;
    const live = createLiveModels({
      fetchIds: async () => { calls++; if (fail) throw new Error('down'); return ['a', 'b']; },
      keyless: () => true,
      consented: () => false,
      now: () => t,
    });
    await live.refresh('x');
    expect(live.ids('x')).toEqual(['a', 'b']);
    fail = true;
    t += 11 * 60_000;            // past the ten minute window
    await live.refresh('x');
    expect(calls).toBe(2);
    expect(live.ids('x')).toEqual(['a', 'b']);
    t += 30_000;                 // inside the one minute failure window: no new request
    await live.refresh('x');
    expect(calls).toBe(2);
  });
});
