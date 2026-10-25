// M3 Task 1: the core project's pack setup (`setup-pack.ts`, `pack.ts`). It registers every pack mod with the SAME `order` the loader reads from the manifest.
// The pack is empty today; a test pack mod made in a temp folder proves the machinery, so Tasks 3 to 8 just work.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CARDS, CONDS, NODES, opOf } from '../src/index.js';
import { PACK_DIR, packMods, packProblems, registerPack } from './pack.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const put = (root: string, id: string, manifest: Record<string, unknown>, files: Record<string, string>) => {
  fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(path.join(root, id, 'mod.json'), JSON.stringify(manifest));
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(root, id, n), t);
};
const ATOM = "{ t: 'tp', parse(s) { if (!s.src.startsWith('tp', s.idx)) return null; s.idx += 2; return { t: 'tp' }; }, print: () => 'tp', judge: 'agent', evalSync: () => true }";
/** A pack folder: a block at order 25 (between say 20 and run 30), a condition at 15 (between approve 10 and tests 20), a card, and a mod that is not in the pack. */
function makePack(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-corepack-'));
  dirs.push(root);
  put(root, 'tblock', { reins: 1, id: 'tblock', kind: 'block', version: '1.0.0', label: 'T', main: 'index.js', order: 25, pack: 'default' }, {
    'index.js': `export default function activate(api) { api.registerBlock({ kind: 'tblock', attrs: [], compile(step, ctx) { ctx.push({ op: 'TBLOCK', step: step.id }); }, ops: { TBLOCK: { async exec(i, vm) { vm.next(); } } } }); }\n`,
  });
  put(root, 'tcond', { reins: 1, id: 'tcond', kind: 'condition', version: '1.0.0', label: 'C', main: 'index.js', order: 15, pack: 'default' }, {
    'index.js': `export default function activate(api) { api.registerCondition(${ATOM}); }\n`,
  });
  put(root, 'tcard', { reins: 1, id: 'tcard', kind: 'card', version: '1.0.0', label: 'K', main: 'index.js', order: 5, pack: 'default' }, {
    'index.js': `export default function activate(api) { api.registerCard({ kind: 'tcard', delivery: 'now' }); }\n`,
  });
  put(root, 'other', { reins: 1, id: 'other', kind: 'block', version: '1.0.0', label: 'O', main: 'index.js', order: 26 }, {
    'index.js': `export default function activate(api) { api.registerBlock({ kind: 'other', attrs: [], compile() {} }); }\n`,
  });
  return root;
}

describe('which project runs the setup', () => {
  it('the core project ran it (vitest.config.ts); the server and app projects have none', async () => {
    expect((globalThis as unknown as { __packSetup?: string }).__packSetup).toBe(PACK_DIR);
    const config = (await import('../../../vitest.config.js')).default as { test: { projects: Array<{ test: { name: string; setupFiles?: string[] } }> } };
    const setups = Object.fromEntries(config.test.projects.map((p) => [p.test.name, p.test.setupFiles ?? []]));
    expect(setups.core).toEqual(['packages/core/test/setup-pack.ts']);
    expect(setups.server).toEqual([]);
    expect(setups.app).toEqual(['packages/app/test/setup-kinds.ts']);
  });
});

describe('a pack mod runs as a Customize copy too: its own folder and api.core only', () => {
  it('every pack mod in the real pack is flat and imports nothing outside its folder (none yet)', () => {
    for (const p of packMods(PACK_DIR)) expect(packProblems(p.dir), p.id).toEqual([]);
  });

  it('what the check refuses, and what it lets through', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-corepack-'));
    dirs.push(root);
    const mod = (id: string, files: Record<string, string>) => put(root, id, { id, pack: 'default' }, files);
    mod('fine', {
      'index.ts': [
        "import type { ModApi } from '@reins/core';", "import type {", '  NodeType,', "} from '@reins/core';", "import fs from 'node:fs';", "import { helper } from './helper.js';",
        "declare module '@reins/core' { interface NodeKinds { fine: true } }", "export type { ModApi } from '@reins/core';",
      ].join('\n'),
      'helper.ts': 'export const helper = 1;\n',
    });
    expect(packProblems(path.join(root, 'fine'))).toEqual([]);
    const refused: Array<[string, string, string]> = [
      ['value import of core', "import { register } from '@reins/core';", '@reins/core'],
      ['multi-line value import', "import {\n  register,\n} from '@reins/core';", '@reins/core'],
      ['a parent folder', "import { x } from '../other/index.js';", '../other/index.js'],
      ['a sneaky parent', "import { x } from './../other/index.js';", './../other/index.js'],
      ['a package', "import yaml from 'yaml';", 'yaml'],
      ['a bare import', "import 'sneaky';", 'sneaky'],
      ['a dynamic import', "const m = await import('../x.js');", '../x.js'],
      ['an export from', "export * from '../x.js';", '../x.js'],
      ['require', "const x = require('fs');", 'fs'],
      ['an absolute path', "import x from '/etc/x.js';", '/etc/x.js'],
    ];
    for (const [name, line, spec] of refused) {
      mod('bad', { 'index.ts': `${line}\n` });
      expect(packProblems(path.join(root, 'bad')), name).toEqual([`index.ts: imports ${spec}, which is outside the mod folder`]);
    }
    fs.mkdirSync(path.join(root, 'bad', 'sub'));
    expect(packProblems(path.join(root, 'bad')).some((p) => p.startsWith('sub: a folder inside a pack mod'))).toBe(true);
  });
});

