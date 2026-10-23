// M2 Task 17b: `GET /api/kinds` serves the faces of the blocks: core's 13 built-in views and the view of every block mod, read from the manifest's
// JSON (the `block-view` registry), never from code. Mod folders are made at run time in a temp home through `tempHome`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_VIEWS, NODES } from '@reins/core';
import { servedKinds } from '../src/mods/kinds-view.js';
import { hashFiles, readFolder } from '../src/mods/loader.js';
import { startMods } from '../src/engines.js';
import { startServer } from '../src/server.js';
import { openStore } from '../src/store.js';
import { boot, cleanup, PROBE, request } from './http-helpers.js';
import { tempHome } from './mods-harness.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mods/toy-beep/', import.meta.url));
const manifest = () => JSON.parse(fs.readFileSync(path.join(FIXTURE, 'mod.json'), 'utf8')) as Record<string, any>;
const code = () => fs.readFileSync(path.join(FIXTURE, 'index.js'), 'utf8');
// The palette order of the views (their order), as the app sorts them today.
const BUILT_IN_ORDER = ['phase', 'say', 'run', 'gate', 'repeat', 'if', 'verify', 'recall', 'store', 'model', 'subagent', 'end', 'use'];

const homes: Array<ReturnType<typeof tempHome>> = [];
afterEach(async () => {
  await cleanup();
  for (const h of homes.splice(0)) h.cleanup();
});

/** A server whose Reins home holds `toy-beep`, trusted or not. */
async function withBeep(trusted: boolean, edit: (m: Record<string, any>) => void = () => {}) {
  const h = tempHome();
  homes.push(h);
  const m = manifest();
  edit(m);
  h.writeMod('toy-beep', m, { 'index.js': code() });
  if (trusted) fs.writeFileSync(path.join(h.home, 'mod-trust.json'), JSON.stringify({ 'toy-beep': hashFiles(readFolder(path.join(h.modsDir, 'toy-beep'), 'toy-beep')) }));
  return boot([], { dir: h.home });
}
const kindsOf = async (w: Awaited<ReturnType<typeof boot>>) => (await w.api('GET', '/api/kinds')).json as { kinds: Array<Record<string, any>>; problems: string[] };

describe('GET /api/kinds: the built-in views', () => {
  it('serves the 13 views of core, in kind order, as the JSON core holds them', async () => {
    const w = await boot();
    const r = await w.api('GET', '/api/kinds');
    expect(r.status).toBe(200);
    expect(r.json.problems).toEqual([]);
    expect(r.json.kinds.map((k: { kind: string }) => k.kind)).toEqual(BUILT_IN_ORDER);
    expect(r.json.kinds).toEqual(JSON.parse(JSON.stringify([...BUILTIN_VIEWS].sort((a, b) => a.order - b.order))));
    expect(BUILTIN_VIEWS).toHaveLength(13);
  });

  it('needs the token like every other route', async () => {
    const w = await boot();
    expect((await w.api('GET', '/api/kinds', { auth: false })).status).toBe(401);
  });
});

describe('the test setup is the app project\'s only', () => {
  it('vitest.config.ts: the app project has the kinds setup, core has the pack setup (M3 Task 1), the server has none', async () => {
    const { default: config } = await import('../../../vitest.config.js');
    const projects = (config as { test: { projects: Array<{ test: { name: string; setupFiles?: string[] } }> } }).test.projects;
    expect(projects.map((p) => p.test.name)).toEqual(['core', 'server', 'app']);
    expect(projects.map((p) => p.test.setupFiles)).toEqual([['packages/core/test/setup-pack.ts'], undefined, ['packages/app/test/setup-kinds.ts']]);
  });

  it('in a server test file the app\'s KINDS has not been filled', async () => {
    const { KINDS } = await import('../../app/src/canvasKinds.js');
    expect(Object.keys(KINDS)).toEqual([]);
  });
});

