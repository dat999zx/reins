// M3 Task 1 (the loader half): a pack mod is a bundled mod with `"pack": "default"`. It loads bundled and trusted with no prompt; `required` ids cannot
// be switched off; a user mod cannot claim `pack` or `required`; a user copy of a bundled mod may cover ONLY the names the built-in's own `provides` lists;
// and a user copy of a bundled mod waits for a restart on a live reload, then runs from the cache and takes the built-in's place.
// Every mod here is made at run time in a temp home (`tempHome`), the bundled ones in a folder of their own; nothing under packages/*/src.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CARDS, CONDS, NODES, compileProgram, opOf, parseWorkflow } from '@reins/core';
import { dropCarried, loadMods } from '../src/mods/loader.js';
import type { Carried, LoadedMod, Mods } from '../src/mods/types.js';
import { registerPack } from '../../core/test/pack.js';
import { tempHome } from './mods-harness.js';
import { usePack } from './pack-helper.js';

usePack(); // M3 Task 3: the built-in kinds are the default pack's mods; this file loads the pack once

let h: ReturnType<typeof tempHome>;
let bundled: string;
const loaded: Mods[] = [];
const carries: Array<Map<string, Carried>> = [];
beforeEach(() => { h = tempHome(); bundled = path.join(h.home, 'bundled'); fs.mkdirSync(bundled); });
afterEach(() => {
  for (const m of loaded.splice(0).reverse()) m.dispose();
  for (const c of carries.splice(0)) dropCarried(c);
  h.cleanup();
});

const view = (kind: string) => ({
  kind, order: 140, colour: 'soft', fields: [{ key: 'times', label: 'Times', input: 'number', check: 'count' }], line: [kind, { field: 'times' }],
  card: { label: kind, section: 'Flow' }, fresh: { attrs: { times: '1' } },
});
/** A pack block manifest: kind `pbeep`, op `PBEEP`, event `pbeeped`. Over-ride any field. */
const block = (id: string, kind: string, over: Record<string, unknown> = {}): Record<string, any> => ({
  reins: 1, id, kind: 'block', version: '1.0.0', label: `Pack ${id}`, main: 'index.js', order: 140, pack: 'default',
  provides: { kinds: [kind], ops: [`OP_${kind.toUpperCase()}`], attrs: ['times'], events: ['pbeeped'] }, view: view(kind), ...over,
});
/** The code of a pack block: it registers `kind` with an op that logs which copy ran (`by`). */
const blockCode = (kind: string, by: string) => `
export const by = ${JSON.stringify(by)};
export default function activate(api) {
  globalThis.__packFrom = import.meta.url;
  api.registerBlock({
    kind: ${JSON.stringify(kind)}, attrs: ['times'],
    compile(step, ctx) { ctx.push({ op: 'OP_${kind.toUpperCase()}', step: step.id, by: ${JSON.stringify(by)} }); },
    ops: { OP_${kind.toUpperCase()}: { async exec(i, vm) { vm.log('pbeeped', { step: i.step }); vm.next(); } } },
  });
}
`;
const ATOM = (t: string) => `{ t: '${t}', parse(s) { if (!s.src.startsWith('${t}', s.idx)) return null; s.idx += ${t.length}; return { t: '${t}' }; }, print: () => '${t}', judge: 'agent', evalSync: () => true }`;
const cond = (id: string, t: string, over: Record<string, unknown> = {}) => ({
  reins: 1, id, kind: 'condition', version: '1.0.0', label: id, main: 'index.js', order: 25, pack: 'default', provides: { conditions: [t] }, ...over,
});
const card = (id: string, k: string, over: Record<string, unknown> = {}) => ({
  reins: 1, id, kind: 'card', version: '1.0.0', label: id, main: 'index.js', order: 15, pack: 'default', provides: { cards: [k] }, ...over,
});
const code = (body: string) => `export default function activate(api) { ${body} }\n`;