describe('registerPack', () => {
  it('the pack folder is the server\'s bundled folder, and the setup has already registered what is in it', () => {
    expect(PACK_DIR.replaceAll('\\', '/')).toMatch(/packages\/server\/src\/mods\/$/);
    expect(fs.existsSync(PACK_DIR)).toBe(true);
    const ids = packMods(PACK_DIR).map((p) => p.id);
    expect(ids).not.toContain('claude-code-cli'); // a bundled mod that is not in the pack
    for (const p of packMods(PACK_DIR)) {
      for (const k of (p.manifest as { provides?: { kinds?: string[] } }).provides?.kinds ?? []) expect(NODES.has(k)).toBe(true);
    }
  });

  it('registers each pack mod at its manifest order, among the built-ins, and takes them out again', async () => {
    const root = makePack();
    const nodes = [...NODES.keys()];
    const conds = [...CONDS.keys()];
    const cards = [...CARDS.keys()];
    const off = await registerPack(root);
    const ks = [...NODES.keys()];
    expect(ks.indexOf('tblock')).toBe(ks.indexOf('say') + 1); // order 25: after say (20), before run (30)
    expect(opOf('TBLOCK')).toBeDefined();
    const cs = [...CONDS.keys()];
    expect(cs.indexOf('tp')).toBe(cs.indexOf('approve') + 1); // order 15: after approve (10), before tests (20)
    expect([...CARDS.keys()][0]).toBe('tcard'); // order 5: before every card
    expect(NODES.has('other')).toBe(false); // not in the pack: not registered
    off();
    expect([...NODES.keys()]).toEqual(nodes);
    expect([...CONDS.keys()]).toEqual(conds);
    expect([...CARDS.keys()]).toEqual(cards);
    expect(opOf('TBLOCK')).toBeUndefined();
    off(); // a second call does nothing
    expect([...NODES.keys()]).toEqual(nodes);
  });

  it('the order is the manifest\'s, not the folder\'s: a pack mod that sorts last by name still sits where its number says', async () => {
    const root = makePack();
    put(root, 'zlast', { reins: 1, id: 'zlast', kind: 'block', version: '1.0.0', label: 'Z', main: 'index.js', order: 21, pack: 'default' }, {
      'index.js': `export default function activate(api) { api.registerBlock({ kind: 'zlast', attrs: [], compile() {} }); }\n`,
    });
    const off = await registerPack(root);
    try {
      const ks = [...NODES.keys()];
      expect(ks.indexOf('zlast')).toBe(ks.indexOf('say') + 1);
      expect(ks.indexOf('tblock')).toBe(ks.indexOf('zlast') + 1);
    } finally {
      off();
    }
  });

  it('a pack mod with no numeric order, no main, or code that is not a function throws, and nothing earlier stays registered', async () => {
    for (const [name, patch] of [['order', { order: 'x' }], ['main', { main: undefined }]] as Array<[string, Record<string, unknown>]>) {
      const root = makePack();
      put(root, 'zbad', { reins: 1, id: 'zbad', kind: 'block', version: '1.0.0', label: 'B', main: 'index.js', order: 40, pack: 'default', ...patch }, { 'index.js': 'export default function () {}\n' });
      const before = [...NODES.keys()];
      await expect(registerPack(root), name).rejects.toThrow(/zbad/);
      expect([...NODES.keys()]).toEqual(before);
      expect(opOf('TBLOCK')).toBeUndefined();
    }
    const root = makePack();
    put(root, 'zbad', { reins: 1, id: 'zbad', kind: 'block', version: '1.0.0', label: 'B', main: 'index.js', order: 40, pack: 'default' }, { 'index.js': 'export const x = 1;\n' });
    await expect(registerPack(root)).rejects.toThrow(/zbad: does not default-export a function/);
    expect(NODES.has('tblock')).toBe(false);
  });

  it('a source folder (main says index.js, the file is index.ts) is found; a folder with no code is an error', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-corepack-'));
    dirs.push(root);
    put(root, 'tsmod', { reins: 1, id: 'tsmod', kind: 'block', version: '1.0.0', label: 'S', main: 'index.js', order: 27, pack: 'default' }, {
      'index.ts': `export default function activate(api: { registerBlock(n: unknown): unknown }) { api.registerBlock({ kind: 'tsmod', attrs: [], compile() {} }); }\n`,
    });
    const off = await registerPack(root);
    expect(NODES.has('tsmod')).toBe(true);
    off();
    put(root, 'nocode', { reins: 1, id: 'nocode', kind: 'block', version: '1.0.0', label: 'N', main: 'index.js', order: 28, pack: 'default' }, {});
    await expect(registerPack(root)).rejects.toThrow(/nocode/);
    expect(NODES.has('tsmod')).toBe(false);
  });

  it('a missing folder is an empty pack', async () => {
    const off = await registerPack(path.join(os.tmpdir(), 'reins-corepack-does-not-exist'));
    off();
    expect(packMods(path.join(os.tmpdir(), 'reins-corepack-does-not-exist'))).toEqual([]);
  });
});
