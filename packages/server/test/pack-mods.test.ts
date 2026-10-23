// M3 Task 3: the checks EVERY mod of the default pack must pass, written once over the pack folder (a folder under packages/server/src/mods/ whose mod.json
// says "pack": "default"). Tasks 4 to 8 add folders and nothing here changes. Pinned for each pack mod:
//  - the manifest has the shape the loader and the pack machinery need;
//  - it is bundled, trusted, read from its own folder (never copied to the code cache), with no problem line, and its kinds sit in core at the manifest `order`;
//  - its folder BUILDS flat: the compiled files are plain text, no folder, no `.d.ts`, no `.map`, within Customize's limits (50 files, 1 MB);
//  - Customize works from that built folder: the copy is made, the restart runs it from the cache, and it replaces the built-in;
//  - switched off, a pack mod's kinds are gone from core (`Unknown step kind`), unless it is required: then the off switch is refused and the mod stays on.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { NODES, parseWorkflow, validate } from '@reins/core';
import { startMods } from '../src/engines.js';
import { customizeMod, setEnabled, type ModEnv } from '../src/mods/actions.js';
import type { Mods } from '../src/mods/types.js';
import { PACK_DIR, packMods, packProblems } from '../../core/test/pack.js';
import { loadPack } from './pack-helper.js';
import { tempHome } from './mods-harness.js';

const MODS_DIR = fileURLToPath(new URL('../src/mods/', import.meta.url));
const packs = packMods(PACK_DIR);
const REQUIRED = ['end', 'phase'];
const MAX_FILES = 50;
const MAX_BYTES = 1024 * 1024;
const rm = (d: string) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the OS */ } };

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });
const scratch = (): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-packmods-')));
  cleanups.push(() => rm(d));
  return d;
};

/** What `tsc` makes of one pack folder: each `.ts` file compiled alone to `.js` (the folder has no import that leaves it), `mod.json` copied. */
function build(folder: string, out: string): string[] {
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(folder)) {
    const text = fs.readFileSync(path.join(folder, f), 'utf8');
    if (f.endsWith('.d.ts')) continue;
    if (f.endsWith('.ts')) {
      const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true } }).outputText;
      fs.writeFileSync(path.join(out, f.replace(/\.ts$/, '.js')), js);
    } else fs.writeFileSync(path.join(out, f), text);
  }
  return fs.readdirSync(out).sort();
}

const wf = (kind: string) => `---\nreins: 1\nname: t\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n## ${kind}\n> go\n`;
const unknownKind = (kind: string): boolean => {
  const p = parseWorkflow(wf(kind));
  return [...p.diagnostics, ...(p.workflow ? validate(p.workflow) : [])].some((d) => d.message === `Unknown step kind "${kind}"`);
};
const kindsOf = (m: { manifest: Record<string, any> }): string[] => m.manifest.provides?.kinds ?? [];

