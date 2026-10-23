// M3 Task 8 (group W): the 11 conditions and the 3 cards are pack mods (packages/server/src/mods/cond-* and card-*), one folder each. What the generic
// `pack-mods.test.ts` cannot see (it reads `provides.kinds`) is pinned here: each is loaded, in core in its manifest order, and served from its manifest; switched off it
// is gone after a restart; the parser answers a pack atom's complaint at once while a user atom still waits; a Customize copy edits the words and the editor data;
// a name the pack holds is not a user mod's, and is free once the pack mod is off; and `api.core` holds exactly the helpers the mods need.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { CARDS, CONDS, parseCond, parseWorkflow, printCond, registerCondition, type CondType } from '@reins/core';
import { BUNDLED_MODS, startMods } from '../src/engines.js';
import { customizeMod, setEnabled, trustMod, type ModEnv } from '../src/mods/actions.js';
import { HOLDERS } from '../src/mods/kinds.js';
import { servedKinds } from '../src/mods/kinds-view.js';
import { hashFiles, loadMods, readFolder } from '../src/mods/loader.js';
import type { Mods } from '../src/mods/types.js';
import { PACK_DIR, packMods } from '../../core/test/pack.js';
import { tempHome } from './mods-harness.js';

const mine = packMods(PACK_DIR).filter((p) => ['condition', 'card'].includes((p.manifest as { kind?: string }).kind ?? '')) as unknown as Array<{ id: string; dir: string; manifest: Record<string, any> }>;
const conds = mine.filter((p) => p.manifest.kind === 'condition');
const cards = mine.filter((p) => p.manifest.kind === 'card');
const SAMPLE: Record<string, string> = {
  approve: 'you approve', tests: 'tests pass', cmd: '`x` passes', llm: 'llm says "q"', review: 'reviewer approves', done: 'agent says done', diff: 'diff > 3 lines',
  touches: 'touches a/**', attempts: 'attempts > 2', same: 'same error twice', drift: 'drift',
};

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });
const rm = (d: string) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the OS */ } };
const scratch = (): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-w-')));
  cleanups.push(() => rm(d));
  return d;
};
function envOf(home: string, mods: () => Mods): ModEnv {
  return {
    home, catalogDir: path.join(home, 'no-catalog'), get mods() { return mods(); }, consent: { has: () => false, grant: () => {}, revoke: () => {} } as never,
    send: async () => new Response(''), env: {}, redact: (t: string) => t, holdsSecret: () => false,
  };
}
async function start(home: string, bundledDir?: string): Promise<Mods> {
  const mods = await startMods({ dir: home, env: {}, ...(bundledDir ? { bundledDir } : {}) });
  cleanups.push(() => mods.dispose());
  return mods;
}
/** One pack folder compiled file by file, the way the build leaves it. */
function build(folder: string, out: string): void {
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(folder)) {
    const text = fs.readFileSync(path.join(folder, f), 'utf8');
    if (f.endsWith('.ts')) fs.writeFileSync(path.join(out, f.replace(/\.ts$/, '.js')), ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true } }).outputText);
    else fs.writeFileSync(path.join(out, f), text);
  }
}

describe('the 11 conditions and 3 cards are pack mods', () => {
  it('there are 11 condition folders and 3 card folders, one name each, with the numbers core used (10 to 110, 10 to 30)', () => {
    expect(conds.map((p) => p.manifest.provides.conditions)).toEqual([['approve'], ['attempts'], ['cmd'], ['diff'], ['done'], ['drift'], ['llm'], ['review'], ['same'], ['tests'], ['touches']]);
    expect(Object.fromEntries(conds.map((p) => [p.manifest.provides.conditions[0], p.manifest.order]))).toEqual({ approve: 10, tests: 20, cmd: 30, llm: 40, review: 50, done: 60, diff: 70, touches: 80, attempts: 90, same: 100, drift: 110 });
    expect(Object.fromEntries(cards.map((p) => [p.manifest.provides.cards[0], p.manifest.order]))).toEqual({ guard: 10, now: 20, stop: 30 });
    expect(mine.map((p) => p.id)).toEqual(mine.map((p) => `${p.manifest.kind === 'condition' ? 'cond' : 'card'}-${p.manifest.provides[p.manifest.kind === 'condition' ? 'conditions' : 'cards'][0]}`));
  });

  it('none is required (a user may switch each one off); each is bundled, trusted and quiet; core holds them in manifest order; the editor data is the manifest\'s', async () => {
    const h = tempHome();
    cleanups.push(() => h.cleanup());
    const mods = await start(h.home);
    expect(mods.problems).toEqual([]);
    for (const p of mine) {
      expect(p.manifest.required, p.id).toBeUndefined();
      expect(mods.mods.find((m) => m.id === p.id), p.id).toMatchObject({ source: 'bundled', trusted: true, enabled: true, problems: [], pack: 'default' });
    }
    expect([...CONDS.keys()]).toEqual(conds.map((p) => p.manifest).sort((a, b) => a.order - b.order).map((m) => m.provides.conditions[0]));
    expect([...CARDS.keys()]).toEqual(cards.map((p) => p.manifest).sort((a, b) => a.order - b.order).map((m) => m.provides.cards[0]));
    const s = servedKinds(mods);
    expect(s.conds).toEqual(conds.map((p) => p.manifest).sort((a, b) => a.order - b.order).map((m) => ({ ...m.view[m.provides.conditions[0]], t: m.provides.conditions[0] })));
    expect(s.cards).toEqual([{ ...cards[0]!.manifest.view.guard, kind: 'guard' }]); // now and stop have no panel words, so the panel does not offer them
    expect(s.problems).toEqual([]);
  });

  it('a pack mod keeps the hooks its callers read: sameAsRun on tests and cmd, globs on touches, modelCall on llm and review, needsTestCmd on tests, commands on none', async () => {
    const h = tempHome();
    cleanups.push(() => h.cleanup());
    await start(h.home);
    const has = (hook: string) => [...CONDS.values()].filter((c) => (c as unknown as Record<string, unknown>)[hook]).map((c) => c.t).sort();
    expect(has('sameAsRun')).toEqual(['cmd', 'tests']);
    expect(has('globs')).toEqual(['touches']);
    expect(has('modelCall')).toEqual(['llm', 'review']);
    expect(has('needsTestCmd')).toEqual(['tests']);
    expect(has('view')).toEqual([]); // the loader takes any `view` out of code: the editor data is the manifest's only
  });
});

