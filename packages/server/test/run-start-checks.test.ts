// Milestone P, Task 18 (spec 9.2, 9.4, 10.2, 10.3, S5): parseModel, the six run-start checks (the app's start route and `reins run`), subagents on
// their own provider, and `reins run --provider/--model/--resume`. Real mods on the bundled wire, two fake provider servers, a temp Reins folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { checkEnvFrom, makeEngineFrom, startMods } from '../src/engines.js';
import { parseModel } from '../src/models.js';
import type { Mods } from '../src/mods/types.js';
import { Redactor, clearKey, readSecrets, setKey } from '../src/secrets.js';
import { makeSend } from '../src/send.js';
import { startServer, type Server } from '../src/server.js';
import { openSession, type Consent } from '../src/session.js';
import { openStore, type Store } from '../src/store.js';
import { startFakeProvider } from './fake-provider.js';
import { until } from './helpers.js';
import { PROBE, openQuestions, request } from './http-helpers.js';

const KEY = 'sk-test-0123456789abcdef';
const PRICE = { input: 1, output: 2 };

describe('parseModel (spec 9.2)', () => {
  const installed = (id: string) => ['ollama-x', 'openrouter-x', 'a', 'other'].includes(id);
  const ok = (name: string, provider: string, model: string) => ({ name, expect: { provider, model } });
  const rows = [
    ok('ollama-x:qwen3:30b', 'ollama-x', 'qwen3:30b'),
    ok('openrouter-x:anthropic/x', 'openrouter-x', 'anthropic/x'),
    ok('ollama-x:hf.co/a:Q4', 'ollama-x', 'hf.co/a:Q4'),
    ok('m', 'sess', 'm'),
    ok('hf.co/a:Q4', 'sess', 'hf.co/a:Q4'),           // a prefix that cannot be a provider id stays part of the name
    ok('llama3.2:3b', 'sess', 'llama3.2:3b'),         // a dot cannot be in a provider id
    ok('a:b:c', 'a', 'b:c'),                          // split at the FIRST colon
    ok('  other:m  ', 'other', 'm'),                   // whitespace around the name and the model is dropped
    ok('other: m', 'other', 'm'),
    ok('other', 'sess', 'other'),                      // an installed provider's id as a bare model name is a model on the session's provider
    ok('sess', 'sess', 'sess'),
    ok(':m', 'sess', ':m'),
  ];
  for (const r of rows) {
    it(`${JSON.stringify(r.name)} -> ${r.expect.provider}, ${r.expect.model}`, () => {
      expect(parseModel(r.name, 'sess', installed)).toEqual(r.expect);
    });
  }

  it('an unknown prefix that looks like a provider id gives the 9.2 words, with the prefixed-form hint', () => {
    expect(parseModel('qwen3:30b', 'ollama-x', installed, 'x')).toEqual({
      error: 'Unknown model qwen3:30b in step `x`: no provider `qwen3` is installed. To name a model on another provider, write <provider>:<model>, for example ollama-x:qwen3:30b.',
    });
    expect(parseModel('qwen3:30b', 'ollama-x', installed)).toEqual({
      error: 'Unknown model qwen3:30b: no provider `qwen3` is installed. To name a model on another provider, write <provider>:<model>, for example ollama-x:qwen3:30b.',
    });
  });

  it('a prefix in capitals is not the installed provider; the hint is the same', () => {
    expect(parseModel('Other:m', 'sess', installed, 's')).toMatchObject({ error: expect.stringContaining('no provider `Other` is installed') });
  });

  it('an installed provider with no model after the colon is refused', () => {
    expect(parseModel('other:', 'sess', installed, 's')).toEqual({ error: 'Unknown model other: in step `s`: no model is named after `other:`.' });
    expect(parseModel('other:  ', 'sess', installed)).toEqual({ error: 'Unknown model other:: no model is named after `other:`.' });
  });

  it('an empty name is refused', () => {
    expect(parseModel('  ', 'sess', installed, 's')).toEqual({ error: 'Unknown model in step `s`: no model is named.' });
  });

  it('an empty model after an unknown id-shaped prefix is the same refusal as any unknown prefix', () => {
    expect(parseModel('zz:', 'sess', installed)).toMatchObject({ error: expect.stringContaining('no provider `zz` is installed') });
  });
});

