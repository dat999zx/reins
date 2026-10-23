// M3 Task 3: what changed around `say`, `phase` and `end` when they became pack mods, beyond the byte-for-byte pin (`m3-task-3-pin.test.ts`):
// the chat turn is found by `chatTurn` (not by the name `phase`) and only the pack, or a copy of one of its blocks, may claim it; the `end` block's `stops`
// view; a user mod cannot take the name or the face of a pack block; the id a `phase` makes from a long title.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { NODES, parseWorkflow, printWorkflow, validate } from '@reins/core';
import { startMods } from '../src/engines.js';
import { customizeMod, type ModEnv } from '../src/mods/actions.js';
import { hashFiles, readFolder } from '../src/mods/loader.js';
import { servedKinds } from '../src/mods/kinds-view.js';
import type { Mods } from '../src/mods/types.js';
import { buildTagged, tagCatalogue } from '../src/tags.js';
import { tempHome } from './mods-harness.js';

const PACK = fileURLToPath(new URL('../src/mods/', import.meta.url));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });

const trust = (home: string, id: string) => {
  const file = path.join(home, 'mod-trust.json');
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  all[id] = hashFiles(readFolder(path.join(home, 'mods', id), id));
  fs.writeFileSync(file, JSON.stringify(all));
};
async function start(prep: (h: ReturnType<typeof tempHome>) => void = () => {}) {
  const h = tempHome();
  prep(h);
  const mods = await startMods({ dir: h.home, env: {} });
  cleanups.push(() => { mods.dispose(); h.cleanup(); });
  return { h, mods };
}
const block = (id: string, kind: string, over: Record<string, unknown> = {}) => ({
  reins: 1, id, kind: 'block', version: '1.0.0', label: id, main: 'index.js', order: 1,
  provides: { kinds: [kind] },
  view: { kind, order: 5, colour: 'soft', fields: [], line: [kind], fresh: {}, ...(over.view as object | undefined) },
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'view')),
});
const code = (kind: string, extra = '') => `export default function activate(api) { api.registerBlock({ kind: ${JSON.stringify(kind)}, attrs: [], ${extra} compile(step, ctx) { ctx.push({ op: 'END' }); } }); }\n`;

const wf = (title: string) => `---\nreins: 1\nname: t\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n## phase ${title}\n> go\n\n## phase next\nnext: ${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}\n> back\n`;

