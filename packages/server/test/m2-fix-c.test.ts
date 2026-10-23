// M2 fix round, group C (host and loader): the hosts feed `kinds` (M3), a preview never takes a trusted block's name (MINOR 3),
// an `activate` that never settles fails with words (MINOR 11), and a Stop racing an answer is not an error (MINOR 12).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEngine, Run, parseWorkflow, type Step, type Workflow } from '@reins/core';
import { harness } from '../../core/test/m1-harness.js';
import { driveRun, kindVersions, runOptions, type DriveIo } from '../src/drive.js';
import { openSession, type SessionDeps } from '../src/session.js';
import { startRunCli } from '../src/run-cli.js';
import { openStore } from '../src/store.js';
import { askedQuestion } from './http-helpers.js';
import { testEngine } from './test-engine.js';
import { ACTIVATE, loadMods } from '../src/mods/loader.js';
import type { LoadedMod, Mods } from '../src/mods/types.js';
import { tempHome } from './mods-harness.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mods/toy-beep/', import.meta.url));
const beepManifest = () => JSON.parse(fs.readFileSync(path.join(FIXTURE, 'mod.json'), 'utf8')) as Record<string, any>;
const beepCode = () => fs.readFileSync(path.join(FIXTURE, 'index.js'), 'utf8');

let h: ReturnType<typeof tempHome>;
const loaded: Mods[] = [];
beforeEach(() => { h = tempHome(); });
afterEach(() => {
  for (const m of loaded.splice(0).reverse()) m.dispose();
  h.cleanup();
});
const load = async (trusted: (id: string) => boolean = () => true) => {
  const m = await loadMods({ bundledDir: path.join(h.home, 'no-bundled'), userDir: h.modsDir, home: h.home, disabled: new Set(), trusted: (id) => trusted(id), env: {} });
  loaded.push(m);
  return m;
};
const find = (m: Mods, id: string) => m.mods.find((x) => x.id === id) as LoadedMod;
const noIo: DriveIo = { ask: async () => null, say: () => {}, write: () => {} };

const text = '---\nreins: 1\nname: toy\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n## beep\ntimes: 2\n\n## phase one\n> go\n';

describe('M3: the hosts feed RunOptions.kinds', () => {
  it('kindVersions lists loaded, enabled mods of the three kinds by id, and nothing with a problem', async () => {
    h.writeMod('toy-beep', beepManifest(), { 'index.js': beepCode() });
    h.writeMod('untrusted-beep', { ...beepManifest(), id: 'untrusted-beep', version: '9', provides: { kinds: ['zz'], ops: ['BEEP'], attrs: ['times'], events: ['beeped'] }, view: { ...beepManifest().view, kind: 'zz' } }, { 'index.js': beepCode() });
    const mods = await load((id) => id === 'toy-beep');
    expect(find(mods, 'untrusted-beep').problems.length).toBeGreaterThan(0);
    expect(kindVersions(mods)).toEqual({ 'toy-beep': '1.0.0' });
    expect(kindVersions({ mods: [{ ...find(mods, 'toy-beep'), enabled: false }] })).toEqual({});
    expect(kindVersions({ mods: [{ ...find(mods, 'toy-beep'), kind: 'provider' }] })).toEqual({});
  });

  it('runOptions passes kinds on, and leaves the key out when the host gave none', () => {
    const base = { workflow: parseWorkflow(text).workflow!, engine: new FakeEngine(), cwd: h.home, resolveBlock: () => undefined, onEvent: () => {} };
    expect(runOptions(noIo, { ...base, kinds: { a: '1' } }).kinds).toEqual({ a: '1' });
    expect(runOptions(noIo, base)).not.toHaveProperty('kinds');
  });

  it('a run that used a mod block, saved, then restored after that mod changed version, pauses with "saved with other blocks"', async () => {
    h.writeMod('toy-beep', beepManifest(), { 'index.js': beepCode() });
    const first = await load();
    const w = parseWorkflow(text).workflow!;
    const opts = (m: Mods) => runOptions(noIo, { workflow: w, engine: harness('beep', [{ text: 'ok\nREINS: done' }]).engine, cwd: h.home, resolveBlock: () => undefined, onEvent: () => {}, kinds: kindVersions(m) });
    const run = new Run(opts(first));
    expect(run.status).toBe('running');
    const snapshot = JSON.parse(JSON.stringify(run.snapshot()));
    expect(snapshot.kinds).toEqual({ 'toy-beep': '1.0.0' });
    expect(snapshot).toHaveProperty('programHash'); // written although no track ever existed

    const same = Run.restore(snapshot, opts(first));
    expect(same.status).toBe('running');

    first.dispose();
    loaded.pop();
    h.writeMod('toy-beep', { ...beepManifest(), version: '1.1.0' }, { 'index.js': beepCode() });
    const second = await load();
    expect(kindVersions(second)).toEqual({ 'toy-beep': '1.1.0' });
    const back = Run.restore(snapshot, opts(second));
    expect(back.status).toBe('paused');
    expect(back.pauseReason?.text).toContain('saved with other blocks (toy-beep)');
  });
});

