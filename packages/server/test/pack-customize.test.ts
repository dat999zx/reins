// M3 Task 1 (the Settings half): the default pack in `GET /api/mods`, the first-run pack line, required mods with no off switch, and Customize (a user copy of a
// bundled pack mod, made through the import path). The pack here is made at run time in a temp folder and handed to `startMods` as its bundled folder (the real
// pack is empty until M3 Tasks 3 to 8); every home is a temp home. The real `BUNDLED_MODS` is started once at the end.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NODES, compileProgram, parseWorkflow } from '@reins/core';
import { BUNDLED_MODS, keyEnvNames, makeEngineFrom, startMods } from '../src/engines.js';
import { customizeFile, customizeMod, importApply, isNewer, listMods, removeMod, setEnabled, trustMod, type ModEnv } from '../src/mods/actions.js';
import { Redactor, readSecrets } from '../src/secrets.js';
import { makeSend } from '../src/send.js';
import { startServer, type Server } from '../src/server.js';
import { openStore, type Store } from '../src/store.js';
import type { Mods } from '../src/mods/types.js';
import { packMods } from '../../core/test/pack.js';
import { PROBE } from './http-helpers.js';
import { usePack } from './pack-helper.js';

// M3 Task 3: the describes below load the default pack with `usePack()`, except 'the real bundled folder', which starts the real loader (and so loads the pack) itself.

const KEY = 'sk-test-0123456789abcdef';
const rm = (d: string) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the OS */ } };
const g = globalThis as unknown as Record<string, unknown>;
/** Where the code of a kind was last imported from (the code of a pack block writes it when it activates). */
const ranFrom = (kind: string) => String((g.__packFrom as Record<string, unknown> | undefined)?.[kind]);

interface World { root: string; dir: string; bundled: string; mods: Mods; env: () => ModEnv; restart: () => Promise<void>; list: () => Promise<Array<Record<string, any>>>; row: (id: string, source?: 'bundled' | 'user') => Promise<Record<string, any> | undefined> }
const worlds: World[] = [];
const servers: Array<{ srv: Server; store: Store }> = [];
afterEach(async () => {
  for (const s of servers.splice(0)) { await s.srv.close(); s.store.close(); }
  for (const w of worlds.splice(0)) { w.mods.dispose(); rm(w.root); }
  delete g.__packFrom;
});

const view = (kind: string) => ({
  kind, order: 140, colour: 'soft', fields: [{ key: 'times', label: 'Times', input: 'number', check: 'count' }], line: [kind, { field: 'times' }],
  card: { label: kind, section: 'Flow' }, fresh: { attrs: { times: '1' } },
});
const block = (id: string, kind: string, over: Record<string, unknown> = {}) => ({
  reins: 1, id, kind: 'block', version: '1.0.0', label: `Pack ${id}`, main: 'index.js', order: 140, pack: 'default',
  provides: { kinds: [kind], ops: [`OP_${kind.toUpperCase()}`], attrs: ['times'], events: ['pbeeped'] }, view: view(kind), ...over,
});
const blockCode = (kind: string, by: string) => `export default function activate(api) {
  globalThis.__packFrom = { ...globalThis.__packFrom, [${JSON.stringify(kind)}]: import.meta.url };
  api.registerBlock({ kind: ${JSON.stringify(kind)}, attrs: ['times'], compile(step, ctx) { ctx.push({ op: 'OP_${kind.toUpperCase()}', step: step.id, by: ${JSON.stringify(by)} }); },
    ops: { OP_${kind.toUpperCase()}: { async exec(i, vm) { vm.log('pbeeped', { step: i.step }); vm.next(); } } } });
}
`;
const text = (m: unknown) => JSON.stringify(m, null, 2);
const head = '---\nreins: 1\nname: pack\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n';

/** A bundled folder with `pbeep` (optional, v1.0.0), `pend` (required) and `plain` (a bundled mod that is not in the pack). */
function makeBundled(root: string, version = '1.0.0'): string {
  const b = path.join(root, 'bundled');
  const put = (id: string, manifest: unknown, files: Record<string, string>) => {
    fs.mkdirSync(path.join(b, id), { recursive: true });
    fs.writeFileSync(path.join(b, id, 'mod.json'), text(manifest));
    for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(b, id, n), t);
  };
  put('pbeep', block('pbeep', 'pbeep', { version }), { 'index.js': blockCode('pbeep', 'bundled') });
  put('pend', block('pend', 'pend', { required: true, order: 150 }), { 'index.js': blockCode('pend', 'bundled') });
  put('plain', { reins: 1, id: 'plain', kind: 'protocol', version: '1.0.0', label: 'Plain', main: 'index.js' }, { 'index.js': 'export default function activate() {}\n' });
  return b;
}