describe('the chat turn is the block marked chatTurn', () => {
  it('the pack\'s phase is marked, say and end are not, and the chat tags build the same text as before', async () => {
    await start();
    expect(NODES.get('phase')?.chatTurn).toBe(true);
    expect(NODES.get('say')?.chatTurn).toBeFalsy();
    expect(NODES.get('end')?.chatTurn).toBeFalsy();
    // the attributes each pack block lists (the loader checks them against its provides.attrs)
    expect([NODES.get('say')?.attrs, NODES.get('phase')?.attrs, NODES.get('end')?.attrs]).toEqual([['mode'], ['mode'], []]);
    expect(buildTagged('hi', [{ tag: 'read-only' }])).toEqual({ ok: true, text: '---\nreins: 1\nname: chat\nalways: []\nbudget: { turns: 20, minutes: 30 }\n---\n\n## phase prompt\nmode: read-only\n> hi\n' });
    expect(tagCatalogue().filter((t) => t.place === 'attr').map((t) => t.name)).toEqual(['mode', 'read-only']);
  });

  it('a user mod that claims chatTurn, even at a lower order, does not become the chat turn: the flag is dropped', async () => {
    const { mods } = await start((h) => {
      h.writeMod('hijack', block('hijack', 'hijack'), { 'index.js': code('hijack', 'chatTurn: true,') });
      trust(h.home, 'hijack');
    });
    expect(mods.mods.find((m) => m.id === 'hijack')).toMatchObject({ problems: [] });
    expect(NODES.has('hijack')).toBe(true);
    expect(NODES.get('hijack')?.chatTurn).toBeFalsy();
    expect([...NODES.keys()].indexOf('hijack')).toBeLessThan([...NODES.keys()].indexOf('phase')); // it stands first, and still is not the turn
    const b = buildTagged('hi', []);
    expect(b.ok && b.text).toContain('## phase prompt');
    expect(b.ok && b.text).not.toContain('hijack');
  });

  it('a user mod cannot take the name of a pack block, or its face', async () => {
    for (const kind of ['phase', 'say', 'end']) {
      const { mods } = await start((h) => {
        h.writeMod('squat', block('squat', kind, { view: { stops: kind === 'end' ? true : undefined, fields: [{ key: 'x', label: 'Evil', input: 'text' }] } }), { 'index.js': code(kind, 'chatTurn: true,') });
        trust(h.home, 'squat');
      });
      expect(mods.mods.find((m) => m.id === 'squat')!.problems.length, kind).toBeGreaterThan(0);
      expect(NODES.get(kind)?.mod?.id ?? '', kind).not.toBe('squat');
      const served = servedKinds(mods).kinds.filter((k) => k.kind === kind);
      expect(served.length, kind).toBe(1);
      expect(JSON.stringify(served[0]), kind).not.toContain('Evil');
      mods.dispose();
    }
  });

  it('a block that is not a pack block cannot say stops, and the end block can (M3 fix D: the pack\'s view says it, core names no kind)', async () => {
    const { mods } = await start((h) => {
      h.writeMod('stopper', block('stopper', 'stopper', { view: { stops: true } }), { 'index.js': code('stopper') });
      trust(h.home, 'stopper');
    });
    expect(mods.mods.find((m) => m.id === 'stopper')!.problems.join(' ')).toContain('`view.stops` is only for a block of the default pack');
    expect(NODES.has('stopper')).toBe(false);
    expect(servedKinds(mods).kinds.find((k) => k.kind === 'end')).toMatchObject({ stops: true });
  });
});

/** What `tsc` makes of one pack folder (each file alone), as the build leaves it. */
function build(id: string, out: string): void {
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(path.join(PACK, id))) {
    const text = fs.readFileSync(path.join(PACK, id, f), 'utf8');
    if (f.endsWith('.ts')) fs.writeFileSync(path.join(out, f.replace(/\.ts$/, '.js')), ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
    else fs.writeFileSync(path.join(out, f), text);
  }
}
const envOf = (home: string, mods: () => Mods): ModEnv => ({
  home, catalogDir: path.join(home, 'no-catalog'), get mods() { return mods(); }, consent: { has: () => false, grant: () => {}, revoke: () => {} } as never,
  send: async () => new Response(''), env: {}, redact: (t: string) => t, holdsSecret: () => false,
});

describe('a Customize copy of phase', () => {
  it('stays the chat turn after the restart; a copy that drops chatTurn leaves the chat tags with words', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-m3t3-')));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const bundled = path.join(root, 'bundled');
    for (const id of ['phase', 'say', 'end']) build(id, path.join(bundled, id));
    const home = path.join(root, '.reins');
    fs.mkdirSync(home, { recursive: true });
    let mods = await startMods({ dir: home, env: {}, bundledDir: bundled });
    cleanups.push(() => mods.dispose());
    expect((await customizeMod(envOf(home, () => mods), 'phase', { trust: true })).status).toBe(200);
    mods.dispose();
    mods = await startMods({ dir: home, env: {}, bundledDir: bundled });
    expect(mods.mods.find((m) => m.id === 'phase')).toMatchObject({ source: 'user', replaces: 'bundled' });
    expect(NODES.get('phase')?.chatTurn).toBe(true);
    expect(buildTagged('hi', []).ok).toBe(true);
    // a copy is the same block, tweaked (M3 fix B item 3): it prints a title whole, as the pack's own phase does
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    expect(printWorkflow(parseWorkflow(wf(long)).workflow!)).toContain(long);
    // the user edits the copy so that it is not marked: the tags say why they cannot build
    const file = path.join(home, 'mods', 'phase', 'index.js');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/chatTurn: true,/, ''));
    trust(home, 'phase');
    mods.dispose();
    mods = await startMods({ dir: home, env: {}, bundledDir: bundled });
    expect(mods.mods.find((m) => m.id === 'phase')).toMatchObject({ source: 'user', problems: [] });
    expect(NODES.get('phase')?.chatTurn).toBeFalsy();
    expect(buildTagged('hi', [])).toMatchObject({ ok: false, error: expect.stringContaining('No block that takes a turn is installed') });
  });
});

