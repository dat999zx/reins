// M3 fix round, group B, item 3: a Customize copy of a built-in block prints what the built-in printed. The copy is made through the real loader path (the built
// pack folders, Customize with trust, a restart), then workflows with a long command, a long title, a tab and a long default id are parsed and printed. The bytes must not
// change and a `next:` that names a long default id must still resolve. A foreign mod's block is still cut.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { NODES, parseWorkflow, printWorkflow, validate } from '@reins/core';
import { startMods } from '../src/engines.js';
import { customizeMod, listMods, trustMod, type ModEnv } from '../src/mods/actions.js';
import type { Mods } from '../src/mods/types.js';
import { PACK_DIR, packMods } from '../../core/test/pack.js';

const rm = (d: string) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the OS */ } };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });

/** The pack folders compiled flat into `out`, as the build makes them. */
function buildPack(out: string): void {
  for (const p of packMods(PACK_DIR)) {
    fs.mkdirSync(path.join(out, p.id), { recursive: true });
    for (const f of fs.readdirSync(p.dir)) {
      if (f.endsWith('.d.ts')) continue;
      const text = fs.readFileSync(path.join(p.dir, f), 'utf8');
      if (f.endsWith('.ts')) fs.writeFileSync(path.join(out, p.id, f.replace(/\.ts$/, '.js')), ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true } }).outputText);
      else fs.writeFileSync(path.join(out, p.id, f), text);
    }
  }
}
const envOf = (home: string, mods: () => Mods): ModEnv => ({
  home, catalogDir: path.join(home, 'no-catalog'), get mods() { return mods(); }, consent: { has: () => false, grant: () => {}, revoke: () => {} } as never,
  send: async () => new Response(''), env: {}, redact: (t: string) => t, holdsSecret: () => false,
});

const CUSTOMIZED = ['run', 'phase', 'if', 'gate', 'playbook'];
const FRONT = '---\nreins: 1\nname: t\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n';
const CMD = `npm test -- ${'x'.repeat(236)}`;                   // 250 characters
const TITLE = `Title ${'t'.repeat(204)}`;                       // 210 characters
const LONG = `Long ${'l'.repeat(115)}`;                         // its default id is the slug: well over 80 characters
const COND = `llm says "${'c'.repeat(230)}"`;
const BODY = [
  `## run \`${CMD}\``,
  `## phase ${TITLE}\n> go`,
  `## phase a\tb\n> tab`,
  `## phase ${LONG}\n> long`,
  `## if ${COND}\n\n### phase inner\n> in`,
  `## gate\nuntil: ${COND}`,
  `## playbook ${'p'.repeat(250)}`,
  '## end',
].join('\n\n') + '\n';

async function world(customize: string[]): Promise<{ mods: Mods }> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-fixb-')));
  cleanups.push(() => rm(root));
  const bundled = path.join(root, 'bundled');
  buildPack(bundled);
  const home = path.join(root, '.reins');
  fs.mkdirSync(home, { recursive: true });
  let mods = await startMods({ dir: home, env: {}, bundledDir: bundled });
  for (const id of customize) expect((await customizeMod(envOf(home, () => mods), id, { trust: true })).status).toBe(200);
  mods.dispose();
  mods = await startMods({ dir: home, env: {}, bundledDir: bundled });
  cleanups.push(() => mods.dispose());
  for (const id of customize) expect(mods.mods.find((m) => m.id === id), id).toMatchObject({ source: 'user', replaces: 'bundled', problems: [] });
  return { mods };
}
const roundTrip = (text: string): string => printWorkflow(parseWorkflow(text).workflow!);

