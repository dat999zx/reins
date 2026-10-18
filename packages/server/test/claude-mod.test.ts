// Milestone P, task 5: the Claude CLI is two bundled mods (protocol `claude-code-cli`, provider `claude`) and the server starts through the registry.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUNDLED_MODS, folderTrustFrom, makeEngineFrom, probeFrom, providerViews, startMods } from '../src/engines.js';
import { loadMods } from '../src/mods/loader.js';
import type { Mods } from '../src/mods/types.js';
import { openSession } from '../src/session.js';
import { openStore } from '../src/store.js';
import { FAKE_CLAUDE, fakeSetup, until } from './helpers.js';
import { openQuestions } from './http-helpers.js';
import { tempHome } from './mods-harness.js';
import { testEngine } from './test-engine.js';

const tmps: string[] = [];
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-cmod-'))); tmps.push(d); return d; };
const homes: Array<ReturnType<typeof tempHome>> = [];
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  for (const h of homes.splice(0)) h.cleanup();
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const start = async (env: NodeJS.ProcessEnv = {}) => {
  const mods = await startMods({ dir: tmp(), env });
  disposers.push(() => mods.dispose());
  return mods;
};
const claudeFolder = () => {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, '.claude'));
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), '{"hooks":{}}');
  return cwd;
};