describe('the id a phase makes from its title', () => {
  it('keeps a long slug whole (links in saved files name it) and prints the file back byte for byte', async () => {
    await start();
    for (const words of [12, 40, 90]) {
      const title = Array.from({ length: words }, (_, i) => `word${i}`).join(' ');
      const p = parseWorkflow(wf(title));
      const slug = title.replace(/ /g, '-');
      expect(p.workflow!.steps[0]!.id).toBe(slug.slice(0, 1000));
      if (slug.length <= 1000) {
        expect(p.diagnostics, String(words)).toEqual([]);
        expect(printWorkflow(p.workflow!)).toBe(wf(title));
      }
    }
  });
});

describe('the end block warns about what it ignores', () => {
  const end = (body: string) => `---\nreins: 1\nname: t\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n## phase one\n> go\n\n## end\n${body}`;
  const warned = (body: string) => validate(parseWorkflow(end(body)).workflow!).map((d) => d.message);
  const WORDS = 'an end step stops the workflow; its links, cards and prompt do nothing';
  it('a link, a card or a prompt each draw the warning; a bare end does not', async () => {
    await start();
    expect(warned('')).not.toContain(WORDS);
    expect(warned('next: one (max 2)\n')).toContain(WORDS);
    expect(warned('guard: src/**\n')).toContain(WORDS);
    expect(warned('> words on an end\n')).toContain(WORDS);
  });
});

describe('the chat turn is found by the flag, never by the name phase', () => {
  it('a pack whose turn block has another name gets that name in the chat text, and its attributes as tags', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-m3t3-turn-')));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const bundled = path.join(root, 'bundled', 'turnx');
    fs.mkdirSync(bundled, { recursive: true });
    fs.writeFileSync(path.join(bundled, 'mod.json'), JSON.stringify({
      reins: 1, id: 'turnx', kind: 'block', version: '1.0.0', label: 'Turnx', main: 'index.js', order: 5, pack: 'default',
      provides: { kinds: ['turnx'], attrs: ['mode'] },
      view: { kind: 'turnx', order: 5, colour: 'soft', fields: [{ key: 'mode', label: 'Mode', input: 'mode', unset: 'write' }], line: ['turnx'], fresh: {} },
    }));
    fs.writeFileSync(path.join(bundled, 'index.js'), "export default function activate(api) { api.registerBlock({ kind: 'turnx', attrs: ['mode'], chatTurn: true, compile(step, ctx) { ctx.push(api.core.turnInstr(step)); } }); }\n");
    const mods = await startMods({ dir: path.join(root, '.reins'), env: {}, bundledDir: path.join(root, 'bundled') });
    cleanups.push(() => mods.dispose());
    expect(mods.mods.find((m) => m.id === 'turnx')).toMatchObject({ problems: [], pack: 'default' });
    expect(NODES.get('turnx')?.chatTurn).toBe(true);
    const b = buildTagged('hi', [{ tag: 'read-only' }]);
    expect(b.ok && b.text).toContain('## turnx prompt\nmode: read-only\n> hi');
    expect(b.ok && b.text).not.toContain('phase');
    expect(tagCatalogue().filter((t) => t.place === 'attr').map((t) => t.name)).toEqual(['mode', 'read-only']);
  });
});