const writeAt = (root: string, id: string, manifest: unknown, files: Record<string, string> = {}) => {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify(manifest, null, 2));
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t);
};
const putBundled = (id: string, manifest: unknown, files: Record<string, string> = {}) => writeAt(bundled, id, manifest, files);
const putUser = (id: string, manifest: unknown, files: Record<string, string> = {}) => writeAt(h.modsDir, id, manifest, files);

const opts = (o: { disabled?: string[]; trusted?: boolean; carry?: Map<string, Carried> } = {}) => ({
  bundledDir: bundled, userDir: h.modsDir, home: h.home, disabled: new Set(o.disabled ?? []), env: {}, carry: o.carry,
  trusted: () => o.trusted ?? false,
});
const load = async (o: Parameters<typeof opts>[0] = {}) => {
  const m = await loadMods(opts(o));
  loaded.push(m);
  return m;
};
const newCarry = () => { const c = new Map<string, Carried>(); carries.push(c); return c; };
const find = (m: Mods, id: string, source?: string) => m.mods.find((x) => x.id === id && (source === undefined || x.source === source)) as LoadedMod;
const head = '---\nreins: 1\nname: pack\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n';
/** The first instruction a step of `kind` compiles to: `by` says which copy of the kind compiled it. */
const compiled = (kind: string): Record<string, unknown> => {
  const p = parseWorkflow(`${head}## ${kind}\ntimes: 1\n\n## phase one\n> go\n`);
  expect(p.diagnostics).toEqual([]);
  return compileProgram(p.workflow!)[0] as unknown as Record<string, unknown>;
};
const g = globalThis as unknown as Record<string, unknown>;
afterEach(() => { delete g.__packFrom; });

describe('a pack mod is a bundled mod that says "pack"', () => {
  it('an empty pack loads: no mod, no problem', async () => {
    const m = await load();
    expect(m.mods).toEqual([]);
    expect(m.problems).toEqual([]);
  });

  it('loads bundled and trusted with no prompt (nothing is trusted, nothing is asked), runs from its own folder, and is a member of the pack', async () => {
    putBundled('pbeep', block('pbeep', 'pbeep'), { 'index.js': blockCode('pbeep', 'bundled') });
    const m = await load({ trusted: false });
    expect(find(m, 'pbeep')).toMatchObject({ source: 'bundled', trusted: true, hasCode: true, problems: [], pack: 'default', enabled: true });
    expect(find(m, 'pbeep').required).toBeUndefined();
    expect(NODES.has('pbeep')).toBe(true);
    expect(opOf('OP_PBEEP')).toBeDefined();
    expect(String(g.__packFrom)).toContain('/bundled/pbeep/index.js'); // not copied to the cache: a bundled folder is trusted as it is
    expect(fs.existsSync(path.join(h.home, 'mod-cache'))).toBe(false);
    expect(m.registry.get('block-view', 'pbeep')).toEqual(view('pbeep'));
  });

  it('a pack mod is registered at its manifest order, among the built-ins', async () => {
    putBundled('pbeep', block('pbeep', 'pbeep', { order: 25 }), { 'index.js': blockCode('pbeep', 'bundled') });
    await load();
    const keys = [...NODES.keys()];
    expect(keys.indexOf('pbeep')).toBe(keys.indexOf('say') + 1); // say is 20, run is 30
  });

  it('a bundled manifest must say "pack": "default" and "required": true, or leave them out', async () => {
    putBundled('p1', block('p1', 'pone', { pack: 'mine' }), { 'index.js': blockCode('pone', 'x') });
    putBundled('p2', block('p2', 'ptwo', { required: false }), { 'index.js': blockCode('ptwo', 'x') });
    const m = await load();
    expect(find(m, 'p1').problems.join(' ')).toContain('`pack` is "mine"; it must be "default"');
    expect(find(m, 'p2').problems.join(' ')).toContain('`required` is false; it must be true or left out');
    expect(NODES.has('pone') || NODES.has('ptwo')).toBe(false);
  });
});

