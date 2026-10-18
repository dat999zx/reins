// Milestone P, task 1: what the Claude adapter and the provider surfaces do today, recorded from the unmodified code.
// `REINS_RECORD_P=1 npx vitest run packages/server/test/p-pins.test.ts` writes golden-p/*.json; a normal run compares.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EngineSession, TurnResult } from '@reins/core';
import { golden as compare } from '../../core/test/golden-3a/stable.js';
import { createCatalog } from '../src/catalog.js';
import { claudeEngine, probeClaude } from '../src/mods/claude-code-cli/engine.js';
import { findClaude } from '../src/mods/claude-code-cli/find.js';
import { loadProviders } from '../src/providers.js';
import { openSession } from '../src/session.js';
import { priceFor } from '../src/settings.js';
import { openStore } from '../src/store.js';
import { folderHash } from '../src/trust.js';
import { FAKE_CLAUDE, fakeSetup } from './helpers.js';
import { askedQuestion, boot, cleanup, tmpDir } from './http-helpers.js';
import { testEngine } from './test-engine.js';

const golden = (name: string, value: unknown) => compare(`${name}.json`, value, 'REINS_RECORD_P', path.join(__dirname, 'golden-p'));
const rnd = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 1e9) / 1e9);
const rndMap = (m: Record<string, number> | undefined) => (m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, rnd(v)])) : undefined);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const tmps: string[] = [];
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p-'))); tmps.push(d); return d; };
afterEach(async () => {
  await cleanup();
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const T = (turn: number) => ({ fixture: 'claude-2.1.281-turns.jsonl', turn });
const write = () => ({ mode: 'edit' as const, allow: [], deny: [], bash: 'ask' as const }) as never;
const SESSION = '11111111-2222-3333-4444-555555555555';

/** Open, run one turn (the fake logs its argv at start), close; return what the fake saw, scrubbed of paths, ids and ports. */
async function argsOf(cfg: { model?: string; effort?: string }, open: Record<string, unknown>) {
  const f = fakeSetup([T(0)]);
  tmps.push(f.dir);
  const s: EngineSession = await claudeEngine({ bin: FAKE_CLAUDE, onApprove: async () => ({ allow: true }) as never, ...cfg }).open({ cwd: f.dir, policy: write, ...open } as never);
  await s.turn('hi');
  await s.close();
  const seen = f.log().find((l) => l.kind === 'args');
  const args = (seen.args as string[]).map((a) => (path.isAbsolute(a) ? `<TMP>/${path.basename(a)}` : a.replace(UUID, '<UUID>')));
  const hooks = JSON.stringify(seen.settings.hooks).replace(/http:\/\/[^"]+/g, '<HOOK_URL>');
  return { args, hooks: JSON.parse(hooks) };
}

describe('P pins: the Claude adapter', () => {
  it('args: the argv of a new session, a resume, model + effort, and maxUsd', async () => {
    golden('args', {
      new: await argsOf({}, {}),
      resume: await argsOf({}, { sessionId: SESSION }),
      modelAndEffort: await argsOf({}, { model: 'claude-opus-5-5', effort: 'high' }),
      configModelAndEffort: await argsOf({ model: 'claude-haiku-5-5', effort: 'low' }, {}),
      maxUsd: await argsOf({}, { maxUsd: 0.25 }),
      maxUsdZero: await argsOf({}, { maxUsd: 0 }),
    });
  });

  it('turns: three turns, close, reopen with the baselines, one more turn', async () => {
    const f = fakeSetup([T(0), T(1), T(2)], 10, { cumulative: true });
    tmps.push(f.dir);
    const engine = claudeEngine({ bin: FAKE_CLAUDE, onApprove: async () => ({ allow: true }) as never });
    const norm = (r: TurnResult) => ({ ...r, events: r.events?.map((e) => e.type), cost: rnd(r.cost), total: rnd(r.total), totals: rndMap(r.totals), models: rndMap(r.models) });
    const first = await engine.open({ cwd: f.dir, model: 'a', policy: write } as never);
    const r1 = await first.turn('one');
    const r2 = await first.turn('two');
    const r3 = await first.turn('three');
    await first.close();
    const second = await engine.open({ cwd: f.dir, model: 'a', sessionId: first.sessionId, costBase: r3.total, costBaseByModel: r3.totals, policy: write } as never);
    const r4 = await second.turn('four');
    await second.close();
    expect(second.sessionId).toBe(first.sessionId);
    golden('turns', [r1, r2, r3, r4].map(norm));
  });

  it('probe: probeClaude against the fake, a missing binary, and findClaude with an injected env', async () => {
    fakeSetup([]);
    const found = findClaude({ REINS_CLAUDE: FAKE_CLAUDE });
    expect(found?.path).toBe(FAKE_CLAUDE);
    golden('probe', {
      fake: await probeClaude(FAKE_CLAUDE),
      missing: await probeClaude(''),
      findWithEnv: found && { ...found, path: '<FAKE_CLAUDE>' },
      findNothing: findClaude({}, 'linux', tmp()) ?? null,
    });
  });
});

describe('P pins: the probe states', () => {
  // A one-file stand-in for the CLI: `--version` answers, the one-shot call prints the given stream-json lines or fails.
  const cli = (lines: unknown[], o: { versionFails?: boolean } = {}) => {
    const file = path.join(tmp(), 'cli.mjs');
    fs.writeFileSync(file, [
      `if (process.argv.includes('--version')) { ${o.versionFails ? "process.stderr.write('boom'); process.exit(3);" : "process.stdout.write('9.8.7 (Claude Code)\\\\n'); process.exit(0);"} }`,
      `for (const l of ${JSON.stringify(lines)}) process.stdout.write(JSON.stringify(l) + '\\n');`,
    ].join('\n'));
    return file;
  };
  const init = (apiKeySource: string) => ({ type: 'system', subtype: 'init', apiKeySource });
  const result = (is_error: boolean, text: string) => ({ type: 'result', is_error, result: text });

  const probe = async (bin: string) => {
    const r = await probeClaude(bin);
    return { ...r, problems: r.problems.map((x) => x.split(bin).join('<CLI>')) };
  };

  it('probe-states: logged in, logged out, unknown, an API key in use, and a failing --version', async () => {
    golden('probe-states', {
      loggedIn: await probe(cli([init('none'), result(false, 'OK')])),
      loggedOut: await probe(cli([init('none'), result(true, 'Invalid API key. Please run /login')])),
      unknown: await probe(cli([init('none'), result(true, 'something else broke')])),
      apiKey: await probe(cli([init('ANTHROPIC_API_KEY'), result(false, 'OK')])),
      versionFails: await probe(cli([], { versionFails: true })),
    });
  });
});

describe('P pins: the provider surfaces', () => {
  const catalogFile = () => {
    const file = path.join(tmpDir(), 'cache.json');
    const m = (name: string, date: string, context: number, extra: object = {}) => ({ name, release_date: date, tool_call: true, limit: { context }, ...extra });
    const cost = { cost: { input: 3, output: 15, tiers: [{ tier: { type: 'context', size: 5000 }, input: 7 }] } };
    fs.writeFileSync(file, JSON.stringify({ anthropic: { models: {
      'claude-opus-5-5': m('Claude Opus 5.5', '2026-06-01', 200_000),
      'claude-fable-5-1': m('Claude Fable 5.1', '2026-09-01', 1_000_000),
      'claude-extra-9': m('Extra 9', '2026-10-01', 500_000, cost),
      'claude-extra-8': m('Extra 8', '2026-08-01', 400_000),
      'claude-dated-20250101': m('Dated', '2025-01-01', 100_000),
      'claude-notool': { name: 'No tools', release_date: '2026-10-02', tool_call: false, limit: { context: 1 } },
    } } }));
    return file;
  };

  it('state: providers in /api/state, describeModel and the price at 10,000 tokens, describeEffort per level', async () => {
    const file = catalogFile();
    const w = await boot([], { catalog: createCatalog({ file }) });
    const providers = (await w.api('GET', '/api/state')).json.providers;

    // describeModel is the server's own closure: read it through the switch question a settings call raises.
    w.store.putSetting('switchApprovalUsd', 0);
    const ids = [...providers[0].models.map((x: { id: string }) => x.id), 'made-up'];
    const describeModel = [];
    for (const model of ids) {
      const id = await w.session({ model: '' });
      w.store.updateSession(id, { engineSessionId: 'seeded' });
      w.store.appendLog(id, { type: 'engine', data: { type: 'usage', model: 'm', used: 10_000, window: 1_000_000 } });
      const r = await w.post(id, 'settings', { model });
      if (r.status !== 200) { describeModel.push({ model, status: r.status, error: r.json.error }); continue; }
      const q = await askedQuestion(w.store, id, 'switch');
      describeModel.push({ model, status: r.status, prompt: q.prompt, detail: q.detail });
    }

    const describeEffort = [];
    for (const effort of [...providers[0].efforts.map((x: { id: string }) => x.id), 'bogus']) {
      const id = await w.session({ effort: 'x' });
      const r = await w.post(id, 'settings', { effort });
      describeEffort.push({ effort, status: r.status, ...(r.status === 200 ? { note: (w.rows(id, 'note').at(-1)!.data as { text: string }).text } : { error: r.json.error }) });
    }

    const provider = (await loadProviders()).find((p) => p.id === 'claude')!;
    const catalog = createCatalog({ file }).models('anthropic');
    const prices = Object.fromEntries([...provider.models.map((x) => x.id), 'claude-extra-9', 'claude-extra-8'].map((m) => [m, priceFor(provider, catalog, m, 10_000) ?? null]));
    golden('state', { providers, describeModel, describeEffort, prices });
  });

  it('session: the defaults POST /api/sessions answers, and the 400 for another engine', async () => {
    const w = await boot();
    const scrub = (j: Record<string, unknown>) => ({ ...j, id: typeof j.id, cwd: j.cwd === w.cwd ? '<CWD>' : j.cwd, createdAt: typeof j.createdAt, updatedAt: typeof j.updatedAt });
    const plain = await w.api('POST', '/api/sessions', { body: { cwd: w.cwd, engine: 'claude' } });
    const named = await w.api('POST', '/api/sessions', { body: { cwd: w.cwd, engine: 'claude', model: 'claude-opus-5-5', effort: 'max', title: 'T' } });
    const other = await w.api('POST', '/api/sessions', { body: { cwd: w.cwd, engine: 'openai' } });
    const none = await w.api('POST', '/api/sessions', { body: { cwd: w.cwd } });
    golden('session', {
      plain: { status: plain.status, body: scrub(plain.json) },
      named: { status: named.status, body: scrub(named.json) },
      otherEngine: { status: other.status, body: other.json },
      noEngine: { status: none.status, body: none.json },
    });
  });
});

describe('P pins: folder trust', () => {
  const folder = (files: Record<string, string>) => {
    const cwd = tmp();
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true });
      fs.writeFileSync(path.join(cwd, f), text);
    }
    return cwd;
  };
  const SETTINGS = '{"hooks":{}}';

  it('trust-folder: the hash and what adds to it, the files that count, the question and the refusal note', async () => {
    const one = folderHash(folder({ '.claude/settings.json': SETTINGS }))!;
    const two = folderHash(folder({ '.claude/settings.json': SETTINGS, '.claude/settings.local.json': '{}' }))!;
    const three = folderHash(folder({ '.claude/settings.json': SETTINGS, '.claude/settings.local.json': '{}', '.mcp.json': '{"mcpServers":{}}' }))!;
    // Which single files make a folder worth asking about: a name added to the list shows up here.
    const candidates = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', 'CLAUDE.md', '.claude/CLAUDE.md', '.claude.json', '.claude/commands/c.md', '.claude/agents/a.md', '.claude/hooks.json'];
    const counts = Object.fromEntries(candidates.map((c) => [c, folderHash(folder({ [c]: 'x' })) !== undefined]));

    const cwd = folder({ '.claude/settings.json': SETTINGS });
    const store = openStore(':memory:');
    const t = testEngine([{ text: 'ok' }]);
    const row = store.createSession({ id: 's1', cwd, engine: 'claude' });
    const s = openSession({ store, makeEngine: t.makeEngine, dir: tmp(), onRow: () => {} }, row, true);
    s.message('hi');
    const q = await askedQuestion(store, 's1', 'trust');
    s.answer(q.id, 'n');
    await s.idle();
    const data = (type: string) => store.readLog('s1').filter((r) => r.type === type).map((r) => r.data);
    expect(t.opens).toHaveLength(0);
    golden('trust-folder', {
      one: { hash: one.hash, detail: one.detail },
      two: { hash: two.hash, detail: two.detail },
      three: { hash: three.hash, detail: three.detail },
      counts,
      question: { kind: q.kind, prompt: q.prompt, detail: q.detail },
      refusal: { note: data('note'), turnFailed: data('turn_failed') },
    });
    store.close();
  });
});