describe('MINOR 3: an untrusted preview cannot knock a trusted block out of block-view', () => {
  it('a-squat (untrusted, view.kind beep) loads before toy-beep (trusted); toy-beep still activates and owns the view', async () => {
    const squat = { ...beepManifest(), id: 'a-squat', provides: { kinds: ['beep'], ops: ['SQUAT'], attrs: ['times'], events: [] }, view: { ...beepManifest().view, card: { label: 'squat', section: 'Flow' } } };
    h.writeMod('a-squat', squat, { 'index.js': 'export default function () {}' });
    h.writeMod('toy-beep', beepManifest(), { 'index.js': beepCode() });
    const mods = await load((id) => id === 'toy-beep');
    expect(find(mods, 'toy-beep').problems).toEqual([]);
    expect(mods.registry.get('block', 'toy-beep')).toBeDefined();
    expect(mods.registry.get('block-view', 'beep')).toEqual(beepManifest().view);
    // The squatter says why its view is not shown, and does not run.
    expect(find(mods, 'a-squat').problems.join('\n')).toMatch(/needs trust/);
    expect(find(mods, 'a-squat').problems.join('\n')).toMatch(/view is not shown/);
  });

  it('an untrusted preview of a name nobody else provides is still shown (the import preview keeps working)', async () => {
    h.writeMod('a-squat', { ...beepManifest(), id: 'a-squat' }, { 'index.js': beepCode() });
    const mods = await load(() => false);
    expect(mods.registry.get('block-view', 'beep')).toEqual(beepManifest().view);
    expect(find(mods, 'a-squat').problems.join('\n')).not.toMatch(/not shown/);
  });
});

describe('MINOR 11: an activate that never settles', () => {
  let was: number;
  beforeEach(() => { was = ACTIVATE.ms; ACTIVATE.ms = 150; });
  afterEach(() => { ACTIVATE.ms = was; });

  it('fails that mod with words, takes back what it registered, and the load returns', async () => {
    h.writeMod('stuck', { ...beepManifest(), id: 'stuck' }, {
      'index.js': beepCode().replace(/export default function activate\(api\) \{\s*api\.registerBlock\(beep\);\s*\}/, 'export default function activate(api) { api.registerBlock(beep); return new Promise(() => {}); }'),
    });
    h.writeMod('ok-beep', { ...beepManifest(), id: 'ok-beep', provides: { kinds: ['other'], ops: ['OTHER'], attrs: [], events: [] }, view: { kind: 'other', order: 141, colour: 'soft', fields: [], line: ['other'], card: { label: 'other', section: 'Flow' } } },
      { 'index.js': 'export default function () {}' });
    const started = Date.now();
    const mods = await load();
    expect(Date.now() - started).toBeLessThan(5000);
    const stuck = find(mods, 'stuck');
    expect(stuck.problems.join('\n')).toMatch(/did not finish starting within/);
    expect(mods.registry.get('block', 'stuck')).toBeUndefined();
    expect(mods.registry.get('block-view', 'beep')).toBeUndefined();
    // The next mod still loads.
    expect(find(mods, 'ok-beep')).toBeDefined();
  });

  it('a mod that settles in time is not touched by the limit, and its late api use is still refused', async () => {
    h.writeMod('toy-beep', beepManifest(), { 'index.js': beepCode() });
    const mods = await load();
    expect(find(mods, 'toy-beep').problems).toEqual([]);
  });
});