async function boot(o: { prep?: (dir: string, root: string) => void; version?: string } = {}): Promise<World> {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-pack-')));
  const dir = path.join(root, '.reins');
  fs.mkdirSync(dir, { recursive: true });
  const bundled = makeBundled(root, o.version);
  o.prep?.(dir, root);
  const w: World = {
    root, dir, bundled, mods: await startMods({ dir, env: {}, bundledDir: bundled }),
    env: () => ({
      home: dir, catalogDir: path.join(root, 'no-catalog'), mods: w.mods, consent: { has: () => false, grant: () => {}, revoke: () => {} },
      send: async () => new Response(''), env: {}, redact: (t: string) => t, holdsSecret: (t: string) => t.includes(KEY),
    }),
    restart: async () => { w.mods.dispose(); w.mods = await startMods({ dir, env: {}, bundledDir: bundled }); },
    list: async () => ((await listMods(w.env())).body as { mods: Array<Record<string, any>> }).mods,
    row: async (id, source) => (await w.list()).find((m) => m.id === id && (source === undefined || (source === 'bundled') === m.bundled)),
  };
  worlds.push(w);
  return w;
}
const compiledBy = (kind: string): unknown => {
  const p = parseWorkflow(`${head}## ${kind}\ntimes: 1\n\n## phase one\n> go\n`);
  expect(p.diagnostics).toEqual([]);
  return (compileProgram(p.workflow!)[0] as unknown as { by: unknown }).by;
};
const body = (r: { body: unknown }) => r.body as Record<string, any>;
const userDir = (w: World, id: string) => path.join(w.dir, 'mods', id);
const readDisabled = (w: World) => (fs.existsSync(path.join(w.dir, 'disabled-mods.json')) ? JSON.parse(fs.readFileSync(path.join(w.dir, 'disabled-mods.json'), 'utf8')) as string[] : []);