describe('the default pack: what every pack mod must be', () => {
  it('the pack is found by "pack": "default" in mod.json, not by a list, and holds say, phase and end', () => {
    expect(packs.map((p) => p.id)).toEqual(expect.arrayContaining(['say', 'phase', 'end']));
    const scanned = fs.readdirSync(MODS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(MODS_DIR, d.name, 'mod.json')) && JSON.parse(fs.readFileSync(path.join(MODS_DIR, d.name, 'mod.json'), 'utf8')).pack === 'default')
      .map((d) => d.name).sort();
    expect(packs.map((p) => p.id)).toEqual(scanned);
  });

  it('only end and phase are required', () => {
    expect(packs.filter((p) => (p.manifest as { required?: unknown }).required === true).map((p) => p.id).sort()).toEqual(REQUIRED);
    expect(packs.filter((p) => 'required' in p.manifest && (p.manifest as { required?: unknown }).required !== true)).toEqual([]);
  });

  for (const p of packs) {
    describe(`pack mod ${p.id}`, () => {
      const m = p.manifest as Record<string, any>;

      it('has the manifest the machinery needs', () => {
        expect(m).toMatchObject({ reins: 1, id: p.id, main: 'index.js', pack: 'default' });
        expect(['block', 'condition', 'card']).toContain(m.kind);
        expect(typeof m.version).toBe('string');
        expect(typeof m.label).toBe('string');
        expect(Number.isFinite(m.order)).toBe(true);
        expect(Object.keys(m.provides ?? {}).length).toBeGreaterThan(0);
        if (m.kind === 'block') expect(m.view?.kind).toBe(m.provides.kinds[0]);
        expect(fs.existsSync(path.join(p.dir, 'index.ts'))).toBe(true);
      });

      it('has a source folder with no folder in it and no import that leaves it', () => {
        expect(packProblems(p.dir)).toEqual([]);
      });

      it('builds flat: plain text files only, no folder, no .d.ts, no .map, within Customize\'s limits, and `main` is one of them', () => {
        const out = path.join(scratch(), p.id);
        const files = build(p.dir, out);
        expect(files).toContain('mod.json');
        expect(files).toContain(m.main);
        expect(files.length).toBeLessThanOrEqual(MAX_FILES);
        let bytes = 0;
        for (const f of files) {
          const st = fs.lstatSync(path.join(out, f));
          expect(st.isFile(), f).toBe(true);
          expect(f, f).not.toMatch(/\.(d\.ts|map)$/);
          expect(f, f).toMatch(/^[A-Za-z0-9._-]+\.(js|json)$/);
          bytes += st.size;
          // text that decodes as strict UTF-8 with no NUL
          expect(() => new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(path.join(out, f))), f).not.toThrow();
          expect(fs.readFileSync(path.join(out, f)).includes(0), f).toBe(false);
        }
        expect(bytes).toBeLessThanOrEqual(MAX_BYTES);
        expect(packProblems(out)).toEqual([]);
      });
    });
  }
});

describe('the default pack, started by the real loader in a temp home', () => {
  it('every pack mod is bundled, trusted, enabled, without a problem, read from its own folder (nothing in the code cache) and in core at its manifest order', async () => {
    const h = tempHome();
    cleanups.push(() => h.cleanup());
    const mods = await startMods({ dir: h.home, env: {} });
    cleanups.push(() => mods.dispose());
    expect(mods.problems).toEqual([]);
    for (const p of packs) {
      const row = mods.mods.find((x) => x.id === p.id && x.source === 'bundled');
      expect(row, p.id).toBeDefined();
      expect(row).toMatchObject({ id: p.id, source: 'bundled', trusted: true, enabled: true, problems: [], pack: 'default' });
      expect(path.resolve(row!.dir)).toBe(path.resolve(p.dir));
      expect(row!.required === true, p.id).toBe(REQUIRED.includes(p.id));
      for (const k of kindsOf(row as never)) expect(NODES.has(k), `${p.id}: ${k}`).toBe(true);
    }
    expect(fs.existsSync(path.join(h.home, 'mod-cache')) ? fs.readdirSync(path.join(h.home, 'mod-cache')) : []).toEqual([]);
    // the kinds of the pack stand in core in the order of their manifests
    const blocks = packs.filter((p) => (p.manifest as { kind?: string }).kind === 'block');
    const wanted = blocks.map((p) => ({ order: (p.manifest as { order: number }).order, kinds: kindsOf(p as never) })).sort((a, b) => a.order - b.order).flatMap((x) => x.kinds);
    expect([...NODES.keys()].filter((k) => wanted.includes(k))).toEqual(wanted);
  });

  it('a pack mod that is not required can be switched off: its kinds are gone from core after a restart; a required one cannot', async () => {
    for (const p of packs) {
      const h = tempHome();
      let mods = await startMods({ dir: h.home, env: {} });
      try {
        const r = await setEnabled(envOf(h.home, () => mods), p.id, false);
        if (REQUIRED.includes(p.id)) {
          expect(r.status, p.id).toBe(409);
          expect(fs.existsSync(path.join(h.home, 'disabled-mods.json'))).toBe(false);
          continue;
        }
        expect(r.status, p.id).toBe(200);
        mods.dispose();
        mods = await startMods({ dir: h.home, env: {} });
        for (const k of kindsOf(p as never)) {
          expect(NODES.has(k), `${p.id}: ${k}`).toBe(false);
          expect(unknownKind(k), `${p.id}: ${k}`).toBe(true);
        }
      } finally {
        mods.dispose();
        h.cleanup();
      }
    }
  });

  it('a hand-edited off list that names a required mod does not switch it off', async () => {
    for (const id of REQUIRED.filter((r) => packs.some((p) => p.id === r))) {
      const h = tempHome();
      fs.writeFileSync(path.join(h.home, 'disabled-mods.json'), JSON.stringify([id]));
      const mods = await startMods({ dir: h.home, env: {} });
      try {
        expect(mods.mods.find((x) => x.id === id)).toMatchObject({ enabled: true, trusted: true });
        for (const k of kindsOf(packs.find((p) => p.id === id) as never)) expect(NODES.has(k)).toBe(true);
      } finally {
        mods.dispose();
        h.cleanup();
      }
    }
  });
});