describe('the claude mods', () => {
  it('the registry has the protocol claude-code-cli and the provider claude after start, with no problems', async () => {
    const mods = await start();
    expect(mods.problems).toEqual([]);
    expect(mods.mods.map((m) => [m.id, m.kind, m.source, m.problems])).toEqual([
      ['claude-code-cli', 'protocol', 'bundled', []],
      ['claude-code', 'provider', 'bundled', []],
    ]);
    expect(mods.registry.has('protocol-impl', 'claude-code-cli')).toBe(true);
    expect(mods.registry.has('provider', 'claude-code')).toBe(true);
  });

  it('finds the claude provider with its models, and every provider has a default model and a default level that it lists', async () => {
    const views = providerViews(await start());
    expect(views.find((p) => p.id === 'claude-code')?.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']);
    expect(views.length).toBeGreaterThan(0);
    for (const p of views) {
      expect(p.models.map((m) => m.id), p.id).toContain(p.defaultModel);
      expect(p.efforts.map((e) => e.id), p.id).toContain(p.defaultEffort);
    }
    expect(views.find((p) => p.id === 'claude-code')!.efforts.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('the probe and the engine find the CLI through the INJECTED env, never the real one (PATH is empty here)', async () => {
    fakeSetup([]);
    const env = { REINS_CLAUDE: FAKE_CLAUDE, PATH: '' };
    const mods = await start(env);
    const host = { env, home: tmp() };
    expect(await probeFrom(mods, 'claude-code', host)).toMatchObject({ installed: true, version: '2.1.281', loggedIn: true });
    const engine = makeEngineFrom(mods, host)({ provider: 'claude-code', onApprove: async () => ({ behavior: 'allow' }), onLive: () => {} });
    expect(await engine.probe()).toMatchObject({ installed: true, version: '2.1.281' });
  }, 60_000);

  it('makeEngine is synchronous: it returns the engine itself, not a promise', async () => {
    const mods = await start({ REINS_CLAUDE: FAKE_CLAUDE, PATH: '' });
    const made = makeEngineFrom(mods, { env: { REINS_CLAUDE: FAKE_CLAUDE, PATH: '' }, home: tmp() })({ provider: 'claude-code', onApprove: async () => ({ behavior: 'allow' }), onLive: () => {} });
    expect(made).not.toBeInstanceOf(Promise);
    expect(made.id).toBe('claude');
    expect(typeof made.open).toBe('function');
  });
});

describe('folder trust follows the protocol of the engine being opened', () => {
  const NO_FOLDER = `export default function (api) { api.registerProtocol({ id: 'no-folder', conversation: 'own',
    capabilities: { midTurnSteer: 'none', preToolDeny: false, resume: false }, engine() { throw new Error('unused'); } }); }\n`;

  /** The bundled mods plus a test protocol with no folderTrust and a provider `loopy` on it. */
  async function withLoopy(): Promise<Mods> {
    const h = tempHome();
    homes.push(h);
    h.writeMod('no-folder', { reins: 1, id: 'no-folder', kind: 'protocol', version: '1.0.0', label: 'No folder', main: 'index.js' }, { 'index.js': NO_FOLDER });
    h.writeMod('loopy', { reins: 1, id: 'loopy', kind: 'provider', version: '1.0.0', label: 'Loopy', protocol: 'no-folder', baseUrl: 'http://127.0.0.1:1', defaultModel: 'm', models: [{ id: 'm' }] });
    const mods = await loadMods({ bundledDir: BUNDLED_MODS, userDir: h.modsDir, home: h.home, disabled: new Set(), trusted: () => true, env: {} });
    disposers.push(() => mods.dispose());
    expect(mods.mods.flatMap((m) => m.problems)).toEqual([]);
    return mods;
  }

  const sessionOn = (mods: Mods, provider: string, cwd: string, extra: Record<string, unknown> = {}) => {
    const store = openStore(':memory:');
    const t = testEngine([{ text: 'ok' }]);
    const row = store.createSession({ id: 's1', cwd, engine: provider });
    const s = openSession({ store, makeEngine: t.makeEngine, folderTrust: folderTrustFrom(mods), dir: tmp(), ...extra }, row, true);
    return { store, t, s, asked: () => openQuestions(store.readLog('s1')) };
  };

  it('a test protocol with no folderTrust asks no folder question, in a folder that has .claude settings', async () => {
    const x = sessionOn(await withLoopy(), 'loopy', claudeFolder());
    x.s.message('hi');
    await x.s.idle();
    expect(x.t.opens).toHaveLength(1);
    expect(x.store.readLog('s1').filter((r) => r.type === 'question')).toEqual([]);
    x.store.close();
  });

  it('the claude provider in the same folder does ask (the control for the test above)', async () => {
    const x = sessionOn(await start(), 'claude-code', claudeFolder());
    x.s.message('hi');
    await until(() => x.asked().some((q) => q.kind === 'trust'), 5000);
    expect(x.t.opens).toHaveLength(0);
    x.s.answer(x.asked()[0]!.id, 'n');
    await x.s.idle();
    x.store.close();
  });

  it('S4: a CLI subagent opened from a session whose main engine is a loopy provider STILL asks the folder question', async () => {
    const x = sessionOn(await withLoopy(), 'loopy', claudeFolder(), { subagentProvider: () => 'claude-code', describeModel: (_e: string, m: string) => ({ listed: true, label: m }) });
    const wf = '---\nreins: 1\nname: sub\nbudget: { turns: 10, minutes: 10, usd: 2.00 }\nalways: []\n---\n\n## subagent research\nmodel: model-h\n> Look.\n';
    const file = path.join(x.store.getSession('s1')!.cwd, 'w.reins.md');
    fs.writeFileSync(file, wf);
    expect(x.s.runFile(file)).toEqual({ ok: true });
    await until(() => x.asked().some((q) => q.kind === 'trust'), 5000); // the workflow file's own question
    x.s.answer(x.asked().find((q) => q.kind === 'trust')!.id, 'y');
    await until(() => x.asked().some((q) => q.kind === 'trust' && q.prompt.startsWith('This folder has Claude settings')), 5000);
    expect(x.t.opens).toHaveLength(0);
    x.s.answer(x.asked().find((q) => q.kind === 'trust')!.id, 'n');
    await until(() => x.asked().some((q) => q.kind === 'resume'), 5000);
    x.s.answer(x.asked().find((q) => q.kind === 'resume')!.id, 'stop');
    await x.s.idle();
    expect(x.t.opens).toHaveLength(0);
    x.store.close();
  });
});