describe('switched off, each is gone after a restart', () => {
  for (const p of mine) {
    it(`${p.id}`, async () => {
      const h = tempHome();
      cleanups.push(() => h.cleanup());
      let mods = await start(h.home);
      const name = p.manifest.kind === 'condition' ? p.manifest.provides.conditions[0] : p.manifest.provides.cards[0];
      const core = p.manifest.kind === 'condition' ? CONDS : CARDS;
      expect(core.has(name)).toBe(true);
      const r = await setEnabled(envOf(h.home, () => mods), p.id, false);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      mods.dispose();
      mods = await start(h.home);
      expect(core.has(name)).toBe(false);
      const served = servedKinds(mods);
      expect(served.conds.some((c) => c.t === name) || served.cards.some((c) => c.kind === name)).toBe(false);
      if (p.manifest.kind === 'condition') expect(parseCond(SAMPLE[name]!).diag?.message).toMatch(/^Unexpected condition token|^Expected|^Unterminated/);
      else {
        const text = `---\nreins: 1\nname: t\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n## phase one\n${name}: some/**\n> go\n`;
        expect(parseWorkflow(text).workflow?.steps[0]?.cards.map((c) => c.kind)).toEqual([]);
      }
    });
  }
});

describe('the parser answers a pack atom\'s complaint at once; a user atom\'s waits', () => {
  const later: CondType = { t: 'attemptsish', parse(s) { if (!s.src.startsWith('attempts', s.idx)) return null; s.idx = s.len; return { t: 'attemptsish' } as never; }, print: () => 'attemptsish', judge: 'agent' };

  it('"attempts > x" is the pack atom\'s error although a later user atom would take the text', async () => {
    const h = tempHome();
    cleanups.push(() => h.cleanup());
    await start(h.home);
    const off = registerCondition(later, 500);
    cleanups.push(off);
    expect(parseCond('attempts > x').diag?.message).toBe('Expected integer after "attempts >"');
    expect(parseCond('attempts > 3').cond).toEqual({ t: 'attempts', n: 3 });
  });

  it('a Customize copy of the atom is answered the same way', async () => {
    const root = scratch();
    const bundled = path.join(root, 'bundled');
    build(path.join(PACK_DIR, 'cond-attempts'), path.join(bundled, 'cond-attempts'));
    const home = path.join(root, '.reins');
    fs.mkdirSync(home, { recursive: true });
    let mods = await start(home, bundled);
    expect((await customizeMod(envOf(home, () => mods), 'cond-attempts', { trust: true })).status).toBe(200);
    mods.dispose();
    mods = await start(home, bundled);
    expect(mods.mods.find((m) => m.id === 'cond-attempts')).toMatchObject({ source: 'user', replaces: 'bundled', pack: 'default', problems: [] });
    cleanups.push(registerCondition(later, 500));
    expect(parseCond('attempts > x').diag?.message).toBe('Expected integer after "attempts >"');
  });
});

