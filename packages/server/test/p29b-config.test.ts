// Milestone P, Task 29 phase B5 (a same-origin settings change retires open engines), B7 (a manifest body cannot take over the request) and
// B8 (the live model cache follows the address and the manifest).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { liveListSource, makeEngineFrom, startMods } from '../src/engines.js';
import { createLiveModels } from '../src/live-models.js';
import { openSession, type MakeEngine } from '../src/session.js';
import { openStore } from '../src/store.js';
import { setKey } from '../src/secrets.js';
import type { Mods } from '../src/mods/types.js';
import { startFakeProvider } from './fake-provider.js';
import { testEngine } from './test-engine.js';
import { mergeBodies, RESERVED_BODY } from '../src/loop/wire-util.js';
import type { ProviderManifest } from '../src/mods/types.js';
import { rig, WIRES, type Rig } from './loop-harness.js';
import { tempHome } from './mods-harness.js';

const KEY = 'sk-test-0123456789abcdef';
type Fake = Awaited<ReturnType<typeof startFakeProvider>>;
let home: ReturnType<typeof tempHome>;
let fake: Fake;
let mods: Mods;

beforeEach(async () => {
  home = tempHome();
  fake = await startFakeProvider();
  setKey(home.home, 'kp', KEY);
});
afterEach(async () => {
  mods?.dispose();
  await fake.close();
  home.cleanup();
});

const PRICE = { input: 1000, output: 1000 };
const manifest = (over: Record<string, unknown> = {}) => ({
  reins: 1, id: 'kp', kind: 'provider', version: '1', label: 'Kp', protocol: 'openai-chat', baseUrl: `${fake.url}/v1`,
  auth: { style: 'bearer', keyEnv: ['KP_API_KEY'] }, defaultModel: 'm', models: [{ id: 'm', price: PRICE }], ...over,
});
const install = async (over: Record<string, unknown> = {}) => {
  home.writeMod('kp', manifest(over));
  mods = await startMods({ dir: home.home, env: {} });
};
/** The user edits the provider's mod.json on disk and Reins reloads (what a settings change does). */
const edit = async (over: Record<string, unknown>) => {
  home.writeMod('kp', manifest(over));
  expect(await mods.reload!()).toEqual([]);
};
const engine = () => makeEngineFrom(mods, { env: {}, home: home.home }, () => true)({ provider: 'kp', onApprove: async () => ({ behavior: 'allow' }), onLive: () => {} });
const rejection = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: Error) => e))?.message ?? '';
const CHANGED = 'The settings of Kp changed. The next reply starts a fresh connection.';
const chats = () => fake.requests.filter((r) => r.path.endsWith('/chat/completions'));