// ---- a Reins folder with five providers, a server on it, and fake provider servers

interface World {
  root: string;
  dir: string;
  proj: string;
  env: NodeJS.ProcessEnv;
  mods: Mods;
  p: Awaited<ReturnType<typeof startFakeProvider>>;
  q: Awaited<ReturnType<typeof startFakeProvider>>;
  store: Store;
  srv: Server;
}
let w: World;

function writeMod(dir: string, id: string, manifest: Record<string, unknown>) {
  const folder = path.join(dir, 'mods', id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'mod.json'), JSON.stringify({ reins: 1, id, kind: 'provider', version: '1.0.0', protocol: 'openai-chat', ...manifest }, null, 2));
}

beforeAll(async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-checks-')));
  const dir = path.join(root, '.reins');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const p = await startFakeProvider();
  const q = await startFakeProvider();
  const bearer = (name: string) => ({ style: 'bearer', keyEnv: [name] });
  writeMod(dir, 'p', {
    label: 'Fake P', baseUrl: `${p.url}/v1`, auth: bearer('P_API_KEY'), defaultModel: 'm',
    efforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], defaultEffort: 'low',
    models: [{ id: 'm', price: PRICE }, { id: 'nt', tools: false, price: PRICE }, { id: 'np' }, { id: 'ntnp', tools: false }],
  });
  writeMod(dir, 'other', { label: 'Other', baseUrl: `${q.url}/v1`, auth: bearer('OTHER_API_KEY'), defaultModel: 'om', models: [{ id: 'om', price: PRICE }] });
  writeMod(dir, 'nokey', {
    label: 'No Key', baseUrl: `${p.url}/v1`, auth: bearer('NOKEY_API_KEY'), defaultModel: 'km',
    models: [{ id: 'km', price: PRICE }, { id: 'kt', tools: false, price: PRICE }],
  });
  // A local server: no key, and a default price of 0/0 for every model it lists, priced or not.
  writeMod(dir, 'loc', { label: 'Local', baseUrl: 'http://127.0.0.1:1/v1', auth: { style: 'none', keyEnv: [] }, price: { input: 0, output: 0 }, defaultModel: 'lm', models: [{ id: 'lm' }] });
  setKey(dir, 'p', KEY);
  setKey(dir, 'other', KEY);
  const env: NodeJS.ProcessEnv = { ...process.env, REINS_HOME: root };
  for (const name of ['P_API_KEY', 'OTHER_API_KEY', 'NOKEY_API_KEY']) delete env[name];
  const mods = await startMods({ dir, env });
  expect(mods.mods.flatMap((m) => m.problems)).toEqual([]);
  const store = openStore(':memory:');
  const srv = await startServer({ store, dir, mods, env: {}, probe: async () => PROBE, makeEngine: makeEngineFrom(mods, { env: {}, home: dir }) });
  w = { root, dir, proj, env, mods, p, q, store, srv };
});