describe('switching a pack mod off', () => {
  it('removes its kind after a restart, not at once (the carry rule)', async () => {
    putBundled('pbeep', block('pbeep', 'pbeep'), { 'index.js': blockCode('pbeep', 'bundled') });
    const carry = newCarry();
    await load({ carry });
    expect(NODES.has('pbeep')).toBe(true);
    const off = await load({ carry, disabled: ['pbeep'] });
    expect(find(off, 'pbeep')).toMatchObject({ enabled: false });
    expect(find(off, 'pbeep').problems).toEqual(['`pbeep`: applies after a restart.']);
    expect(NODES.has('pbeep')).toBe(true); // still in core until the process restarts
    // The restart: a new process has an empty carry.
    for (const x of loaded.splice(0).reverse()) x.dispose();
    dropCarried(carry);
    expect(NODES.has('pbeep')).toBe(false);
    const again = await load({ carry: newCarry(), disabled: ['pbeep'] });
    expect(find(again, 'pbeep')).toMatchObject({ enabled: false, problems: [] });
    expect(NODES.has('pbeep')).toBe(false);
    expect(again.registry.has('block-view', 'pbeep')).toBe(false);
  });
});

describe('required: true', () => {
  const required = () => putBundled('pend', block('pend', 'pend', { required: true }), { 'index.js': blockCode('pend', 'bundled') });

  it('a required id stays on when a hand-edited off list names it, and says so (as news, once)', async () => {
    required();
    const m = await load({ disabled: ['pend'] });
    expect(NODES.has('pend')).toBe(true);
    expect(find(m, 'pend')).toMatchObject({ enabled: true, required: true });
    expect(find(m, 'pend').problems).toEqual(['`pend`: is required, so it stays on. Reins ignored the switch-off in disabled-mods.json.']);
  });

  it('an id that is not required is still switched off by the same list', async () => {
    putBundled('pbeep', block('pbeep', 'pbeep'), { 'index.js': blockCode('pbeep', 'bundled') });
    const m = await load({ disabled: ['pbeep'] });
    expect(find(m, 'pbeep').enabled).toBe(false);
    expect(NODES.has('pbeep')).toBe(false);
  });

  it('a switched-off mod of another id does not make a required one stay on by accident', async () => {
    required();
    putBundled('pbeep', block('pbeep', 'pbeep'), { 'index.js': blockCode('pbeep', 'bundled') });
    const m = await load({ disabled: ['pbeep'] });
    expect(find(m, 'pend').problems).toEqual([]);
    expect(find(m, 'pbeep').enabled).toBe(false);
  });
});