describe('Customize: the words and the editor data of a condition are the user\'s to change', () => {
  it('a copy of cond-tests with another print and another label: after the restart the print and the served label are the copy\'s', async () => {
    const root = scratch();
    const bundled = path.join(root, 'bundled');
    build(path.join(PACK_DIR, 'cond-tests'), path.join(bundled, 'cond-tests'));
    const home = path.join(root, '.reins');
    fs.mkdirSync(home, { recursive: true });
    let mods = await start(home, bundled);
    expect(printCond({ t: 'tests' } as never)).toBe('tests pass');
    expect((await customizeMod(envOf(home, () => mods), 'cond-tests', { trust: true })).status).toBe(200);
    const dir = path.join(home, 'mods', 'cond-tests');
    fs.writeFileSync(path.join(dir, 'index.js'), fs.readFileSync(path.join(dir, 'index.js'), 'utf8').replace("print() { return 'tests pass'; }", "print() { return 'tests pass.'; }"));
    const man = JSON.parse(fs.readFileSync(path.join(dir, 'mod.json'), 'utf8'));
    man.view.tests.label = 'the suite is green';
    fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify(man, null, 2));
    mods.dispose();
    // The edit changed the code, so it needs a yes again (a changed file is untrusted); the user gives it.
    mods = await start(home, bundled);
    const trust = await trustMod(envOf(home, () => mods), 'cond-tests', { hash: hashFiles(readFolder(dir, 'cond-tests')) });
    expect(trust.status, JSON.stringify(trust.body)).toBe(200);
    mods.dispose();
    mods = await start(home, bundled);
    expect(mods.mods.find((m) => m.id === 'cond-tests')).toMatchObject({ source: 'user', replaces: 'bundled', problems: [] });
    expect(printCond({ t: 'tests' } as never)).toBe('tests pass.');
    expect(servedKinds(mods).conds.find((c) => c.t === 'tests')?.label).toBe('the suite is green');
    expect(parseCond('tests pass').cond).toEqual({ t: 'tests' });
  });
});

describe('a name the pack holds', () => {
  const writeUserAtom = (h: ReturnType<typeof tempHome>, id: string, t: string) => h.writeMod(id, { reins: 1, id, kind: 'condition', version: '1.0.0', label: id, main: 'index.js', order: 5, provides: { conditions: [t] } }, {
    'index.js': `export default function activate(api) { api.registerCondition({ t: ${JSON.stringify(t)}, parse(s) { if (!s.src.startsWith('tests pass', s.idx)) return null; s.idx += 10; return { t: ${JSON.stringify(t)} }; }, print: () => 'tests pass', judge: 'agent', evalSync: () => true }); }\n`,
  });
  const load = async (h: ReturnType<typeof tempHome>, disabled: string[] = []) => {
    const mods = await loadMods({ bundledDir: BUNDLED_MODS, userDir: h.modsDir, home: h.home, disabled: new Set(disabled), env: {}, trusted: () => true });
    cleanups.push(() => mods.dispose());
    return mods;
  };

  it('is not a user mod\'s: refused in words while the pack mod is on; its own manifest read again is fine', async () => {
    const h = tempHome();
    cleanups.push(() => h.cleanup());
    writeUserAtom(h, 'my-tests', 'tests');
    const mods = await load(h);
    expect(mods.mods.find((m) => m.id === 'my-tests')?.problems.join(' ')).toMatch(/`provides\.conditions` lists `tests`, which Reins already has\. A mod cannot cover it\./);
    expect(HOLDERS.get('conditions:tests')).toBe('cond-tests');
    expect(mods.mods.find((m) => m.id === 'cond-tests')).toMatchObject({ problems: [] });
  });

  it('is free once the pack mod is switched off: a user mod brings its own atom of that name', async () => {
    const h = tempHome();
    cleanups.push(() => h.cleanup());
    writeUserAtom(h, 'my-tests', 'tests');
    const mods = await load(h, ['cond-tests']);
    expect(mods.mods.find((m) => m.id === 'my-tests')).toMatchObject({ problems: [], enabled: true });
    expect(HOLDERS.get('conditions:tests')).toBe('my-tests');
    expect(parseCond('tests pass').cond).toEqual({ t: 'tests' });
  });

  it('the holder is written down with the entry and taken out with it', async () => {
    const h = tempHome();
    const mods = await load(h);
    expect([...HOLDERS.keys()].filter((k) => k.startsWith('conditions:')).length).toBe(11);
    expect([...HOLDERS.keys()].filter((k) => k.startsWith('cards:')).length).toBe(3);
    mods.dispose();
    h.cleanup();
    expect([...HOLDERS.keys()]).toEqual([]);
    expect(CONDS.size + CARDS.size).toBe(0);
  });
});

describe('api.core holds what the mods need and nothing else', () => {
  it('the helpers the touches, drift and guard mods take come from api.core, and no mod of the group imports anything outside its folder', () => {
    const src = (id: string) => fs.readFileSync(path.join(fileURLToPath(new URL('../src/mods/', import.meta.url)), id, 'index.ts'), 'utf8');
    expect(src('cond-touches')).toContain('api.core');
    expect(src('cond-drift')).toContain('api.core');
    expect(src('card-guard')).toContain('api.core');
    for (const p of mine) expect(src(p.id), p.id).not.toMatch(/from\s*['"](?!\.\.\/types\.js|@reins\/core)/);
  });
});
