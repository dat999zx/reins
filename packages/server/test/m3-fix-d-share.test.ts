// M3 fix D, item 5: the share file holds what a workflow needs besides block kinds. A user condition or card mod the workflow uses (a step's `until:`, a
// `whenever` auto, a card line) goes in the file like a block mod does, and a playbook's file from `blocks/` (which is NOT carried) is named in `notes`, once per
// name. A built-in condition or card is never added. The homes are `tempHome` folders and the loader is the real one; every mod here is made at run time.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { parseWorkflow, validate } from '@reins/core';
import { startMods } from '../src/engines.js';
import { exportBundle, importApply, importPreview, type ModEnv } from '../src/mods/actions.js';
import { hashFiles, readFolder } from '../src/mods/loader.js';
import type { Mods } from '../src/mods/types.js';
import { tempHome } from './mods-harness.js';

const PACK = fileURLToPath(new URL('../src/mods/', import.meta.url));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });

type Home = ReturnType<typeof tempHome>;
const trust = (home: string, ids: string[]) => {
  const file = path.join(home, 'mod-trust.json');
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  for (const id of ids) all[id] = hashFiles(readFolder(path.join(home, 'mods', id), id));
  fs.writeFileSync(file, JSON.stringify(all));
};
const envOf = (h: Home, mods: Mods): ModEnv => ({ home: h.home, catalogDir: path.join(h.home, 'no-catalog'), mods, consent: { has: () => false, grant: () => {}, revoke: () => {} } as never, send: async () => new Response(''), env: {}, redact: (t: string) => t, holdsSecret: () => false });
/** A home with these mods written and trusted BEFORE the loader starts (a condition or card mod takes effect at start). */
async function world(prep: (h: Home) => string[] = () => []) {
  const h = tempHome();
  const ids = prep(h);
  trust(h.home, ids);
  const mods = await startMods({ dir: h.home, env: {} });
  const w = { h, mods, env: envOf(h, mods), close: () => { mods.dispose(); h.cleanup(); } };
  cleanups.push(w.close);
  return w;
}
const stop = (w: { close: () => void }) => { w.close(); cleanups.pop(); };

const condMod = (id: string, name: string, say: string) => ({
  'mod.json': JSON.stringify({ reins: 1, id, kind: 'condition', version: '1.0.0', label: id, main: 'index.js', order: 25, provides: { conditions: [name] } }),
  'index.js': `export default function activate(api) { api.registerCondition({ t: '${name}', parse(s) { if (!s.src.startsWith('${say}', s.idx)) return null; s.idx += ${say.length}; return { t: '${name}' }; }, print: () => '${say}', judge: 'agent', evalSync: () => true }); }\n`,
});
const cardMod = (id: string, kind: string) => ({
  'mod.json': JSON.stringify({ reins: 1, id, kind: 'card', version: '1.0.0', label: id, main: 'index.js', order: 25, provides: { cards: [kind] } }),
  'index.js': `export default function activate(api) { api.registerCard({ kind: '${kind}' }); }\n`,
});
const put = (h: Home, id: string, files: Record<string, string>) => { const { 'mod.json': m, ...rest } = files; h.writeMod(id, JSON.parse(m!), rest); return id; };