/** Every entry under `dir` with its size and modification time: a write of any kind changes this. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    const st = fs.lstatSync(d);
    out.push(`${rel || '.'}|${st.isDirectory() ? 'dir' : st.size}|${st.mtimeMs}`);
    if (st.isDirectory() && !st.isSymbolicLink()) for (const n of fs.readdirSync(d).sort()) walk(path.join(d, n), `${rel}/${n}`);
  };
  walk(dir, '');
  return out;
}

describe('the default pack in the list', () => {
  usePack();
  it('lists the pack mods with their flags, and the pack line for the first-run screen', async () => {
    const w = await boot();
    const r = body(await listMods(w.env()));
    expect(r.firstRun).toBe(true);
    expect(r.pack).toEqual([
      { id: 'pbeep', label: 'Pack pbeep', enabled: true, required: false },
      { id: 'pend', label: 'Pack pend', enabled: true, required: true },
    ]);
    const pend = r.mods.find((m: any) => m.id === 'pend');
    expect(pend).toMatchObject({ bundled: true, pack: 'default', required: true, enabled: true, problems: [] });
    expect(r.mods.find((m: any) => m.id === 'pbeep').required).toBeUndefined();
    expect(r.mods.find((m: any) => m.id === 'plain').pack).toBeUndefined(); // a bundled mod that is not in the pack has no pack line
    expect(NODES.has('pbeep') && NODES.has('pend')).toBe(true);
  });

  it('a pack mod switched off shows as off in the pack line, and its kind goes after a restart', async () => {
    const w = await boot();
    const r = await setEnabled(w.env(), 'pbeep', false);
    expect(r.status).toBe(200);
    expect(readDisabled(w)).toEqual(['pbeep']);
    expect(body(await listMods(w.env())).pack[0]).toMatchObject({ id: 'pbeep', enabled: false });
    expect(NODES.has('pbeep')).toBe(true); // the carry rule: it leaves core at the restart
    expect(await w.row('pbeep')).toMatchObject({ enabled: false, notices: ['`pbeep`: applies after a restart.'], problems: [] });
    await w.restart();
    expect(NODES.has('pbeep')).toBe(false);
    expect(NODES.has('pend')).toBe(true);
    expect((await setEnabled(w.env(), 'pbeep', true)).status).toBe(200);
    await w.restart();
    expect(NODES.has('pbeep')).toBe(true);
  });
});

describe('a required mod has no off switch', () => {
  usePack();
  it('the Settings action refuses with words and writes nothing', async () => {
    const w = await boot();
    const r = await setEnabled(w.env(), 'pend', false);
    expect(r.status).toBe(409);
    expect(body(r).error).toBe('`pend` is required: Reins cannot run without it, so it cannot be switched off. You can customize it instead.');
    expect(fs.existsSync(path.join(w.dir, 'disabled-mods.json'))).toBe(false);
    expect(NODES.has('pend')).toBe(true);
    expect((await setEnabled(w.env(), 'pend', true)).status).toBe(200); // switching on is always fine
  });

  it('a hand-edited off list that names it is ignored: it runs, and the list says so as news, not as a fault', async () => {
    const w = await boot({ prep: (dir) => fs.writeFileSync(path.join(dir, 'disabled-mods.json'), JSON.stringify(['pend', 'pbeep'])) });
    expect(NODES.has('pend')).toBe(true);
    expect(NODES.has('pbeep')).toBe(false);
    const pend = (await w.row('pend'))!;
    expect(pend).toMatchObject({ enabled: true, required: true, problems: [] });
    expect(pend.notices).toEqual(['`pend`: is required, so it stays on. Reins ignored the switch-off in disabled-mods.json.']);
    expect(body(await listMods(w.env())).pack).toEqual([
      { id: 'pbeep', label: 'Pack pbeep', enabled: false, required: false },
      { id: 'pend', label: 'Pack pend', enabled: true, required: true },
    ]);
  });

  it('the user copy of a required id is still required', async () => {
    const w = await boot();
    expect((await customizeMod(w.env(), 'pend', { trust: true })).status).toBe(200);
    await w.restart();
    expect(await w.row('pend')).toMatchObject({ bundled: false, replaces: 'bundled', required: true, pack: 'default' });
    expect((await setEnabled(w.env(), 'pend', false)).status).toBe(409);
    fs.writeFileSync(path.join(w.dir, 'disabled-mods.json'), JSON.stringify(['pend']));
    await w.restart();
    expect(await w.row('pend')).toMatchObject({ enabled: true, required: true });
    expect(compiledBy('pend')).toBe('bundled');
  });
});

describe('Customize', () => {
  usePack();
  it('the file it would import is the built-in folder as text, without `pack` and `required`; a bad id, an unknown id and a mod outside the pack are refused', async () => {
    const w = await boot();
    const r = customizeFile(w.env(), 'pend');
    expect(r.status).toBe(200);
    const file = body(r).file;
    expect(file.reinsMod).toBe(1);
    expect(Object.keys(file.files).sort()).toEqual(['index.js', 'mod.json']);
    expect(file.files['index.js']).toBe(fs.readFileSync(path.join(w.bundled, 'pend', 'index.js'), 'utf8'));
    const manifest = JSON.parse(file.files['mod.json']);
    expect(manifest).toMatchObject({ id: 'pend', kind: 'block', version: '1.0.0', order: 150 });
    expect('pack' in manifest || 'required' in manifest).toBe(false);
    expect(fs.readFileSync(path.join(w.bundled, 'pend', 'mod.json'), 'utf8')).toContain('"required": true'); // the built-in itself is not touched
    for (const bad of ['..', '../x', 'a/b', 'a\\b', '', 'PBEEP', 'con', '.', 'x'.repeat(41), 5, null, undefined, {}]) {
      expect(customizeFile(w.env(), bad).status).toBe(400);
      expect((await customizeMod(w.env(), bad, {})).status).toBe(400);
    }
    expect(customizeFile(w.env(), 'nope').status).toBe(404);
    expect(customizeFile(w.env(), 'plain')).toMatchObject({ status: 409 });
    expect(body(customizeFile(w.env(), 'plain')).error).toBe('`plain` is not part of the default pack, so it cannot be customized.');
    expect(fs.existsSync(path.join(w.dir, 'mods', 'plain'))).toBe(false);
  });

  it('a request may only say `trust`', async () => {
    const w = await boot();
    const r = await customizeMod(w.env(), 'pbeep', { trust: true, replaceBuiltin: false });
    expect(r.status).toBe(400);
    expect(fs.existsSync(userDir(w, 'pbeep'))).toBe(false);
  });

  it('copies a CODE pack mod through the import path: untrusted until the yes, then after a restart it runs from the cache and replaces the built-in', async () => {
    const w = await boot();
    const r = await customizeMod(w.env(), 'pbeep', {});
    expect(r.status).toBe(200);
    expect(body(r)).toMatchObject({ ok: true, id: 'pbeep', replaced: false, trust: 'needs-trust' });
    // The copy is in the user's folder, as an import writes it: the same files, no `pack`.
    expect(fs.readdirSync(userDir(w, 'pbeep')).sort()).toEqual(['index.js', 'mod.json']);
    expect(JSON.parse(fs.readFileSync(path.join(userDir(w, 'pbeep'), 'mod.json'), 'utf8'))).not.toHaveProperty('pack');
    expect(fs.existsSync(path.join(w.dir, 'mod-cache'))).toBe(false); // not run, not copied to the cache
    const copy = (await w.row('pbeep', 'user'))!;
    expect(copy.trust).toBe('needs-trust');
    expect(copy.replaces).toBeUndefined();
    expect(typeof copy.hash).toBe('string');
    expect(copy.codePrompt).toContain('runs its own code inside Reins');
    expect(compiledBy('pbeep')).toBe('bundled');

    const t = await trustMod(w.env(), 'pbeep', { hash: copy.hash });
    expect(t.status).toBe(200);
    expect(body(t).trust).toBe('trusted');
    // Still the built-in in core: the copy waits for the restart, and the list shows the copy in its place.
    expect(compiledBy('pbeep')).toBe('bundled');
    const waiting = (await w.list()).filter((m) => m.id === 'pbeep');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ bundled: false, replaces: 'bundled', pack: 'default', notices: ['`pbeep`: applies after a restart.'], problems: [] });

    await w.restart();
    expect(compiledBy('pbeep')).toBe('bundled'); // the same code (the copy is the built-in's own file), so ask the cache where it ran from:
    expect(ranFrom('pbeep')).toContain('/mod-cache/');
    const now = (await w.list()).filter((m) => m.id === 'pbeep');
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ bundled: false, replaces: 'bundled', pack: 'default', trust: 'trusted', problems: [] });
    expect(now[0].notices).toBeUndefined();
    expect(now[0].required).toBeUndefined();
  });

  it('with trust in the request the copy is trusted at once, and a copy the user edited runs instead of the built-in after the restart', async () => {
    const w = await boot();
    expect(body(await customizeMod(w.env(), 'pbeep', { trust: true }))).toMatchObject({ ok: true, trust: 'trusted' });
    fs.writeFileSync(path.join(userDir(w, 'pbeep'), 'index.js'), blockCode('pbeep', 'mine'));
    await w.restart(); // the edit changed the hash: the copy asks again, and the built-in runs meanwhile
    expect((await w.row('pbeep', 'user'))!.trust).toBe('needs-trust');
    expect(compiledBy('pbeep')).toBe('bundled');
    const copy = (await w.row('pbeep', 'user'))!;
    expect((await trustMod(w.env(), 'pbeep', { hash: copy.hash })).status).toBe(200);
    await w.restart();
    expect(compiledBy('pbeep')).toBe('mine');
  });

  it('a Customize while the user copy exists is refused, and the copy is not touched', async () => {
    const w = await boot();
    expect((await customizeMod(w.env(), 'pbeep', { trust: true })).status).toBe(200);
    fs.writeFileSync(path.join(userDir(w, 'pbeep'), 'notes.txt'), 'mine\n');
    const before = tree(userDir(w, 'pbeep'));
    const r = await customizeMod(w.env(), 'pbeep', { trust: true });
    expect(r.status).toBe(409);
    expect(body(r).error).toBe('You already have your own copy of `pbeep`. Edit it, or remove it first.');
    expect(customizeFile(w.env(), 'pbeep').status).toBe(409);
    expect(tree(userDir(w, 'pbeep'))).toEqual(before);
    await w.restart();
    expect((await customizeMod(w.env(), 'pbeep', {})).status).toBe(409); // the same after the restart, when the list shows only the copy
    expect(tree(userDir(w, 'pbeep'))).toEqual(before);
  });

  it('the check "no copy of yours" is made inside the import turn: a copy made in between is not replaced', async () => {
    const w = await boot();
    const file = body(customizeFile(w.env(), 'pbeep')).file;
    fs.mkdirSync(userDir(w, 'pbeep'), { recursive: true });
    fs.writeFileSync(path.join(userDir(w, 'pbeep'), 'mod.json'), file.files['mod.json']);
    fs.writeFileSync(path.join(userDir(w, 'pbeep'), 'index.js'), '// mine\n');
    const before = tree(userDir(w, 'pbeep'));
    const r = await importApply(w.env(), { file, replaceBuiltin: true, newOnly: true });
    expect(r.status).toBe(409);
    expect(body(r).error).toContain('You already have your own copy');
    expect(tree(userDir(w, 'pbeep'))).toEqual(before);
    expect((await importApply(w.env(), { file, replaceBuiltin: true, newOnly: 'yes' })).status).toBe(400);
  });

  it('removing the copy brings the built-in back after a restart', async () => {
    const w = await boot();
    await customizeMod(w.env(), 'pbeep', { trust: true });
    await w.restart();
    expect((await removeMod(w.env(), 'pbeep')).status).toBe(200);
    const left = (await w.list()).filter((m) => m.id === 'pbeep');
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ bundled: true, notices: ['`pbeep`: applies after a restart.'] });
    await w.restart();
    expect(fs.existsSync(userDir(w, 'pbeep'))).toBe(false);
    expect(await w.row('pbeep')).toMatchObject({ bundled: true, problems: [] });
    expect(ranFrom('pbeep')).toContain('/bundled/pbeep/');
  });

  describe('a hostile file in the built-in folder is refused as an import refuses it, and nothing is written', () => {
    const attempts: Array<[string, string, (dir: string) => void]> = [
      ['a binary file', 'blob.txt', (d) => fs.writeFileSync(path.join(d, 'blob.txt'), 'abc\u0000def')],
      ['a file over 1 MB', 'big.txt', (d) => fs.writeFileSync(path.join(d, 'big.txt'), 'x'.repeat(1024 * 1024 + 1))],
      ['a folder', 'sub/inner.js', (d) => { fs.mkdirSync(path.join(d, 'sub')); fs.writeFileSync(path.join(d, 'sub', 'inner.js'), '// x\n'); }],
      ['a file name with a leading dot', '.hidden', (d) => fs.writeFileSync(path.join(d, '.hidden'), 'x')],
      ['a known key in a file', 'notes.txt', (d) => fs.writeFileSync(path.join(d, 'notes.txt'), `token ${KEY}\n`)],
      ['more than 50 files', 'f0.txt', (d) => { for (let i = 0; i < 51; i++) fs.writeFileSync(path.join(d, `f${i}.txt`), 'x'); }],
    ];
    for (const [name, file, make] of attempts) {
      it(name, async () => {
        const w = await boot();
        make(path.join(w.bundled, 'pbeep'));
        await w.restart();
        const homeBefore = fs.readdirSync(w.dir).sort();
        const r = await customizeMod(w.env(), 'pbeep', { trust: true });
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(r.status).toBeLessThan(500);
        // The same files as a plain import: the same refusal, word for word.
        const text = (n: string) => fs.readFileSync(path.join(w.bundled, 'pbeep', n), 'utf8');
        const files: Record<string, string> = { 'mod.json': text('mod.json'), 'index.js': text('index.js') };
        for (const n of fs.readdirSync(path.join(w.bundled, 'pbeep'))) if (n !== 'mod.json' && n !== 'index.js' && fs.statSync(path.join(w.bundled, 'pbeep', n)).isFile()) files[n] = text(n);
        if (file.includes('/')) files[file] = '// x\n';
        const { pack: _p, ...stripped } = JSON.parse(files['mod.json']);
        files['mod.json'] = JSON.stringify(stripped, null, 2) + '\n';
        const plain = await importApply(w.env(), { file: { reinsMod: 1, files }, replaceBuiltin: true, trust: true });
        expect(body(r)).toEqual(body(plain));
        expect(fs.existsSync(userDir(w, 'pbeep'))).toBe(false);
        expect(fs.readdirSync(w.dir).sort()).toEqual(homeBefore); // no staging folder, no trust line
        expect(fs.existsSync(path.join(w.dir, 'mod-trust.json'))).toBe(false);
        expect(JSON.stringify(body(r))).not.toContain(KEY);
        expect(compiledBy('pbeep')).toBe('bundled');
      });
    }

    it('a link in the built-in folder', async () => {
      const w = await boot();
      const target = path.join(w.root, 'outside.txt');
      fs.writeFileSync(target, 'secret outside\n');
      try { fs.symlinkSync(target, path.join(w.bundled, 'pbeep', 'link.txt')); } catch { return; } // no right to make a link here: nothing to test
      const r = await customizeMod(w.env(), 'pbeep', { trust: true });
      expect(r.status).toBe(409);
      expect(fs.existsSync(userDir(w, 'pbeep'))).toBe(false);
      expect(JSON.stringify(body(r))).not.toContain('secret outside');
    });

    it('a file that is not text (bytes that are not UTF-8)', async () => {
      const w = await boot();
      fs.writeFileSync(path.join(w.bundled, 'pbeep', 'raw.txt'), Buffer.from([0x61, 0xff, 0xfe, 0x62]));
      const r = await customizeMod(w.env(), 'pbeep', { trust: true });
      expect(r.status).toBe(409);
      expect(body(r).error).toBe('`pbeep` could not be copied: its files could not be read as text.');
      expect(fs.existsSync(userDir(w, 'pbeep'))).toBe(false);
    });

    it('a manifest the import path would refuse (a kind the copy cannot provide) is refused with the import\'s words', async () => {
      const w = await boot();
      const f = path.join(w.bundled, 'pbeep', 'mod.json');
      fs.writeFileSync(f, text({ ...block('pbeep', 'pbeep'), provides: { kinds: ['pbeep'], ops: ['OP_PBEEP'], attrs: ['times'], events: ['pbeeped', 'bad event'] } }));
      const r = await customizeMod(w.env(), 'pbeep', {});
      expect(r.status).toBe(400);
      expect(body(r).error).toContain('provides.events');
      expect(fs.existsSync(userDir(w, 'pbeep'))).toBe(false);
    });
  });
});

describe('"the built-in is newer"', () => {
  usePack();
  it('isNewer compares dotted numbers, left to right', () => {
    expect(isNewer('1.10.0', '1.9.0')).toBe(true);
    expect(isNewer('1.9.0', '1.10.0')).toBe(false);
    expect(isNewer('2', '1.9')).toBe(true);
    expect(isNewer('1.0', '1.0.0')).toBe(false);
    expect(isNewer('1.0.1', '1.0')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    for (const odd of ['abc', '1.0.0-beta', '', '1..2', '1.2.3.4.5', '9999999999.0', undefined, 5, null]) {
      expect(isNewer(odd, '1.0.0')).toBe(false);
      expect(isNewer('9.0.0', odd)).toBe(false);
    }
  });

  it('a copy made from 1.9.0 while the built-in is now 1.10.0 says the built-in is newer; the same version, or an older built-in, does not', async () => {
    const w = await boot({ version: '1.9.0' });
    await customizeMod(w.env(), 'pbeep', { trust: true });
    await w.restart();
    expect(await w.row('pbeep')).toMatchObject({ version: '1.9.0', builtinVersion: '1.9.0' });
    expect((await w.row('pbeep'))!.newer).toBeUndefined();
    const bump = async (v: string) => {
      const f = path.join(w.bundled, 'pbeep', 'mod.json');
      fs.writeFileSync(f, text({ ...JSON.parse(fs.readFileSync(f, 'utf8')), version: v }));
      await w.restart();
    };
    await bump('1.10.0');
    expect(await w.row('pbeep')).toMatchObject({ version: '1.9.0', builtinVersion: '1.10.0', newer: true, replaces: 'bundled' });
    await bump('1.8.0');
    expect(await w.row('pbeep')).toMatchObject({ builtinVersion: '1.8.0' });
    expect((await w.row('pbeep'))!.newer).toBeUndefined();
    expect((await w.row('pend'))!.newer).toBeUndefined(); // a built-in nobody copied says nothing
    expect((await w.row('pend'))!.builtinVersion).toBeUndefined();
  });
});

describe('the real bundled folder', () => {
  it('startMods with BUNDLED_MODS runs with no global registration: every pack mod in it registers and is taken out again by dispose', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-pack-real-')));
    expect((globalThis as unknown as { __packSetup?: string }).__packSetup).toBeUndefined(); // the server project has no pack setup (it would make startMods say "already registered")
    try {
      const before = [...NODES.keys()];
      const mods = await startMods({ dir: path.join(root, '.reins'), env: {} });
      try {
        expect(mods.problems).toEqual([]);
        expect(mods.mods.map((m) => m.id)).toContain('claude-code-cli');
        const pack = packMods(BUNDLED_MODS);
        const kinds = pack.flatMap((p) => ((p.manifest as { provides?: { kinds?: string[] } }).provides?.kinds ?? []));
        for (const k of kinds) expect(NODES.has(k)).toBe(true);
        expect(mods.mods.filter((m) => m.pack).map((m) => m.id).sort()).toEqual(pack.map((p) => p.id).sort());
        for (const m of mods.mods) expect(m.problems).toEqual([]);
        const body2 = body(await listMods({ home: path.join(root, '.reins'), catalogDir: path.join(root, 'none'), mods, consent: { has: () => false, grant: () => {}, revoke: () => {} }, send: async () => new Response(''), env: {}, redact: (t) => t, holdsSecret: () => false }));
        expect(body2.pack.map((p: any) => p.id).sort()).toEqual(pack.map((p) => p.id).sort());
      } finally {
        mods.dispose();
      }
      expect([...NODES.keys()]).toEqual(before);
    } finally {
      rm(root);
    }
  });
});

describe('over HTTP', () => {
  usePack();
  it('GET and POST /api/mods/:id/customize, the disable refusal of a required mod, and the pack line in the list', async () => {
    const w = await boot();
    const redactor = new Redactor({ home: w.dir, env: {}, keyEnvNames: () => keyEnvNames(w.mods) });
    const send = makeSend({ secrets: () => readSecrets(w.dir), env: {}, redactor, consent: () => true });
    const store = openStore(':memory:');
    const srv = await startServer({
      store, dir: w.dir, mods: w.mods, env: {}, catalogDir: path.join(w.root, 'no-catalog'), redactor, send, consent: () => undefined, probe: async () => PROBE,
      makeEngine: makeEngineFrom(w.mods, { env: {}, home: w.dir, send }),
    });
    servers.push({ srv, store });
    const call = (method: string, url: string, b?: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
      const payload = b === undefined ? undefined : JSON.stringify(b);
      const req = http.request({
        host: '127.0.0.1', port: srv.port, path: url, method, agent: false,
        headers: { authorization: `Bearer ${srv.token}`, ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) },
      }, (res) => {
        let t = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (t += d));
        res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : undefined }); } catch { resolve({ status: res.statusCode ?? 0, json: undefined }); } });
      });
      req.on('error', reject);
      req.end(payload);
    });
    const list = await call('GET', '/api/mods');
    expect(list.json.pack.map((p: any) => [p.id, p.required])).toEqual([['pbeep', false], ['pend', true]]);
    expect((await call('POST', '/api/mods/pend/disable')).status).toBe(409);
    expect((await call('POST', '/api/mods/pbeep/disable')).status).toBe(200);
    expect((await call('POST', '/api/mods/pbeep/enable')).status).toBe(200);
    const file = await call('GET', '/api/mods/pbeep/customize');
    expect(file.status).toBe(200);
    expect(Object.keys(file.json.file.files).sort()).toEqual(['index.js', 'mod.json']);
    expect((await call('GET', '/api/mods/plain/customize')).status).toBe(409);
    expect((await call('GET', '/api/mods/..%2Fx/customize')).status).toBe(400);
    expect((await call('POST', '/api/mods/pbeep/customize', { trust: true })).status).toBe(200);
    expect((await call('POST', '/api/mods/pbeep/customize', { trust: true })).status).toBe(409);
    expect(fs.existsSync(userDir(w, 'pbeep'))).toBe(true);
  });
});