describe('MINOR 12: Stop racing an answer', () => {
  const step = (id: string, kind: Step['kind'], over: Partial<Step> = {}): Step => ({ id, kind, attrs: {}, cards: [], links: [], ...over });
  const wf = (): Workflow => ({ version: 1, name: 't', budget: { turns: 20, minutes: 20 }, always: [], steps: [step('g', 'gate', { cond: { t: 'approve' } }), step('a', 'phase', { title: 'a', prompt: 'do it' })], autos: [] });

  it('requestChanges that throws because Stop landed first is not an error of the run', async () => {
    const run = new Run({ workflow: wf(), engine: new FakeEngine() });
    run.requestChanges = async () => { await run.stop(); throw new Error('closed'); };
    const said: string[] = [];
    const r = await driveRun(run, { ask: async () => 'changes redo it', say: (l) => said.push(l), write: () => {} }, () => {});
    expect(run.status).toBe('stopped');
    expect(r).toEqual({ result: 'finished' });
    expect(said.filter((l) => l.startsWith('Ã¢Å“â€”'))).toEqual([]);
  });

  it('the same throw with the run NOT stopped is still an error', async () => {
    const run = new Run({ workflow: wf(), engine: new FakeEngine() });
    run.requestChanges = async () => { throw new Error('boom'); };
    const r = await driveRun(run, { ask: async () => 'changes redo it', say: () => {}, write: () => {} }, () => {});
    expect(r).toEqual({ result: 'detached', error: 'boom' });
  });
});

describe('M3: a session saves the kinds of a run it starts and of one it resumes', () => {
  it('deps.kinds is read at each start: the first snapshot has it, a resume after a change saves the new one', async () => {
    const store = openStore(':memory:');
    const t = testEngine([{ text: 'ok\nREINS: done' }, { text: 'ok\nREINS: done' }]);
    const cwd = h.home;
    const row = store.createSession({ id: 's1', cwd, engine: 'claude-code' });
    let kinds: Record<string, string> = { 'toy-beep': '1.0.0' };
    const deps: SessionDeps = { store, makeEngine: t.makeEngine, dir: h.home, kinds: () => kinds };
    const s = openSession(deps, row, true);
    const file = path.join(cwd, 'w.reins.md');
    fs.writeFileSync(file, '---\nreins: 1\nname: w\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n## phase a\n> go\n\n## gate\nid: g\nuntil: you approve\n\n## end\n');
    expect(s.runFile(file)).toEqual({ ok: true });
    s.answer((await askedQuestion(store, 's1', 'trust')).id, 'y');
    await askedQuestion(store, 's1', 'gate');
    await s.shutdown();
    const runId = store.readLog('s1').find((r) => r.type === 'run_started')!.runId!;
    expect(store.loadRun(runId)!.snapshot!.kinds).toEqual({ 'toy-beep': '1.0.0' });

    kinds = { 'toy-beep': '2.0.0' };
    const s2 = openSession(deps, store.getSession('s1')!);
    expect(s2.resume(runId)).toEqual({ ok: true });
    await askedQuestion(store, 's1', 'gate');
    expect(store.loadRun(runId)!.snapshot!.kinds).toEqual({ 'toy-beep': '2.0.0' });
    await s2.shutdown();
    store.close();
  });
});
describe('M3: reins run saves the kinds it was given', () => {
  it('startRunCli passes kinds, and the saved snapshot has them', async () => {
    const store = openStore(':memory:');
    const t = testEngine([{ text: 'ok\nREINS: done' }]);
    const file = path.join(h.home, 'w.reins.md');
    fs.writeFileSync(file, '---\nreins: 1\nname: w\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n## phase a\n> go\n');
    const res = await startRunCli({ file, cwd: h.home, input: new PassThrough(), output: new PassThrough(), store, makeEngine: (io) => t.makeEngine({ provider: 'test', ...io }), kinds: { 'toy-beep': '3.0.0' } }).done;
    expect(res.status).toBe('done');
    expect(store.loadRun(res.runId)!.snapshot!.kinds).toEqual({ 'toy-beep': '3.0.0' });
    store.close();
  });
});

describe('MINOR 11: the limit leaves no timer behind', () => {
  it('a load whose mods settle in time has no pending timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      h.writeMod('toy-beep', beepManifest(), { 'index.js': beepCode() });
      const mods = await load();
      expect(find(mods, 'toy-beep').problems).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});