afterAll(async () => {
  await w.srv.close();
  w.store.close();
  w.mods.dispose();
  await w.p.close();
  await w.q.close();
  fs.rmSync(w.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

let n = 0;
const FRONT = (usd?: number) => `---\nreins: 1\nname: w\nbudget: { turns: 20, minutes: 20${usd === undefined ? '' : `, usd: ${usd}`} }\nalways: []\n---\n\n`;
const put = (text: string) => {
  const file = path.join(w.proj, `w${++n}.reins.md`);
  fs.writeFileSync(file, text);
  return file;
};

async function viaApp(engine: string, file: string) {
  const made = await request(w.srv, 'POST', '/api/sessions', { body: { cwd: w.proj, engine } });
  expect(made.status, made.text).toBe(200);
  const id = made.json.id as string;
  const r = await request(w.srv, 'POST', `/api/sessions/${id}/run`, { body: { path: file } });
  return { id, status: r.status, error: r.json?.error as string | undefined };
}

async function viaCli(argv: string[]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  stdin.end();
  let out = '';
  let err = '';
  stdout.on('data', (d) => (out += d));
  stderr.on('data', (d) => (err += d));
  const code = await main(argv, { stdout, stderr, stdin, env: w.env });
  return { code, out, err };
}

const STARTED = /Reins · run [0-9a-f]{8}/;

describe('the six run-start checks, in the app and in reins run (spec 10.2)', () => {
  const MODEL = (name: string) => `## model ${name}\n\n## phase go\n> Go.\n`;
  const refusals: Array<{ name: string; engine: string; usd?: number; body: string; words: string }> = [
    {
      name: '1: a model on a provider that is not installed', engine: 'p', body: MODEL('gone:x'),
      words: 'Unknown model gone:x in step `model-1`: no provider `gone` is installed. To name a model on another provider, write <provider>:<model>, for example p:gone:x.',
    },
    {
      name: '2: a provider with no key', engine: 'p', body: MODEL('nokey:km'),
      words: 'No Key has no key. Set NOKEY_API_KEY, or add a key in Settings > Providers.',
    },
    {
      name: '3: a model that cannot call tools', engine: 'p', body: MODEL('nt'),
      words: 'nt cannot call tools, so it cannot edit files or run commands. Pick a model with tools for playbooks.',
    },
    {
      name: '4: a reasoning level the model does not have', engine: 'p', body: '## subagent r\nreasoning: max\n> Look.\n',
      words: 'Reasoning max in step `subagent-1` is not one of the levels of m: low, high.',
    },
    {
      name: '5: a USD budget and a model with no price', engine: 'p', usd: 2.5, body: MODEL('np'),
      words: 'np has no price, so Reins cannot hold the $2.5 budget. Add a price in Settings > Providers, or remove the budget.',
    },
    {
      name: '6: a model block from a loop provider to a provider that keeps its own conversation', engine: 'p', body: MODEL('claude-code:claude-opus-5-5'),
      words: 'Fake P keeps its own conversation, so Reins cannot move it to Claude. Start a new session for Claude.',
    },
    {
      name: '6: and the other way round', engine: 'claude-code', body: MODEL('p:m'),
      words: 'Claude keeps its own conversation, so Reins cannot move it to Fake P. Start a new session for Fake P.',
    },
    // two failures: the first listed wins, wherever its step is in the file
    {
      name: 'order 1 before 3', engine: 'p', body: '## model nt\n\n## model gone:y\n\n## phase go\n> Go.\n',
      words: 'Unknown model gone:y in step `model-2`: no provider `gone` is installed. To name a model on another provider, write <provider>:<model>, for example p:gone:y.',
    },
    {
      name: 'order 2 before 3', engine: 'p', body: MODEL('nokey:kt'),
      words: 'No Key has no key. Set NOKEY_API_KEY, or add a key in Settings > Providers.',
    },
    {
      name: 'order 3 before 5', engine: 'p', usd: 1, body: MODEL('ntnp'),
      words: 'ntnp cannot call tools, so it cannot edit files or run commands. Pick a model with tools for playbooks.',
    },
    {
      name: 'order 4 before 5', engine: 'p', usd: 1, body: '## subagent r\nreasoning: max\n> Look.\n\n## model np\n',
      words: 'Reasoning max in step `subagent-1` is not one of the levels of m: low, high.',
    },
    {
      name: 'order 5 before 6', engine: 'p', usd: 1, body: '## model np\n\n## model claude-code:claude-opus-5-5\n',
      words: 'np has no price, so Reins cannot hold the $1 budget. Add a price in Settings > Providers, or remove the budget.',
    },
  ];

  for (const r of refusals) {
    it(`${r.name}: refused with its words in the app (400) and in reins run (exit 1)`, async () => {
      const file = put(FRONT(r.usd) + r.body);
      const app = await viaApp(r.engine, file);
      expect([app.status, app.error]).toEqual([400, r.words]);
      expect(w.store.readLog(app.id).filter((x) => x.type === 'run_started')).toEqual([]);
      const cli = await viaCli(['run', file, '--provider', r.engine]);
      expect(cli.code).toBe(1);
      expect(cli.out).toContain(r.words);
      expect(cli.out).not.toMatch(STARTED);
    });
  }

  const clean: Array<{ name: string; engine: string; usd?: number; body: string }> = [
    { name: 'a plain workflow', engine: 'p', body: '## phase go\n> Go.\n' },
    { name: 'a model block on another loop provider, with a priced model and a USD budget', engine: 'p', usd: 1, body: MODEL('other:om') },
    { name: 'a local provider with a default price of 0/0 holds a USD budget (a model it lists with no price of its own)', engine: 'loc', usd: 1, body: MODEL('lm') },
    { name: 'a block that names a local provider from a cloud session', engine: 'p', usd: 1, body: MODEL('loc:lm') },
    { name: 'a subagent on another provider, a reasoning level the model has', engine: 'p', body: '## subagent r\nreasoning: high\n> Look.\n\n## phase go\n> Go.\n' },
    { name: 'a priced cloud model with a USD budget', engine: 'p', usd: 1, body: MODEL('m') },
  ];
  for (const c of clean) {
    it(`a clean workflow starts: ${c.name}`, async () => {
      const file = put(FRONT(c.usd) + c.body);
      const app = await viaApp(c.engine, file);
      expect([app.status, app.error]).toEqual([200, undefined]);
      await until(() => openQuestions(w.store.readLog(app.id)).some((q) => q.kind === 'trust'));
      const q = openQuestions(w.store.readLog(app.id)).find((x) => x.kind === 'trust')!;
      const ack = await request(w.srv, 'POST', `/api/sessions/${app.id}/answer`, { body: { questionId: q.id, answer: 'n' } });
      expect(ack.status).toBe(200);
      const cli = await viaCli(['run', file, '--provider', c.engine]);
      expect(cli.out).toMatch(STARTED);
      expect(cli.err).toBe('');
    }, 30_000);
  }

  it('a USD budget on an unpriced model refuses; with no budget the same model starts', async () => {
    const file = put(FRONT() + MODEL('np'));
    expect((await viaApp('p', file)).status).toBe(200);
    const priced = put(FRONT(1) + MODEL('np'));
    expect((await viaApp('p', priced)).status).toBe(400);
  });

  it('a slice budget on a step counts as a USD budget', async () => {
    const file = put(FRONT() + '## model np\nusd: 0.5\n\n## phase go\n> Go.\n');
    const app = await viaApp('p', file);
    expect([app.status, app.error]).toEqual([400, 'np has no price, so Reins cannot hold the $0.5 budget. Add a price in Settings > Providers, or remove the budget.']);
  });

  it('a subagent step with its own model does not move the session: a later bare model is judged on the session provider', async () => {
    const app = await viaApp('p', put(FRONT() + '## subagent r\nmodel: other:om\n> Look.\n\n## model nt\n\n## phase go\n> Go.\n'));
    expect([app.status, app.error]).toEqual([400, 'nt cannot call tools, so it cannot edit files or run commands. Pick a model with tools for playbooks.']);
  });

  it('a bare model that the session provider does not list still gets the old words', async () => {
    const app = await viaApp('p', put(FRONT() + MODEL('nope')));
    expect([app.status, app.error]).toEqual([400, "Unknown model nope in step `model-1`: it is not in this session's provider list."]);
  });
});

// ---- subagents on their own provider

describe('a subagent opens on the provider its step names (spec 10.3)', () => {
  const SUB = FRONT() + '## subagent research\nmodel: other:om\n> Look.\n\n## phase use\n> Use it.\n';

  function setup(o: { consent?: (provider: string) => Consent | undefined; effort?: string } = {}) {
    const store = openStore(':memory:');
    const row = store.createSession({ id: 's1', cwd: w.proj, engine: 'p', model: 'm', ...(o.effort ? { effort: o.effort } : {}) });
    const gone = new Set<string>();
    const base = checkEnvFrom(w.mods, { env: {}, home: w.dir });
    const providers = { installed: (id: string) => !gone.has(id) && base.installed(id), facts: (id: string) => (gone.has(id) ? undefined : base.facts(id)) };
    const redactor = new Redactor({ home: w.dir, env: {}, keyEnvNames: () => ['P_API_KEY', 'OTHER_API_KEY'] });
    const send = makeSend({ secrets: () => readSecrets(w.dir), env: {}, redactor, consent: () => true });
    const s = openSession({
      store, dir: w.dir, providers, ...(o.consent ? { consent: o.consent } : {}),
      makeEngine: makeEngineFrom(w.mods, { env: {}, home: w.dir, send }),
    }, row, true);
    const open = () => openQuestions(store.readLog('s1'));
    const asked = async (match: (q: { kind: string; prompt: string }) => boolean) => {
      await until(() => open().some(match));
      return open().find(match)!;
    };
    return {
      store, s, gone, open, asked,
      async go(text: string) {
        w.p.requests.length = 0;
        w.q.requests.length = 0;
        expect(s.runFile(put(text))).toEqual({ ok: true });
        s.answer((await asked((q) => q.kind === 'trust')).id, 'y');
      },
      log: () => JSON.stringify(store.readLog('s1')),
      done: () => { store.close(); },
    };
  }

  it('a session with a reasoning level still opens a subagent on another provider that has no levels', async () => {
    const x = setup({ effort: 'high' });
    w.q.push({ text: 'found it' });
    w.p.push({ text: 'REINS: done' });
    await x.go(SUB);
    await x.s.idle();
    expect(w.q.requests).toHaveLength(1);   // the subagent opened on the other provider and asked
    expect(x.store.readLog('s1').filter((r) => r.type === 'run_finished')).toHaveLength(1);
    x.done();
  });

  it('a session whose provider is no longer installed is refused at the start with the 9.4 words', async () => {
    const x = setup();
    x.gone.add('p');
    expect(x.s.runFile(put(FRONT() + '## phase go\n> Go.\n'))).toEqual({
      ok: false, code: 400, error: 'This session uses p, which is not installed. Install it in Settings > Providers, or start a new session.',
    });
    x.done();
  });

  it('the second provider sees the request and the first does not see the subagent', async () => {
    const x = setup();
    w.q.push({ text: 'found it' });
    w.p.push({ text: 'REINS: done' });
    await x.go(SUB);
    await x.s.idle();
    expect(w.q.requests).toHaveLength(1);
    expect(w.q.requests[0]!.body.model).toBe('om');
    expect(JSON.stringify(w.q.requests[0]!.body)).toContain('Look.');
    expect(JSON.stringify(w.q.requests[0]!.body)).not.toContain('Use it.');
    expect(w.p.requests).toHaveLength(1);
    expect(w.p.requests[0]!.body.model).toBe('m');
    expect(JSON.stringify(w.p.requests[0]!.body)).not.toContain('Look.');
    expect(w.q.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(x.store.readLog('s1').filter((r) => r.type === 'run_finished')).toHaveLength(1);
    expect(x.store.readLog('s1').filter((r) => r.type === 'subagent_started').map((r) => (r.data as { model?: string }).model)).toEqual(['om']);
    x.done();
  });

  it('a subagent with no model of its own stays on the session\'s provider and model', async () => {
    const x = setup();
    w.p.push({ text: 'found it' }, { text: 'REINS: done' });
    await x.go(FRONT() + '## subagent research\n> Look.\n\n## phase use\n> Use it.\n');
    await x.s.idle();
    expect(w.q.requests).toHaveLength(0);
    expect(w.p.requests.map((r) => r.body.model)).toEqual(['m', 'm']);
    x.done();
  });

  it('a subagent on a provider that was removed pauses its step with the words, and the run can be stopped', async () => {
    const x = setup();
    w.q.requests.length = 0;
    expect(x.s.runFile(put(SUB))).toEqual({ ok: true });   // the run-start checks pass: the provider is there
    const trust = await x.asked((q) => q.kind === 'trust');
    x.gone.add('other');                                    // and goes before the subagent opens
    x.s.answer(trust.id, 'y');
    const resume = await x.asked((q) => q.kind === 'resume');
    const words = 'Unknown model other:om in step `subagent-1`: no provider `other` is installed. To name a model on another provider, write <provider>:<model>, for example p:other:om.';
    expect(x.log()).toContain(`the subagent did not start (${words})`);
    expect(w.q.requests).toHaveLength(0);
    x.s.answer(resume.id, 'stop');
    await x.s.idle();
    expect(x.store.readLog('s1').some((r) => r.type === 'run_stopped')).toBe(true);
    expect(x.s.status()).toBe('idle');
    x.done();
  });

  it('a subagent on a provider whose key was removed pauses its step with the missing-key words', async () => {
    const x = setup();
    clearKey(w.dir, 'other');
    try {
      expect(x.s.runFile(put(SUB))).toEqual({ ok: false, code: 400, error: 'Other has no key. Set OTHER_API_KEY, or add a key in Settings > Providers.' });
    } finally {
      setKey(w.dir, 'other', KEY);
    }
    // the key goes after the start: only the subagent's open sees it
    const file = put(SUB);
    expect(x.s.runFile(file)).toEqual({ ok: true });
    clearKey(w.dir, 'other');
    try {
      x.s.answer((await x.asked((q) => q.kind === 'trust')).id, 'y');
      const resume = await x.asked((q) => q.kind === 'resume');
      expect(x.log()).toContain('Other has no key. Set OTHER_API_KEY, or add a key in Settings > Providers.');
      expect(w.q.requests).toHaveLength(0);
      x.s.answer(resume.id, 'stop');
      await x.s.idle();
    } finally {
      setKey(w.dir, 'other', KEY);
    }
    x.done();
  });

  const consentFor = (granted: Set<string>, asked: string[]) => (provider: string): Consent | undefined => {
    if (granted.has(provider)) return undefined;
    asked.push(provider);
    return {
      prompt: `Send to ${provider}? [y / n]`, detail: `for ${provider}`, refused: `Nothing was sent to ${provider}.`, stopped: 'Stopped.',
      grant: () => { granted.add(provider); },
    };
  };

  it('a provider that is not consented yet is asked before the subagent opens; a yes records it and the request goes', async () => {
    const granted = new Set(['p']);
    const asked: string[] = [];
    const x = setup({ consent: consentFor(granted, asked) });
    w.q.push({ text: 'found it' });
    w.p.push({ text: 'REINS: done' });
    await x.go(SUB);
    const q = await x.asked((c) => c.prompt === 'Send to other? [y / n]');
    expect(w.q.requests).toHaveLength(0);
    x.s.answer(q.id, 'y');
    await x.s.idle();
    expect(granted.has('other')).toBe(true);
    expect(asked).toEqual(['other']);   // the session's own provider was granted before; only the subagent's was asked
    expect(w.q.requests).toHaveLength(1);
    x.done();
  });

  it('a no pauses the step with the refusal words and nothing is sent to that provider', async () => {
    const x = setup({ consent: consentFor(new Set(['p']), []) });
    await x.go(SUB);
    const q = await x.asked((c) => c.prompt === 'Send to other? [y / n]');
    x.s.answer(q.id, 'n');
    const resume = await x.asked((c) => c.kind === 'resume');
    expect(x.log()).toContain('Nothing was sent to other.');
    expect(w.q.requests).toHaveLength(0);
    x.s.answer(resume.id, 'stop');
    await x.s.idle();
    x.done();
  });
});

// ---- reins run

describe('reins run --provider / --model / --resume', () => {
  const PHASE = FRONT() + '## phase go\n> Go.\n';
  const origin = (u: string) => new URL(u).host;

  it('--model <provider>:<model> puts the run on that provider (the default provider is another)', async () => {
    const r = await viaCli(['run', put(PHASE), '--model', 'p:m']);
    expect(r.out).toMatch(STARTED);
    expect(r.out).toContain(origin(w.p.url));
    expect(r.out).not.toContain(origin(w.q.url));
  });

  it('--provider without --model runs on that provider', async () => {
    const r = await viaCli(['run', put(PHASE), '--provider', 'other']);
    expect(r.out).toMatch(STARTED);
    expect(r.out).toContain(origin(w.q.url));
    expect(r.out).not.toContain(origin(w.p.url));
  });

  it('a --model prefix that disagrees with --provider wins, and a note says so', async () => {
    const r = await viaCli(['run', put(PHASE), '--provider', 'other', '--model', 'p:m']);
    expect(r.err).toBe('--model p:m names p, so the run is on p, not other.\n');
    expect(r.out).toContain(origin(w.p.url));
    expect(r.out).not.toContain(origin(w.q.url));
  });

  it('a --model prefix that is the same provider as --provider says nothing', async () => {
    const r = await viaCli(['run', put(PHASE), '--provider', 'p', '--model', 'p:m']);
    expect(r.err).toBe('');
    expect(r.out).toContain(origin(w.p.url));
  });

  it('--model with an unknown prefix is refused before the run, with the 9.2 words', async () => {
    const r = await viaCli(['run', put(PHASE), '--provider', 'p', '--model', 'qwen3:30b']);
    expect(r.code).toBe(1);
    expect(r.err).toBe('Unknown model qwen3:30b: no provider `qwen3` is installed. To name a model on another provider, write <provider>:<model>, for example p:qwen3:30b.\n');
    expect(r.out).toBe('');
  });

  it('--model with an installed provider and no model is refused', async () => {
    const r = await viaCli(['run', put(PHASE), '--model', 'p:']);
    expect(r.code).toBe(1);
    expect(r.err).toBe('Unknown model p:: no model is named after `p:`.\n');
  });

  it('--provider that is not installed is refused as before', async () => {
    const r = await viaCli(['run', put(PHASE), '--provider', 'gone']);
    expect([r.code, r.err]).toEqual([1, 'No provider `gone` is installed.\n']);
  });

  it('the checks use the session the flags describe: --model nt refuses, and --provider other --model om with a budget starts', async () => {
    const bad = await viaCli(['run', put(PHASE), '--model', 'p:nt']);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('nt cannot call tools, so it cannot edit files or run commands. Pick a model with tools for playbooks.');
    const good = await viaCli(['run', put(FRONT(1) + '## phase go\n> Go.\n'), '--provider', 'other', '--model', 'om']);
    expect(good.out).toMatch(STARTED);
  });

  it('a subagent step with model other:om runs on provider other, not on the run\'s provider', async () => {
    const r = await viaCli(['run', put(FRONT() + '## subagent research\nmodel: other:om\n> Look.\n'), '--provider', 'p']);
    expect(r.out).toContain('subagent research started on om');
    expect(r.out).toContain(origin(w.q.url));
    expect(r.out).not.toContain(origin(w.p.url));
  });

  describe('--resume', () => {
    function seed(engine: string) {
      const file = put(PHASE);
      const dbFile = path.join(w.dir, 'reins.db');
      const store = openStore(dbFile);
      store.createSession({ id: 'sr', cwd: w.proj, engine });
      store.createRun({ id: 'rr1', workflowPath: file, cwd: w.proj });
      store.appendLog('sr', { type: 'run_started', runId: 'rr1' });
      store.close();
    }

    it('a run of a session whose provider was removed: exit 1 with the 9.4 words, and nothing thrown', async () => {
      seed('removed-one');
      const r = await viaCli(['run', '--resume', 'rr1']);
      expect(r.code).toBe(1);
      expect(r.err).toBe('This session uses removed-one, which is not installed. Install it in Settings > Providers, or start a new session.\n');
      expect(r.out).toBe('');
      expect(r.err).not.toMatch(/\bat\b.*\.(ts|js)/);   // no stack trace
    });

    it('a run of a session whose provider is installed gets the old answer: resume it from the app', async () => {
      fs.rmSync(path.join(w.dir, 'reins.db'), { force: true });
      seed('p');
      const r = await viaCli(['run', '--resume', 'rr1']);
      expect(r.code).toBe(1);
      expect(r.out).toContain('run rr1 belongs to chat session sr; resume it from the app');
    });
  });
});