describe('GET /api/kinds: a block mod', () => {
  it('a loaded toy-beep appears with the manifest view, after the built-ins, and is not flagged', async () => {
    const w = await withBeep(true);
    const { kinds, problems } = await kindsOf(w);
    expect(problems).toEqual([]);
    expect(kinds.map((k) => k.kind)).toEqual([...BUILT_IN_ORDER, 'beep']);
    expect(kinds.at(-1)).toEqual(manifest().view);
    expect('trusted' in kinds.at(-1)!).toBe(false);
    expect(NODES.has('beep')).toBe(true); // it really loaded
  });

  it('what is served is the manifest and not the code: nothing of index.js is in the reply', async () => {
    const w = await withBeep(true);
    const text = (await w.api('GET', '/api/kinds')).text;
    expect(code()).toContain('registerBlock');
    for (const word of ['registerBlock', 'activate', 'BEEP', 'TOY_MARKER']) expect(text, word).not.toContain(word);
    // every key of the served view is a key the manifest's view holds
    const served = (await kindsOf(w)).kinds.at(-1)!;
    for (const k of Object.keys(served)) expect(Object.keys(manifest().view), k).toContain(k);
  });

  it('an UNTRUSTED block mod\'s view is served (it is the manifest, shown before trust) and flagged trusted: false', async () => {
    const w = await withBeep(false);
    const { kinds } = await kindsOf(w);
    expect(NODES.has('beep')).toBe(false); // its code did not run
    expect(kinds.at(-1)).toEqual({ ...manifest().view, trusted: false });
  });

  // Task 25a (B1): a `trusted` key in a mod's view is not part of a view, so the mod is refused and not served. (This pin said the key was ignored.)
  it('a manifest that has a trusted key in its view is refused and not served (the flag is the server\'s)', async () => {
    for (const [trusted, claim] of [[false, true], [true, false]] as const) {
      const w = await withBeep(trusted, (m) => { m.view.trusted = claim; });
      expect((await kindsOf(w)).kinds.map((k) => k.kind)).not.toContain('beep');
    }
  });

  it('a mod view without its own order sits where the manifest order says', async () => {
    const w = await withBeep(true, (m) => { delete m.view.order; m.order = 55; });
    const { kinds } = await kindsOf(w);
    expect(kinds.map((k) => k.kind).indexOf('beep')).toBe(BUILT_IN_ORDER.indexOf('repeat') + 1); // after repeat (50), before if (60)
    expect(kinds.find((k) => k.kind === 'beep')!.order).toBe(55);
  });
});