function envOf(home: string, mods: () => Mods): ModEnv {
  return {
    home, catalogDir: path.join(home, 'no-catalog'), get mods() { return mods(); }, consent: { has: () => false, grant: () => {}, revoke: () => {} } as never,
    send: async () => new Response(''), env: {}, redact: (t: string) => t, holdsSecret: () => false,
  };
}

describe('Customize works from the BUILT folder of every pack mod', () => {
  for (const p of packs) {
    it(`${p.id}: the copy is made through the import path, the restart runs it from the code cache, and it replaces the built-in`, async () => {
      const root = scratch();
      const bundled = path.join(root, 'bundled');
      build(p.dir, path.join(bundled, p.id));
      const home = path.join(root, '.reins');
      fs.mkdirSync(home, { recursive: true });
      let mods = await startMods({ dir: home, env: {}, bundledDir: bundled });
      cleanups.push(() => mods.dispose());
      expect(mods.mods.find((x) => x.id === p.id)).toMatchObject({ source: 'bundled', problems: [] });
      const r = await customizeMod(envOf(home, () => mods), p.id, { trust: true });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(fs.existsSync(path.join(home, 'mods', p.id, 'index.js'))).toBe(true);
      // the copy keeps neither claim (a user mod may not say them)
      const copy = JSON.parse(fs.readFileSync(path.join(home, 'mods', p.id, 'mod.json'), 'utf8'));
      expect('pack' in copy || 'required' in copy).toBe(false);
      mods.dispose();
      mods = await startMods({ dir: home, env: {}, bundledDir: bundled });
      const row = mods.mods.find((x) => x.id === p.id);
      expect(row).toMatchObject({ source: 'user', replaces: 'bundled', problems: [], pack: 'default', trusted: true });
      expect(row!.required === true).toBe(REQUIRED.includes(p.id));
      for (const k of kindsOf(row as never)) expect(NODES.has(k)).toBe(true);
      const cache = path.join(home, 'mod-cache');
      expect(fs.existsSync(cache) && fs.readdirSync(cache, { recursive: true }).map(String).some((f) => f.endsWith('index.js'))).toBe(true);
    });
  }
});

describe('the helper server tests use to get the pack', () => {
  it('loadPack() puts every pack kind in core and off() takes them out; a second load while one is loaded refuses in words', async () => {
    const kinds = packs.flatMap((p) => kindsOf(p as never));
    expect(kinds.length).toBeGreaterThan(2);
    for (const k of kinds) expect(NODES.has(k), k).toBe(false);
    const first = await loadPack();
    try {
      for (const k of kinds) expect(NODES.has(k), k).toBe(true);
      await expect(loadPack()).rejects.toThrow(/^The default pack did not load: .*already registered/);
    } finally {
      first.off();
    }
    for (const k of kinds) expect(NODES.has(k), k).toBe(false);
    const again = await loadPack(); // and it loads cleanly again
    again.off();
  });
});