describe('M3 fix B item 3: a Customize copy prints like the built-in', () => {
  it('the built-in itself keeps long text, a tab and long ids (the baseline)', async () => {
    await world([]);
    const out = roundTrip(FRONT + BODY);
    expect(out).toContain(`\`${CMD}\``);
    expect(out).toContain(TITLE);
    expect(out).toContain('a\tb');
    expect(out).not.toContain('<U+');
    expect(out).not.toContain('...');
  });

  it('with run, phase, if, gate and playbook customized, the same file prints the same bytes', async () => {
    await world([]);
    const base = roundTrip(FRONT + BODY);
    cleanups.pop()!(); cleanups.pop()!();   // the baseline world goes
    await world(CUSTOMIZED);
    for (const k of CUSTOMIZED) expect(NODES.has(k), k).toBe(true);
    const out = roundTrip(FRONT + BODY);
    expect(out).toBe(base);
    expect(out).toContain(`\`${CMD}\``);
    expect(out).toContain(TITLE);
    expect(out).toContain('a\tb');
    expect(out).not.toContain('<U+');
    expect(out).not.toContain('...');
  });

  it('a saved `next:` that names a long default id still resolves with phase customized', async () => {
    await world(['phase']);
    const slug = parseWorkflow(`${FRONT}## phase ${LONG}\n> long\n\n## end\n`).workflow!.steps[0]!.id;
    expect(slug.length).toBeGreaterThan(80);
    expect(slug.endsWith('...')).toBe(false);
    const saved = roundTrip(`${FRONT}## phase first\nnext: ${slug}\n> x\n\n## phase skipped\n> y\n\n## phase ${LONG}\n> long\n\n## end\n`);
    expect(saved).toContain(`next: ${slug}`);
    const again = parseWorkflow(saved);
    expect(validate(again.workflow!).filter((d) => d.severity === 'error').map((d) => d.message)).toEqual([]);
  });

  it('a foreign mod\'s block is still cut (a user mod with a kind of its own, trusted and in force)', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-fixb-')));
    cleanups.push(() => rm(root));
    const bundled = path.join(root, 'bundled');
    buildPack(bundled);
    const home = path.join(root, '.reins');
    const zork = path.join(home, 'mods', 'zork');
    fs.mkdirSync(zork, { recursive: true });
    fs.writeFileSync(path.join(zork, 'mod.json'), JSON.stringify({ reins: 1, id: 'zork', kind: 'block', version: '1.0.0', label: 'Zork', main: 'index.js', order: 500, provides: { kinds: ['zork'], attrs: [] }, view: { kind: 'zork', order: 500, colour: 'soft', fields: [], line: ['zork'], card: { label: 'zork', section: 'Flow' }, fresh: {} } }));
    fs.writeFileSync(path.join(zork, 'index.js'), `export default function activate(api) {
  api.registerBlock({ kind: 'zork', attrs: [], compile() {},
    heading: { parse(arg, step) { step.title = arg; return true; }, print(step) { return { text: 'zork ' + step.title, condInHeading: false }; } },
    defaultId(step) { return step.title; } });
}
`);
    let mods = await startMods({ dir: home, env: {}, bundledDir: bundled });
    const env = envOf(home, () => mods);
    const hash = ((await listMods(env)).body as { mods: Array<Record<string, any>> }).mods.find((m) => m.id === 'zork')!.hash;
    expect((await trustMod(env, 'zork', { hash })).status).toBe(200);
    mods.dispose();
    mods = await startMods({ dir: home, env: {}, bundledDir: bundled });
    cleanups.push(() => mods.dispose());
    expect(mods.mods.find((m) => m.id === 'zork')).toMatchObject({ source: 'user', problems: [], trusted: true });
    expect(NODES.has('zork')).toBe(true);
    const out = roundTrip(`${FRONT}## zork ${'z'.repeat(250)}\n\n## zork a\tb\n\n## end\n`);
    expect(out).not.toContain('z'.repeat(250));                // cut, as a foreign mod's text is
    expect(out).toContain(`zork ${'z'.repeat(195)}...`);
    expect(out).toContain('zork a\\tb');                       // a hidden character is shown, not kept
  });

  it('a user mod that names a built-in kind is not a copy: the registry refuses it and the built-in stays in force', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-fixb-')));
    cleanups.push(() => rm(root));
    const bundled = path.join(root, 'bundled');
    buildPack(bundled);
    const home = path.join(root, '.reins');
    const evil = path.join(home, 'mods', 'evil');
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(evil, 'mod.json'), JSON.stringify({ reins: 1, id: 'evil', kind: 'block', version: '1.0.0', label: 'Evil', main: 'index.js', order: 5, provides: { kinds: ['phase'], attrs: [] }, view: { kind: 'phase', order: 5, colour: 'soft', fields: [], line: ['phase'], card: { label: 'phase', section: 'Flow' }, fresh: {} } }));
    fs.writeFileSync(path.join(evil, 'index.js'), "export default function activate(api) { api.registerBlock({ kind: 'phase', attrs: [], compile() {} }); }\n");
    const mods = await startMods({ dir: home, env: {}, bundledDir: bundled });
    cleanups.push(() => mods.dispose());
    const row = mods.mods.find((m) => m.id === 'evil')!;
    expect(row.problems.length + (row.enabled ? 0 : 1) + (row.trusted ? 0 : 1)).toBeGreaterThan(0);   // refused, or waiting for trust: never in force as a copy
    expect(NODES.get('phase')!.mod).toMatchObject({ id: 'phase', pack: true });   // the built-in phase is still the one in force
  });
});