describe('a user mod cannot claim to be a pack mod', () => {
  const claim = (over: Record<string, unknown>) => block('pown', 'pown', { ...over });
  for (const [name, over] of [
    ['pack', { pack: 'default' }], ['pack set to something else', { pack: 'mine' }], ['pack set to null', { pack: null }],
    ['required true', { required: true }], ['required false', { required: false }], ['required null', { required: null }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`${name}: refused with words, nothing registered, nothing run`, async () => {
      const { pack: _p, ...base } = claim({});
      putUser('pown', { ...base, ...over }, { 'index.js': blockCode('pown', 'user') });
      const m = await load({ trusted: true });
      const key = Object.keys(over)[0]!;
      expect(find(m, 'pown').problems.join(' ')).toContain(`\`${key}\` is for the mods that ship with Reins`);
      expect(NODES.has('pown')).toBe(false);
      expect(find(m, 'pown').pack).toBeUndefined();
      expect(find(m, 'pown').required).toBeUndefined();
    });
  }

  it('a user mod of a bundled required id does not become required by saying so, and a copy that says nothing is still held to the id', async () => {
    putBundled('pend', block('pend', 'pend', { required: true }), { 'index.js': blockCode('pend', 'bundled') });
    const { pack: _p, required: _r, ...plain } = block('pend', 'pend');
    putUser('pend', { ...plain, required: true }, { 'index.js': blockCode('pend', 'user') });
    const m = await load({ trusted: true });
    expect(find(m, 'pend', 'user').problems.join(' ')).toContain('`required` is for the mods that ship with Reins');
    expect(compiled('pend').by).toBe('bundled');
  });
});

describe('a user copy of a bundled mod may cover only what the built-in itself provides', () => {
  /** Two bundled pack blocks, `pbeep` and `pother`; the user copies `pbeep`. */
  const base = () => {
    putBundled('pbeep', block('pbeep', 'pbeep'), { 'index.js': blockCode('pbeep', 'bundled') });
    putBundled('pother', block('pother', 'pother', { order: 150 }), { 'index.js': blockCode('pother', 'bundled') });
  };
  const { pack: _drop, ...plain } = block('pbeep', 'pbeep');
  const copy = (over: Record<string, unknown>) => ({ ...plain, ...over });

  it('a copy that registers its own kind covers it (the control: the same flow works)', async () => {
    base();
    putUser('pbeep', copy({}), { 'index.js': blockCode('pbeep', 'user') });
    const m = await load({ trusted: true });
    expect(find(m, 'pbeep')).toMatchObject({ source: 'user', replaces: 'bundled', problems: [] });
    expect(compiled('pbeep').by).toBe('user');
    expect(compiled('pother').by).toBe('bundled');
  });

  it('a copy that registers another pack kind is refused with words, and both built-ins are untouched', async () => {
    base();
    putUser('pbeep', copy({ provides: { kinds: ['pbeep', 'pother'], ops: ['OP_POTHER'], attrs: ['times'], events: ['pbeeped'] } }), { 'index.js': blockCode('pother', 'user') });
    const m = await load({ trusted: true });
    expect(find(m, 'pbeep', 'user').problems).toEqual(['`pbeep`: could not replace the built-in `pbeep`; the built-in stays: kind "pother" is already registered']);
    expect(compiled('pother').by).toBe('bundled');
    expect(compiled('pbeep').by).toBe('bundled');
    expect(m.registry.get('block-view', 'pother')).toEqual(view('pother'));
  });

  it('a copy that registers a CORE kind (phase) is refused the same way', async () => {
    base();
    putUser('pbeep', copy({ provides: { kinds: ['pbeep', 'phase'], ops: ['OP_PHASE'], attrs: ['times'], events: ['pbeeped'] } }), { 'index.js': blockCode('phase', 'user') });
    const before = NODES.get('phase');
    const m = await load({ trusted: true });
    expect(find(m, 'pbeep', 'user').problems.join(' ')).toContain('kind "phase" is already registered');
    expect(NODES.get('phase')).toBe(before);
    expect(compiled('pbeep').by).toBe('bundled');
  });

  it('a copy that lists another kind\'s VIEW (and registers only its own kind) cannot cover that view', async () => {
    base();
    putUser('pbeep', copy({ provides: { kinds: ['pbeep', 'pother'], ops: ['OP_PBEEP'], attrs: ['times'], events: ['pbeeped'] }, view: view('pother') }), { 'index.js': blockCode('pbeep', 'user') });
    const m = await load({ trusted: true });
    expect(find(m, 'pbeep', 'user').problems.join(' ')).toContain('could not replace the built-in `pbeep`');
    expect(m.registry.get('block-view', 'pother')).toEqual(view('pother'));
    expect(compiled('pbeep').by).toBe('bundled');
  });

  it('a copy that takes an op another kind brought is refused by core as before', async () => {
    base();
    putUser('pbeep', copy({ provides: { kinds: ['pbeep'], ops: ['OP_POTHER'], attrs: ['times'], events: ['pbeeped'] } }), {
      'index.js': `export default (api) => api.registerBlock({ kind: 'pbeep', attrs: ['times'], compile() {}, ops: { OP_POTHER: { async exec(i, vm) { vm.next(); } } } });\n`,
    });
    const m = await load({ trusted: true });
    expect(find(m, 'pbeep', 'user').problems.join(' ')).toContain('op "OP_POTHER" is already brought by kind "pother"');
  });

  it('a copy of a protocol mod covers its own protocol, and cannot cover another protocol mod\'s', async () => {
    const proto = (id: string, tag: string, protocol = id) => `export default function activate(api) { api.registerProtocol({ id: ${JSON.stringify(protocol)}, conversation: 'reins', wire: { call() {}, tag: ${JSON.stringify(tag)} } }); }\n`;
    const man = (id: string) => ({ reins: 1, id, kind: 'protocol', version: '1.0.0', label: id, main: 'index.js' });
    putBundled('pproto', man('pproto'), { 'index.js': proto('pproto', 'built-in') });
    putBundled('pproto2', man('pproto2'), { 'index.js': proto('pproto2', 'built-in-2') });
    putUser('pproto', man('pproto'), { 'index.js': proto('pproto', 'mine') });
    const own = await load({ trusted: true });
    expect(find(own, 'pproto')).toMatchObject({ source: 'user', replaces: 'bundled', problems: [] });
    expect(own.registry.get<{ wire: { tag: string } }>('protocol-impl', 'pproto')!.wire.tag).toBe('mine');
    fs.writeFileSync(path.join(h.modsDir, 'pproto', 'index.js'), proto('pproto', 'stolen', 'pproto2'));
    const m = await load({ trusted: true });
    expect(find(m, 'pproto', 'user').problems.join(' ')).toContain('could not replace the built-in `pproto`');
    expect(m.registry.get<{ wire: { tag: string } }>('protocol-impl', 'pproto2')!.wire.tag).toBe('built-in-2');
  });

  it('a copy of a condition mod cannot cover another condition mod\'s atom', async () => {
    putBundled('pc1', cond('pc1', 'pcone'), { 'index.js': code(`api.registerCondition(${ATOM('pcone')});`) });
    putBundled('pc2', cond('pc2', 'pctwo'), { 'index.js': code(`api.registerCondition(${ATOM('pctwo')});`) });
    const { pack: _p, ...plain1 } = cond('pc1', 'pctwo');
    putUser('pc1', plain1, { 'index.js': code(`api.registerCondition({ ...${ATOM('pctwo')}, print: () => 'stolen' });`) });
    const m = await load({ trusted: true });
    expect(find(m, 'pc1', 'user').problems.join(' ')).toContain('could not replace the built-in `pc1`');
    expect(CONDS.get('pctwo')!.print({ t: 'pctwo' } as never)).toBe('pctwo');
  });

  it('a copy of a condition mod covers its own atom', async () => {
    putBundled('pc1', cond('pc1', 'pcone'), { 'index.js': code(`api.registerCondition(${ATOM('pcone')});`) });
    const { pack: _p, ...plain1 } = cond('pc1', 'pcone');
    putUser('pc1', plain1, { 'index.js': code(`api.registerCondition({ ...${ATOM('pcone')}, print: () => 'mine' });`) });
    const m = await load({ trusted: true });
    expect(find(m, 'pc1')).toMatchObject({ source: 'user', replaces: 'bundled', problems: [] });
    expect(CONDS.get('pcone')!.print({ t: 'pcone' } as never)).toBe('mine');
  });

  it('a copy of a card mod cannot cover another card mod\'s card', async () => {
    putBundled('zc1', card('zc1', 'zone'), { 'index.js': code("api.registerCard({ kind: 'zone', delivery: 'now' });") });
    putBundled('zc2', card('zc2', 'ztwo'), { 'index.js': code("api.registerCard({ kind: 'ztwo', delivery: 'now' });") });
    const { pack: _p, ...plain1 } = card('zc1', 'ztwo');
    putUser('zc1', plain1, { 'index.js': code("api.registerCard({ kind: 'ztwo', delivery: 'next' });") });
    const m = await load({ trusted: true });
    expect(find(m, 'zc1', 'user').problems.join(' ')).toContain('could not replace the built-in `zc1`');
    expect(CARDS.get('ztwo')).toMatchObject({ delivery: 'now' });
  });

  it('a copy of a card mod covers its own card', async () => {
    putBundled('zc1', card('zc1', 'zone'), { 'index.js': code("api.registerCard({ kind: 'zone', delivery: 'now' });") });
    const { pack: _p, ...plain1 } = card('zc1', 'zone');
    putUser('zc1', plain1, { 'index.js': code("api.registerCard({ kind: 'zone', delivery: 'next' });") });
    const m = await load({ trusted: true });
    expect(find(m, 'zc1')).toMatchObject({ source: 'user', replaces: 'bundled', problems: [] });
    expect(CARDS.get('zone')).toMatchObject({ delivery: 'next' });
  });

  it('a copy that lists a condition view for an atom the built-in does not provide cannot cover that atom\'s view', async () => {
    putBundled('pc1', cond('pc1', 'pcone', { view: { pcone: { label: 'One', fresh: { t: 'pcone' } } } }), { 'index.js': code(`api.registerCondition(${ATOM('pcone')});`) });
    putBundled('pc2', cond('pc2', 'pctwo', { view: { pctwo: { label: 'Two', fresh: { t: 'pctwo' } } } }), { 'index.js': code(`api.registerCondition(${ATOM('pctwo')});`) });
    const { pack: _p, ...plain1 } = cond('pc1', 'pcone', { provides: { conditions: ['pcone', 'pctwo'] }, view: { pctwo: { label: 'Stolen', fresh: { t: 'pctwo' } } } });
    putUser('pc1', plain1, { 'index.js': code(`api.registerCondition(${ATOM('pcone')});`) });
    const m = await load({ trusted: true });
    expect(find(m, 'pc1', 'user').problems.join(' ')).toContain('could not replace the built-in `pc1`');
    expect(m.registry.get<{ label: string }>('cond-view', 'pctwo')!.label).toBe('Two');
  });
});

describe('a user copy of a bundled startOnly mod: live reload, restart, reload', () => {
  const setup = () => {
    putBundled('pbeep', block('pbeep', 'pbeep', { version: '1.2.0' }), { 'index.js': blockCode('pbeep', 'bundled') });
    const { pack: _p, ...plain } = block('pbeep', 'pbeep', { version: '1.2.0' });
    return plain;
  };

  it('on a live reload the copy waits for a restart: the list shows the copy, core still runs the built-in, and the code is not run', async () => {
    const plain = setup();
    const carry = newCarry();
    await load({ carry }); // the process started with the built-in
    putUser('pbeep', plain, { 'index.js': blockCode('pbeep', 'user') });
    const m = await load({ carry, trusted: true });
    expect(m.mods.filter((x) => x.id === 'pbeep')).toHaveLength(1);
    expect(find(m, 'pbeep')).toMatchObject({ source: 'user', replaces: 'bundled', builtinVersion: '1.2.0', pack: 'default' });
    expect(find(m, 'pbeep').problems).toEqual(['`pbeep`: applies after a restart.']);
    expect(compiled('pbeep').by).toBe('bundled');
    expect(fs.existsSync(path.join(h.home, 'mod-cache'))).toBe(false); // not copied, not imported
    expect(m.registry.has('block-view', 'pbeep')).toBe(true); // the built-in's view is still the one served
  });

  it('after a restart the copy runs from the cache and replaces the built-in; a reload after that keeps both without a clash', async () => {
    const plain = setup();
    putUser('pbeep', plain, { 'index.js': blockCode('pbeep', 'user') });
    const carry = newCarry();
    const first = await load({ carry, trusted: true });
    expect(find(first, 'pbeep')).toMatchObject({ source: 'user', replaces: 'bundled', problems: [] });
    expect(compiled('pbeep').by).toBe('user');
    expect(String(g.__packFrom)).toContain('/mod-cache/'); // runs from the cache copy, not from the user folder
    expect(first.mods.filter((x) => x.id === 'pbeep')).toHaveLength(1);
    const again = await load({ carry, trusted: true }); // Settings changed something else: a reload
    expect(again.problems).toEqual([]);
    expect(find(again, 'pbeep')).toMatchObject({ source: 'user', replaces: 'bundled', problems: [] });
    expect(again.mods.filter((x) => x.id === 'pbeep')).toHaveLength(1);
    expect(again.registry.get('block-view', 'pbeep')).toEqual(view('pbeep'));
    expect(compiled('pbeep').by).toBe('user');
  });

  it('dispose takes both out of core (a second start in one process registers cleanly)', async () => {
    const plain = setup();
    putUser('pbeep', plain, { 'index.js': blockCode('pbeep', 'user') });
    const carry = newCarry();
    const m = await load({ carry, trusted: true });
    expect(NODES.has('pbeep')).toBe(true);
    m.dispose();
    dropCarried(carry);
    expect(NODES.has('pbeep')).toBe(false);
    expect(opOf('OP_PBEEP')).toBeUndefined();
    const second = await load({ carry: newCarry(), trusted: true });
    expect(find(second, 'pbeep').problems).toEqual([]);
  });

  it('removing the copy on a live reload says the built-in is back after a restart, and lists one entry', async () => {
    const plain = setup();
    putUser('pbeep', plain, { 'index.js': blockCode('pbeep', 'user') });
    const carry = newCarry();
    await load({ carry, trusted: true });
    fs.rmSync(path.join(h.modsDir, 'pbeep'), { recursive: true });
    const m = await load({ carry, trusted: true });
    expect(m.mods.filter((x) => x.id === 'pbeep')).toHaveLength(1);
    expect(find(m, 'pbeep')).toMatchObject({ source: 'bundled' });
    expect(find(m, 'pbeep').problems).toEqual(['`pbeep`: applies after a restart.']);
    expect(compiled('pbeep').by).toBe('user'); // the copy still runs until the restart
  });

  it('a built-in whose folder is gone on a reload stays in core and is listed as itself, with the restart notice', async () => {
    setup();
    const carry = newCarry();
    await load({ carry });
    fs.rmSync(path.join(bundled, 'pbeep'), { recursive: true });
    const m = await load({ carry });
    expect(m.mods.filter((x) => x.id === 'pbeep')).toHaveLength(1);
    expect(find(m, 'pbeep')).toMatchObject({ id: 'pbeep', kind: 'block', source: 'bundled', problems: ['`pbeep`: applies after a restart.'] });
    expect(m.registry.has('block-view', 'pbeep')).toBe(true);
    expect(compiled('pbeep').by).toBe('bundled');
  });

  it('an untrusted copy does not run and does not stand in for the built-in', async () => {
    const plain = setup();
    putUser('pbeep', plain, { 'index.js': blockCode('pbeep', 'user') });
    const m = await load({ carry: newCarry(), trusted: false });
    expect(compiled('pbeep').by).toBe('bundled');
    expect(find(m, 'pbeep', 'user').problems.join(' ')).toContain('needs trust');
    expect(find(m, 'pbeep', 'bundled')).toMatchObject({ problems: [] });
  });

  it('a copy that fails to activate leaves the built-in running and listed', async () => {
    const plain = setup();
    putUser('pbeep', plain, { 'index.js': `export default function activate() { throw new Error('boom'); }\n` });
    const m = await load({ carry: newCarry(), trusted: true });
    expect(find(m, 'pbeep', 'user').problems).toEqual(['`pbeep`: could not replace the built-in `pbeep`; the built-in stays: boom']);
    expect(find(m, 'pbeep', 'bundled')).toBeDefined();
    expect(compiled('pbeep').by).toBe('bundled');
  });
});

describe('why the server project has no global registration (spike B, surprise 4)', () => {
  it('registering the pack globally first makes the loader say "already registered"', async () => {
    putBundled('pbeep', block('pbeep', 'pbeep'), { 'index.js': blockCode('pbeep', 'bundled') });
    const off = await registerPack(bundled);
    try {
      expect(NODES.has('pbeep')).toBe(true);
      const m = await load();
      expect(find(m, 'pbeep').problems.join(' ')).toContain('kind "pbeep" is already registered');
    } finally {
      off();
    }
  });
});
