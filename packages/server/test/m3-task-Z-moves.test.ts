// M3 Task 7: what changed around `model` and `subagent` when they became pack mods, beyond the byte-for-byte pin (`m3-task-Z-pin.test.ts`):
// `model_switched` is the model mod's own event (not a core one); `subagent_started` and `subagent_result` stay core's, and only the subagent block draws their rows.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { CORE_EVENTS, NODES, isCoreEvent, mayRow, viewShapeProblem } from '@reins/core';
import { startMods } from '../src/engines.js';
import { customizeMod, type ModEnv } from '../src/mods/actions.js';
import { hashFiles, readFolder } from '../src/mods/loader.js';
import { servedKinds } from '../src/mods/kinds-view.js';
import type { Mods } from '../src/mods/types.js';
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
  provides: { kinds: [kind], ...(over.provides as object | undefined) },
  view: { kind, order: 5, colour: 'soft', fields: [], line: [kind], fresh: {}, ...(over.view as object | undefined) },
});
const code = (kind: string) => `export default function activate(api) { api.registerBlock({ kind: ${JSON.stringify(kind)}, attrs: [], compile(step, ctx) { ctx.push({ op: 'END' }); } }); }\n`;

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

describe('the events of model and subagent', () => {
  it('model_switched belongs to the model mod (provides.events) and is no longer a core event; subagent_started and subagent_result are still core\'s', async () => {
    expect(isCoreEvent('model_switched')).toBe(false);
    expect(Object.keys(CORE_EVENTS)).toEqual(expect.arrayContaining(['subagent_started', 'subagent_result']));
    const { mods } = await start();
    const m = mods.mods.find((x) => x.id === 'model')!;
    expect(m).toMatchObject({ problems: [] });
    expect((m.manifest as { provides: { events: string[] } }).provides.events).toEqual(['model_switched']);
    const s = mods.mods.find((x) => x.id === 'subagent')!;
    expect((s.manifest as { provides: { events?: string[] } }).provides.events).toBeUndefined();
  });

  it('mayRow: any non-core event; a core event only for the kind core names for it', () => {
    expect(mayRow('anything', 'x')).toBe(true);
    expect(mayRow('model_switched', 'x')).toBe(true);
    expect(mayRow('subagent_started', 'subagent')).toBe(true);
    expect(mayRow('subagent_result', 'subagent')).toBe(true);
    expect(mayRow('subagent_started', 'model')).toBe(false);
    expect(mayRow('subagent_started', undefined)).toBe(false);
    expect(mayRow('turn_ended', 'subagent')).toBe(false);
    expect(mayRow('run_started', 'subagent')).toBe(false);
    for (const t of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(mayRow(t, 'subagent'), t).toBe(true);   // not core events at all
  });
});

describe('who may draw the rows of a core event', () => {
  const view = (kind: string, rows: object) => ({ kind, colour: 'soft', fields: [], line: [kind], rows });
  const scope = { mod: { attrs: [], events: [] as string[] } };
  it('the subagent view may; any other mod view is refused, and so is a core event that has no owner', () => {
    expect(viewShapeProblem(view('subagent', { subagent_started: { text: 'x' } }), scope)).toBeUndefined();
    expect(viewShapeProblem(view('subagent', { subagent_result: { text: 'x', details: '{text}', className: 'sx-sub' } }), scope)).toBeUndefined();
    expect(viewShapeProblem(view('other', { subagent_started: { text: 'x' } }), scope)).toMatch(/event core logs/);
    expect(viewShapeProblem(view('subagent', { turn_ended: { text: 'x' } }), scope)).toMatch(/event core logs/);
    expect(viewShapeProblem(view('subagent', { run_started: { text: 'x' } }), scope)).toMatch(/event core logs/);
    expect(viewShapeProblem(view('subagent', { not_provided: { text: 'x' } }), scope)).toMatch(/provides\.events/);
  });

  it('a user mod\'s own block cannot draw subagent_started, and the pack\'s subagent still does', async () => {
    const { mods } = await start((h) => {
      h.writeMod('thief', block('thief', 'thief', { view: { rows: { subagent_started: { text: 'stolen' } } } }), { 'index.js': code('thief') });
      trust(h.home, 'thief');
    });
    expect(mods.mods.find((m) => m.id === 'thief')!.problems.join(' ')).toMatch(/event core logs/);
    expect(NODES.has('thief')).toBe(false);
    const rows = servedKinds(mods).kinds.find((k) => k.kind === 'subagent')!.rows!;
    expect(Object.keys(rows).sort()).toEqual(['subagent_result', 'subagent_started']);
    expect(JSON.stringify(servedKinds(mods).kinds)).not.toContain('stolen');
  });
});

describe('a Customize copy of subagent', () => {
  it('is served with its rows after the restart; the copy of model keeps hiding model_switched', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-m3tz-')));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const bundled = path.join(root, 'bundled');
    for (const id of ['phase', 'say', 'end', 'model', 'subagent']) build(id, path.join(bundled, id));
    const home = path.join(root, '.reins');
    fs.mkdirSync(home, { recursive: true });
    let mods = await startMods({ dir: home, env: {}, bundledDir: bundled });
    cleanups.push(() => mods.dispose());
    for (const id of ['subagent', 'model']) expect((await customizeMod(envOf(home, () => mods), id, { trust: true })).status, id).toBe(200);
    mods.dispose();
    mods = await startMods({ dir: home, env: {}, bundledDir: bundled });
    for (const id of ['subagent', 'model']) expect(mods.mods.find((m) => m.id === id), id).toMatchObject({ source: 'user', replaces: 'bundled', problems: [] });
    const served = servedKinds(mods).kinds;
    expect(Object.keys(served.find((k) => k.kind === 'subagent')!.rows!).sort()).toEqual(['subagent_result', 'subagent_started']);
    expect(served.find((k) => k.kind === 'model')!.hidden).toEqual(['model_switched']);
    expect(NODES.get('subagent')?.mod?.id).toBe('subagent');
  });
});