describe('B5: a same-origin change of the settings retires the open engines', () => {
  it.each<[string, Record<string, unknown>]>([
    ['the price of a model', { models: [{ id: 'm', price: { input: 2000, output: 2000 } }] }],
    ['the models address', { modelsUrl: '/v1/other-models' }],
    ['the auth header', { auth: { style: 'header', header: 'x-kp-key', keyEnv: ['KP_API_KEY'] } }],
    ['a header the request carries', { headers: { 'x-team': 'blue' } }],
    ['the body merged into every request', { body: { temperature: 0 } }],
    ['the models', { models: [{ id: 'm', price: PRICE }, { id: 'm2' }] }],
    ['the reasoning levels', { efforts: [{ id: 'low', label: 'Low' }] }],
  ])('%s: the next send is refused with plain words and nothing goes out', async (_what, change) => {
    if ('modelsUrl' in change) change = { modelsUrl: `${fake.url}${change.modelsUrl}` };
    await install();
    const s = await engine().open({ cwd: home.home, policy: () => ({}) as never });
    fake.push({ text: 'one' });
    expect((await s.turn('first')).text).toBe('one');
    const sent = fake.requests.length;
    await edit(change);
    expect(await rejection(s.turn('second'))).toBe(CHANGED);
    expect(fake.requests).toHaveLength(sent);
    await s.close();
  });

  it('the next engine uses the new manifest: the new price, and the new header carries the key', async () => {
    await install();
    const old = await engine().open({ cwd: home.home, policy: () => ({}) as never });
    fake.push({ text: 'one' }, { text: 'two' });
    const first = await old.turn('first');
    expect(first.cost).toBeCloseTo(0.015, 12); // 10 in, 5 out at 1000 USD per million
    await old.close();
    await edit({ models: [{ id: 'm', price: { input: 2000, output: 2000 } }], auth: { style: 'header', header: 'x-kp-key', keyEnv: ['KP_API_KEY'] } });
    const fresh = await engine().open({ cwd: home.home, policy: () => ({}) as never });
    const second = await fresh.turn('second');
    expect(second.cost).toBeCloseTo(0.03, 12);
    const last = chats().at(-1)!;
    expect(last.headers['x-kp-key']).toBe(KEY);
    expect(last.headers.authorization).toBeUndefined();
    await fresh.close();
  });

  it('a reload that changes nothing (the same file again, or the same settings in another key order) retires nothing', async () => {
    await install();
    const s = await engine().open({ cwd: home.home, policy: () => ({}) as never });
    fake.push({ text: 'one' }, { text: 'two' }, { text: 'three' });
    await s.turn('first');
    await edit({});
    expect((await s.turn('second')).text).toBe('two');
    const m = manifest();
    home.writeMod('kp', Object.fromEntries(Object.entries(m).reverse()));
    expect(await mods.reload!()).toEqual([]);
    expect((await s.turn('third')).text).toBe('three');
    await s.close();
  });

  it('consent stays bound to the origin: a changed price is not asked about again', async () => {
    await install();
    let asked = 0;
    const make = makeEngineFrom(mods, { env: {}, home: home.home }, () => { asked++; return true; });
    const s = await make({ provider: 'kp', onApprove: async () => ({ behavior: 'allow' }), onLive: () => {} }).open({ cwd: home.home, policy: () => ({}) as never });
    fake.push({ text: 'one' });
    await s.turn('first');
    await s.close();
    await edit({ models: [{ id: 'm', price: { input: 2000, output: 2000 } }] });
    const again = await make({ provider: 'kp', onApprove: async () => ({ behavior: 'allow' }), onLive: () => {} }).open({ cwd: home.home, policy: () => ({}) as never });
    fake.push({ text: 'two' });
    expect((await again.turn('second')).text).toBe('two');
    expect(asked).toBeGreaterThan(0);
    await again.close();
  });
});

describe('B5: the session retires its engine before the next use', () => {
  const sessionWith = (generation: () => string | undefined) => {
    const store = openStore(':memory:');
    const t = testEngine([{}, {}, {}]);
    const makeEngine: MakeEngine = (e) => t.makeEngine(e);
    const row = store.createSession({ id: 's1', cwd: home.home, engine: 'claude-code' });
    const s = openSession({ store, makeEngine, folderTrust: t.folderTrust, dir: home.home, generation }, row, true);
    return { t, s };
  };

  it('a new generation opens a new engine for the next reply; the same generation keeps the open one', async () => {
    let gen = 'g1';
    const x = sessionWith(() => gen);
    x.s.message('one');
    await x.s.idle();
    x.s.message('two');
    await x.s.idle();
    expect(x.t.opens).toHaveLength(1);
    gen = 'g2';
    x.s.message('three');
    await x.s.idle();
    expect(x.t.opens).toHaveLength(2);
    expect(x.t.turns).toEqual(['one', 'two', 'three']);
  });
});