describe('the builder refuses what it must not send', () => {
  // The loader's own checks already refuse these in a manifest; the builder checks again, so a view that got into the registry another way is not sent.
  const reg = async () => {
    const h = tempHome();
    homes.push(h);
    const mods = await startMods({ dir: h.home, env: {} });
    return { mods, h, add: (view: unknown, kind = (view as { kind: string }).kind) => mods.registry.register('block-view', kind, view) };
  };
  const view = (over: Record<string, unknown> = {}) => ({ kind: 'toy', order: 150, colour: 'soft', fields: [], line: ['toy'], ...over });
  const RLO = '\u202e';

  it('a label with a hidden character is not served, and the problem names it in \\u form', async () => {
    const { mods, add } = await reg();
    add(view({ line: [`to${RLO}y`] }));
    const out = servedKinds(mods);
    expect(out.kinds.map((k) => k.kind)).toEqual(BUILT_IN_ORDER);
    expect(out.problems).toEqual(['toy: the view holds a control, line-break or direction-changing character, so it is not served.']);
    expect(JSON.stringify(out)).not.toContain(RLO);
    mods.dispose();
  });

  it('a hidden character in a key, in a nested field, or in the kind name is refused as well', async () => {
    const { mods, add } = await reg();
    add(view({ kind: 'k1', fields: [{ key: 'x', label: 'a\u200bb', input: 'text' }] }));
    add(view({ kind: 'k2', [`ke${RLO}y`]: 1 }));
    add(view({ kind: `k3${RLO}` }));
    add(view({ kind: 'k4', card: { label: 'two\nlines', section: 'Flow' } }));
    const out = servedKinds(mods);
    expect(out.kinds.map((k) => k.kind)).toEqual(BUILT_IN_ORDER);
    expect(out.problems).toHaveLength(4);
    expect(out.problems.some((p) => p.startsWith('k3\\u202e:'))).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/[\u202e\u200b]/);
    mods.dispose();
  });

  it('the route does not send it either', async () => {
    const { mods, h } = await reg();
    mods.registry.register('block-view', 'toy', view({ line: [`to${RLO}y`] }));
    const store = openStore(':memory:');
    const srv = await startServer({ store, dir: h.home, mods, probe: async () => PROBE, makeEngine: () => { throw new Error('never opened'); } });
    const r = await request(srv, 'GET', '/api/kinds');
    expect(r.json.kinds.map((k: { kind: string }) => k.kind)).toEqual(BUILT_IN_ORDER);
    expect(r.json.problems).toHaveLength(1);
    expect(r.text).not.toContain(RLO);
    await srv.close();
    store.close();
    mods.dispose();
  });

  it('a mod view cannot take the place of a built-in kind', async () => {
    const { mods, add } = await reg();
    add(view({ kind: 'say', colour: 'hard', line: ['evil'] }));
    const out = servedKinds(mods);
    expect(out.kinds.filter((k) => k.kind === 'say')).toEqual([BUILTIN_VIEWS.find((v) => v.kind === 'say')]);
    expect(out.kinds).toHaveLength(13);
    expect(out.problems).toEqual(['say: a mod cannot give a view to a built-in block, so it is not served.']);
    mods.dispose();
  });

  it('kinds come in order, ties in the order they came, and a view without order goes last', async () => {
    const { mods, add } = await reg();
    add(view({ kind: 'z-late', order: 400 }));
    add(view({ kind: 'a-early', order: 5 }));
    add(view({ kind: 'm-mid', order: 125 }));
    add(view({ kind: 'n-mid', order: 125 }));
    const noOrder = view({ kind: 'o-none' });
    delete (noOrder as Record<string, unknown>).order;
    add(noOrder);
    expect(servedKinds(mods).kinds.map((k) => k.kind)).toEqual([
      'a-early', 'phase', 'say', 'run', 'gate', 'repeat', 'if', 'verify', 'recall', 'store', 'model', 'subagent', 'end', 'm-mid', 'n-mid', 'use', 'z-late', 'o-none',
    ]);
    mods.dispose();
  });

  it('a view in the registry with a function in it is sent as data without it', async () => {
    const { mods, add } = await reg();
    add(view({ kind: 'fn', sub: () => 'x', fields: [], line: ['fn'] }));
    const k = servedKinds(mods).kinds.find((x) => x.kind === 'fn')!;
    expect(k).toBeDefined();
    expect('sub' in k).toBe(false);
    mods.dispose();
  });

  it('a view that cannot be read as JSON is left out, and the rest is still served', async () => {
    const { mods, add } = await reg();
    add({ kind: 'bad', order: 150, fields: [], line: [], get boom() { throw new Error('no'); } });
    const out = servedKinds(mods);
    expect(out.kinds.map((k) => k.kind)).toEqual(BUILT_IN_ORDER);
    expect(out.problems).toEqual(['bad: the view could not be read as JSON, so it is not served.']);
    mods.dispose();
  });

  it('a mod view found for no loaded mod is served untrusted', async () => {
    const { mods, add } = await reg();
    add(view({ trusted: true }));
    expect(servedKinds(mods).kinds.find((x) => x.kind === 'toy')!.trusted).toBe(false);
    mods.dispose();
  });

  it('with no mods it is the 13 built-ins', () => {
    expect(servedKinds().kinds.map((k) => k.kind)).toEqual(BUILT_IN_ORDER);
  });
});