/** A user copy of a pack mod (what Customize makes): the bundled files without `pack`, the code compiled. */
function copyOfPack(h: Home, id: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(PACK, id, 'mod.json'), 'utf8'));
  delete manifest.pack;
  delete manifest.required;
  const js = ts.transpileModule(fs.readFileSync(path.join(PACK, id, 'index.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  h.writeMod(id, manifest, { 'index.js': js });
  return id;
}

const head = '---\nreins: 1\nname: share\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n';
const wf = (body: string) => ({ name: 'share', text: head + body });
const body = (r: { body: unknown }) => r.body as Record<string, any>;
const words = (r: { body: unknown }) => JSON.stringify(r.body);
const sent = (w: { env: ModEnv }, workflow: { name: string; text: string }) => { const r = exportBundle(w.env, { workflow }); expect(r.status, words(r)).toBe(200); return body(r); };

describe('a condition from a user mod', () => {
  it('in a repeat\'s until: the mod is in the file', async () => {
    const w = await world((h) => [put(h, 'cm-ping', condMod('cm-ping', 'pingy', 'ping works'))]);
    const r = sent(w, wf('## repeat\nmax: 3\nuntil: ping works\n\n### phase work\n> go\n'));
    expect(r.ids).toEqual(['cm-ping']);
    expect(Object.keys(JSON.parse(r.text).mods)).toEqual(['cm-ping']);
    expect(r.notes).toEqual([]);
  });
  it('inside and/or/not, and in nested steps (a repeat in an if\'s else)', async () => {
    const w = await world((h) => [put(h, 'cm-ping', condMod('cm-ping', 'pingy', 'ping works'))]);
    const nested = wf('## if tests pass\n\n### phase a\n> a\n\n### else\n\n### repeat\nmax: 2\nuntil: not (ping works and you approve)\n\n#### phase b\n> b\n');
    expect(parseWorkflow(nested.text).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(sent(w, nested).ids).toEqual(['cm-ping']);
  });
  it('in a whenever auto', async () => {
    const w = await world((h) => [put(h, 'cm-ping', condMod('cm-ping', 'pingy', 'ping works'))]);
    expect(sent(w, wf('## phase a\n> a\n\n## whenever ping works\nnow: look\n')).ids).toEqual(['cm-ping']);
  });
  it('a built-in condition is never added', async () => {
    const w = await world((h) => [put(h, 'cm-ping', condMod('cm-ping', 'pingy', 'ping works'))]);
    const r = sent(w, wf('## repeat\nmax: 3\nuntil: tests pass and agent says done\n\n### phase work\n> go\n\n## phase b\n> b\n\n## whenever attempts > 2\nnow: look\n'));
    expect(r.ids).toEqual([]);
    expect(r.notes).toEqual([]);
  });
  it('an unused condition mod is not added, and two uses of one mod add it once', async () => {
    const w = await world((h) => [put(h, 'cm-ping', condMod('cm-ping', 'pingy', 'ping works')), put(h, 'cm-other', condMod('cm-other', 'otherly', 'other works'))]);
    const r = sent(w, wf('## repeat\nmax: 3\nuntil: ping works\n\n### phase work\n> go\n\n## whenever ping works\nnow: look\n'));
    expect(r.ids).toEqual(['cm-ping']);
  });
  it('a user copy of a built-in condition (Customize) is carried; the built-in itself is not', async () => {
    const own = await world();
    expect(sent(own, wf('## repeat\nmax: 3\nuntil: agent says done\n\n### phase work\n> go\n')).ids).toEqual([]);
    stop(own);
    const w = await world((h) => [copyOfPack(h, 'cond-done')]);
    expect(w.mods.mods.find((m) => m.id === 'cond-done')).toMatchObject({ source: 'user', replaces: 'bundled' });
    const r = sent(w, wf('## repeat\nmax: 3\nuntil: agent says done\n\n### phase work\n> go\n'));
    expect(r.ids).toEqual(['cond-done']);
  });
  it('a condition named like a block kind is not that block (the lists are kept apart), and the other way round', async () => {
    const w = await world((h) => [put(h, 'cm-store', condMod('cm-store', 'store', 'store is ready'))]);
    // the user mod brings the condition `store`; the workflow's STEP `store` is the pack block, which needs nothing from the file
    expect(sent(w, wf('## store\nstore: some notes\n')).ids).toEqual([]);
    expect(sent(w, wf('## repeat\nmax: 2\nuntil: store is ready\n\n### phase a\n> a\n')).ids).toEqual(['cm-store']);
  });
});

describe('a card from a user mod', () => {
  it('a card line on a step, and a card of a whenever block', async () => {
    const w = await world((h) => [put(h, 'cd-zap', cardMod('cd-zap', 'zap')), put(h, 'cd-unused', cardMod('cd-unused', 'idle'))]);
    const onStep = wf('## phase one\nzap: careful\n> go\n');
    expect(parseWorkflow(onStep.text).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(sent(w, onStep).ids).toEqual(['cd-zap']);
    expect(sent(w, wf('## phase one\n> go\n\n## whenever tests pass\nzap: look\n')).ids).toEqual(['cd-zap']);
  });
  it('a built-in card is never added', async () => {
    const w = await world((h) => [put(h, 'cd-zap', cardMod('cd-zap', 'zap'))]);
    expect(sent(w, wf('## phase one\n> go\n\n## whenever attempts > 2\nnow: look\n\n## whenever tests pass\nguard: src/**\n')).ids).toEqual([]);
  });
});

describe('a playbook is a file of this computer and is not in the file', () => {
  const note = (name: string) => `The playbook ${name} is a file in your blocks folder and is not in this file. Whoever imports the file needs a playbook with that name.`;
  it('one note for the name, and the workflow is still in the file', async () => {
    const w = await world();
    const r = sent(w, wf('## playbook review-pass\n\n## phase one\n> go\n'));
    expect(r.notes).toEqual([note('review-pass')]);
    expect(r.missing).toEqual([]);
    expect(JSON.parse(r.text).workflow.text).toContain('## playbook review-pass');
    expect(r.ids).toEqual([]);
  });
  it('a playbook inside a repeat and inside an else is found', async () => {
    const w = await world();
    const r = sent(w, wf('## repeat\nmax: 2\nuntil: you approve\n\n### playbook inner-one\n\n## if tests pass\n\n### phase a\n> a\n\n### else\n\n### playbook other-two\n'));
    expect(r.notes).toEqual([note('inner-one'), note('other-two')]);
  });
  it('two playbooks with one name give one note; two names give two', async () => {
    const w = await world();
    expect(sent(w, wf('## playbook same-name\n\n## phase a\n> a\n\n## playbook same-name\n')).notes).toEqual([note('same-name')]);
    expect(sent(w, wf('## playbook one\n\n## playbook two\n')).notes).toEqual([note('one'), note('two')]);
  });
  it('a name is shown as text, never as markup or a hidden character', async () => {
    const w = await world();
    const r = sent(w, wf('## playbook a<b>c\n'));
    expect(r.notes).toEqual([note('a<b>c')]);
  });
  it('a name with a hidden character never reaches a note: the workflow itself is refused, and a long name is cut', async () => {
    const w = await world();
    expect(exportBundle(w.env, { workflow: wf('## playbook ab‮cd\n') }).status).toBe(400);
    const r = sent(w, wf(`## playbook ${'n'.repeat(500)}\n`));
    expect(r.notes[0]).toContain(`${'n'.repeat(80)}... is a file`);
    expect(r.notes[0]).not.toContain('n'.repeat(81));
  });
  it('the note comes after the notes about blocks nobody brings', async () => {
    const w = await world();
    const r = sent(w, wf('## playbook one\n\n## ghost\n'));
    expect(r.notes[0]).toMatch(/block "ghost"/);
    expect(r.notes[1]).toBe(note('one'));
    expect(r.notes).toHaveLength(2);
  });
  it('a workflow with no playbook has no such note', async () => {
    const w = await world();
    expect(sent(w, wf('## phase one\n> go\n')).notes).toEqual([]);
  });
});

describe('export, then import into a second home', () => {
  it('a user condition mod and a user card mod travel; the second home reads the workflow with no error after a restart', async () => {
    const a = await world((h) => [put(h, 'cm-ping', condMod('cm-ping', 'pingy', 'ping works')), put(h, 'cd-zap', cardMod('cd-zap', 'zap'))]);
    const text = wf('## repeat\nmax: 3\nuntil: ping works\n\n### phase work\nzap: careful\n> go\n\n## playbook shared-one\n');
    const out = sent(a, text);
    expect(out.ids).toEqual(['cd-zap', 'cm-ping']);
    expect(out.notes).toEqual([`The playbook shared-one is a file in your blocks folder and is not in this file. Whoever imports the file needs a playbook with that name.`]);
    const file = out.text as string;
    stop(a);

    const b = await world();
    // before the import the second home cannot read the workflow
    expect(parseWorkflow(text.text).diagnostics.filter((d) => d.severity === 'error')).not.toEqual([]);
    const p = importPreview(b.env, file);
    expect(p.status, words(p)).toBe(200);
    expect(body(p).summary.mods.map((m: any) => m.id)).toEqual(['cd-zap', 'cm-ping']);
    const trusted = Object.fromEntries(body(p).summary.mods.map((m: any) => [m.id, m.hash]));
    const r = await importApply(b.env, { file, trust: trusted });
    expect(r.status, words(r)).toBe(200);
    const saved = fs.readFileSync(path.join(b.h.home, 'workflows', 'share.reins.md'), 'utf8');
    expect(saved).toBe(text.text);
    const home = b.h.home;
    b.mods.dispose();
    cleanups.pop();
    const again = await startMods({ dir: home, env: {} });
    cleanups.push(() => { again.dispose(); b.h.cleanup(); });
    const parsed = parseWorkflow(saved);
    expect(parsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(validate(parsed.workflow!).filter((d) => d.message.startsWith('Unknown'))).toEqual([]);
  });
});