// ---- B8 ----------------------------------------------------------------------------------------------------------------------------------------
describe('B8: the live model lists follow the address and the manifest', () => {
  const make = (lists: Record<string, string[]>) => {
    let version = 'https://a.example\ng1';
    let at = 0;
    const calls: string[] = [];
    const live = createLiveModels({
      fetchIds: async () => { calls.push(version); return lists[version]; },
      keyless: () => true, consented: () => true, now: () => at, version: () => version,
    });
    return { live, calls, set: (v: string) => { version = v; }, advance: (ms: number) => { at += ms; } };
  };

  it('an edited address shows the new origin\'s list at once: the old list is gone, and the next refresh fetches without waiting for the ttl', async () => {
    const x = make({ 'https://a.example\ng1': ['old-1'], 'https://b.example\ng2': ['new-1'] });
    await x.live.refresh('kp');
    expect(x.live.ids('kp')).toEqual(['old-1']);
    x.set('https://b.example\ng2');
    expect(x.live.ids('kp')).toEqual([]);
    await x.live.refresh('kp');
    expect(x.live.ids('kp')).toEqual(['new-1']);
    expect(x.calls).toEqual(['https://a.example\ng1', 'https://b.example\ng2']);
  });

  it('a new manifest generation on the same address clears it too', async () => {
    const x = make({ 'https://a.example\ng1': ['one'], 'https://a.example\ng2': ['two'] });
    await x.live.refresh('kp');
    x.set('https://a.example\ng2');
    expect(x.live.ids('kp')).toEqual([]);
    await x.live.refresh('kp');
    expect(x.live.ids('kp')).toEqual(['two']);
  });

  it('nothing changed: the list is kept and the ttl still holds the next fetch back', async () => {
    const x = make({ 'https://a.example\ng1': ['one'] });
    await x.live.refresh('kp');
    x.advance(60_000);
    await x.live.refresh('kp');
    expect(x.calls).toHaveLength(1);
    expect(x.live.ids('kp')).toEqual(['one']);
  });

  it('a fetch that was started for the old address does not fill the cache of the new one', async () => {
    let release!: () => void;
    let version = 'https://a.example\ng1';
    const live = createLiveModels({
      fetchIds: (p) => { void p; return new Promise<string[]>((ok) => { release = () => ok(['from-the-old-address']); }); },
      keyless: () => true, consented: () => true, version: () => version,
    });
    const pending = live.refresh('kp');
    version = 'https://b.example\ng2';
    release();
    await pending;
    expect(live.ids('kp')).toEqual([]);
  });

  it('the installed provider: the version changes with the address and with any setting, and not with a reload that changes nothing', async () => {
    await install();
    const src = liveListSource(mods, { env: {}, home: home.home });
    const v0 = src.version('kp');
    await edit({});
    expect(src.version('kp')).toBe(v0);
    await edit({ models: [{ id: 'm', price: { input: 5, output: 5 } }] });
    const v1 = src.version('kp');
    expect(v1).not.toBe(v0);
    await edit({ baseUrl: 'http://127.0.0.1:9/v1' });
    expect(src.version('kp')).not.toBe(v1);
    expect(src.version('gone')).toBe('');
  });
});

// ---- B7 ----------------------------------------------------------------------------------------------------------------------------------------
const evil = { model: 'evil-model', messages: [{ role: 'user', content: 'taken over' }], tools: [], stream: false, stream_options: { include_usage: false }, temperature: 0.5 };

describe('B7: a manifest body cannot take over what Reins writes (the validator, the first layer)', () => {
  const problemsOf = async (over: Record<string, unknown>) => {
    await install(over);
    return mods.mods.find((m) => m.id === 'kp')!.problems.join('\n');
  };

  it.each(RESERVED_BODY)('the provider body naming `%s` is refused with plain words', async (key) => {
    const text = await problemsOf({ body: { [key]: key === 'stream' ? false : {} } });
    expect(text).toContain(`\`body\` names \`${key}\`, which Reins sets itself.`);
    expect(mods.registry.ids('provider')).not.toContain('kp');
  });

  it('a model body and a reasoning level body are checked as well, and name where', async () => {
    expect(await problemsOf({ models: [{ id: 'm', body: { model: 'x' } }] })).toContain('`models.m.body` names `model`');
    mods.dispose();
    expect(await problemsOf({ efforts: [{ id: 'hi', label: 'High', body: { messages: [] } }] })).toContain('`efforts.hi.body` names `messages`');
  });

  it('every key at once are all named; a body that is not an object is refused; ordinary keys pass', async () => {
    const all = await problemsOf({ body: evil });
    for (const k of RESERVED_BODY) expect(all).toContain(`\`${k}\``);
    mods.dispose();
    expect(await problemsOf({ body: ['model'] })).toContain('`body` must be an object.');
    mods.dispose();
    expect(await problemsOf({ body: { temperature: 0, top_p: 1, thinking: { type: 'enabled', budget_tokens: 1024 } } })).toBe('');
    expect(mods.registry.ids('provider')).toContain('kp');
  });
});

describe('B7: the merge keeps them from Reins (the second layer)', () => {
  const p = (over: Partial<ProviderManifest>): ProviderManifest => ({ ...manifest(), ...over }) as unknown as ProviderManifest;
  const base = () => ({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 't' }], stream_options: { include_usage: true } });

  it('the provider, model and effort bodies cannot change model, messages, tools, stream or stream_options', () => {
    const m = p({ body: evil, models: [{ id: 'm', body: { model: 'x', tools: ['y'] } }], efforts: [{ id: 'e', label: 'E', body: { messages: [], stream_options: 7 } }] });
    const out = mergeBodies(base(), m, 'm', 'e');
    expect(out).toEqual({ ...base(), temperature: 0.5 });
    expect(Object.hasOwn(out, 'stream')).toBe(false); // the wire writes it after the merge
  });

  it('a key the request does not have is not added by a body (no tools, no stream_options)', () => {
    const out = mergeBodies({ model: 'm', messages: [] }, p({ body: { tools: [{ name: 'x' }], stream_options: { include_usage: true }, top_p: 1 } }), 'm', undefined);
    expect(out).toEqual({ model: 'm', messages: [], top_p: 1 });
  });

  it('other keys still merge: later layers win, objects merge', () => {
    const m = p({ body: { thinking: { a: 1, b: 1 }, top_p: 1 }, models: [{ id: 'm', body: { thinking: { b: 2 } } }], efforts: [{ id: 'e', label: 'E', body: { top_p: 0.1 } }] });
    expect(mergeBodies(base(), m, 'm', 'e')).toMatchObject({ thinking: { a: 1, b: 2 }, top_p: 0.1 });
  });
});

describe.each(WIRES)('B7: on the wire (%s) a manifest that skipped the validator still sends Reins\'s model, messages, tools and stream', (wire) => {
  const rigs: Rig[] = [];
  afterEach(async () => { for (const r of rigs.splice(0)) await r.cleanup(); });

  it('the request that goes out holds the chosen model and the real conversation', async () => {
    const r = await rig(wire, { manifest: { body: evil, models: [{ id: 'm', context: 1000, maxOutput: 100, price: PRICE, body: { model: 'x' } }], efforts: [{ id: 'e', label: 'E', body: { tools: [] } }] } });
    rigs.push(r);
    r.push({ text: 'ok' });
    const s = await r.open({ effort: 'e' });
    await s.turn('the real question');
    const body = r.fake.requests[0]!.body;
    expect(body.model).toBe('m');
    expect(body.stream).toBe(true);
    expect(JSON.stringify(body.messages)).toContain('the real question');
    expect(JSON.stringify(body.messages)).not.toContain('taken over');
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.temperature).toBe(0.5);
    if (wire === 'openai-chat') expect(body.stream_options).toEqual({ include_usage: true });
    else expect(body.stream_options).toBeUndefined();
  });

  it('usage.streamOptions false stays off whatever a body says', async () => {
    if (wire !== 'openai-chat') return;
    const r = await rig(wire, { manifest: { usage: { streamOptions: false }, body: { stream_options: { include_usage: true } } } });
    rigs.push(r);
    r.push({ text: 'ok' });
    await (await r.open()).turn('go');
    expect(r.fake.requests[0]!.body.stream_options).toBeUndefined();
  });
});
