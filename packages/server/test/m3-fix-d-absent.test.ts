// M3 fix D, item 10: a workflow that uses a block whose mod is not in force gets more than a bare `Unknown step kind`: the line says which mod the block comes
// with and why it is not here (switched off in Settings, waiting for trust, did not load). One place makes the line (core's `unknownKind`, from the loader's
// `ABSENT_KINDS`), so the parse, `validate`, the editor's check, `reins check`, `reins run` and the chat's tags all say the same words. A kind nobody brings
// keeps the bare line, and nothing outlives the load that wrote it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ABSENT_KINDS, FakeEngine, NODES, parseWorkflow, validate } from '@reins/core';
import { startMods } from '../src/engines.js';
import { importPreview } from '../src/mods/actions.js';
import { hashFiles, readFolder } from '../src/mods/loader.js';
import { formatDiagnostic, loadWorkflow, startRunCli } from '../src/run-cli.js';
import { openStore } from '../src/store.js';
import { taggedWorkflow } from '../src/tags.js';
import { tempHome } from './mods-harness.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });
const head = '---\nreins: 1\nname: t\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n';
const OFF = 'Unknown step kind "recall": it comes with the mod recall, which is switched off in Settings';

async function start(prep: (h: ReturnType<typeof tempHome>) => void = () => {}) {
  const h = tempHome();
  prep(h);
  const mods = await startMods({ dir: h.home, env: {} });
  cleanups.push(() => { mods.dispose(); h.cleanup(); });
  return { h, mods };
}
const off = (...ids: string[]) => (h: ReturnType<typeof tempHome>) => fs.writeFileSync(path.join(h.home, 'disabled-mods.json'), JSON.stringify(ids));
const blockMod = (id: string, kind: string, js: string) => (h: ReturnType<typeof tempHome>) => {
  h.writeMod(id, { reins: 1, id, kind: 'block', version: '1.0.0', label: id, main: 'index.js', order: 1, provides: { kinds: [kind] }, view: { kind, order: 5, colour: 'soft', fields: [], line: [kind], fresh: {} } }, { 'index.js': js });
};
const works = (kind: string) => `export default function activate(api) { api.registerBlock({ kind: ${JSON.stringify(kind)}, attrs: [], compile(step, ctx) { ctx.push({ op: 'END' }); } }); }\n`;
const trust = (home: string, id: string) => fs.writeFileSync(path.join(home, 'mod-trust.json'), JSON.stringify({ [id]: hashFiles(readFolder(path.join(home, 'mods', id), id)) }));
const messages = (text: string) => { const p = parseWorkflow(text); return [...p.diagnostics, ...(p.workflow ? validate(p.workflow) : [])].map((d) => d.message); };

describe('a pack mod switched off', () => {
  it('the parse and validate say which mod and why', async () => {
    await start(off('recall'));
    expect(NODES.has('recall')).toBe(false);
    const p = parseWorkflow(`${head}## recall\nrecall: topic\n`);
    expect(p.diagnostics.map((d) => d.message)).toContain(OFF);
    expect(validate(p.workflow!).map((d) => d.message)).toContain(OFF);
    expect(messages(`${head}## recall\nrecall: topic\n`).every((m) => !/^Unknown step kind "recall"$/.test(m))).toBe(true);   // never the bare line for it
  });
  it('the import preview of a file whose workflow uses it says the same, and a block the file itself brings says that instead', async () => {
    const { mods, h } = await start(off('recall'));
    const env = { home: h.home, catalogDir: path.join(h.home, 'no-catalog'), mods, consent: { has: () => false, grant: () => {}, revoke: () => {} } as never, send: async () => new Response(''), env: {}, redact: (t: string) => t, holdsSecret: () => false };
    const r = importPreview(env, { reinsMods: 1, mods: {}, workflow: { name: 'w', text: `${head}## recall\nrecall: topic\n\n## ghost\n> x\n` } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as { summary: { workflow: { diagnostics: string[] } } }).summary.workflow.diagnostics).toEqual([OFF, 'Unknown step kind "ghost"']);
  });
  it('a kind nobody brings keeps the bare line, and a mod that is on has no hint', async () => {
    await start(off('recall'));
    expect(messages(`${head}## ghost\n> x\n`)).toContain('Unknown step kind "ghost"');
    expect(ABSENT_KINDS.has('ghost')).toBe(false);
    expect(ABSENT_KINDS.has('say')).toBe(false);
    expect(ABSENT_KINDS.has('store')).toBe(false);
  });
  it('a mod that is switched on again says nothing, and a stopped load leaves no words behind', async () => {
    const a = await start(off('recall'));
    expect(ABSENT_KINDS.get('recall')).toMatch(/switched off in Settings/);
    a.mods.dispose();
    expect(ABSENT_KINDS.has('recall')).toBe(false);
    await start();
    expect(NODES.has('recall')).toBe(true);
    expect(ABSENT_KINDS.size).toBe(0);
  });
  it('a required mod that a hand-edited list names stays on and has no hint', async () => {
    await start(off('phase', 'end'));
    expect(NODES.has('phase')).toBe(true);
    expect(ABSENT_KINDS.has('phase')).toBe(false);
  });
  it('two mods off give two hints, each its own', async () => {
    await start(off('recall', 'store'));
    expect(messages(`${head}## recall\nrecall: a\n\n## store\nstore: b\n`)).toEqual(expect.arrayContaining([OFF, 'Unknown step kind "store": it comes with the mod store, which is switched off in Settings']));
  });
});

describe('a user mod that is not in force', () => {
  it('one that waits for trust, and one that did not load, say so; one that works says nothing', async () => {
    await start((h) => {
      blockMod('wait-mod', 'waitk', works('waitk'))(h);          // never trusted
      blockMod('broke-mod', 'brokek', 'export default function activate() { throw new Error("boom"); }\n')(h);
      blockMod('fine-mod', 'finek', works('finek'))(h);
      trust(h.home, 'broke-mod');
    });
    expect(NODES.has('finek')).toBe(false); // untrusted too: only trusted code runs
    const m = messages(`${head}## waitk\n> x\n\n## brokek\n> x\n`);
    expect(m).toContain('Unknown step kind "waitk": it comes with the mod wait-mod, which is waiting for your trust in Settings');
    expect(m).toContain('Unknown step kind "brokek": it comes with the mod broke-mod, which is not loaded (Settings says why)');
  });
  it('a mod that is switched off', async () => {
    await start((h) => { blockMod('mine', 'minek', works('minek'))(h); trust(h.home, 'mine'); off('mine')(h); });
    expect(messages(`${head}## minek\n> x\n`)).toContain('Unknown step kind "minek": it comes with the mod mine, which is switched off in Settings');
  });
  it('only a block mod can stand behind a block: a switched-off condition mod that lists kinds adds no hint', async () => {
    await start((h) => {
      h.writeMod('liar', { reins: 1, id: 'liar', kind: 'condition', version: '1.0.0', label: 'liar', main: 'index.js', order: 25, provides: { conditions: ['lie'], kinds: ['lying'] } }, { 'index.js': 'export default function activate() {}\n' });
      off('liar')(h);
    });
    expect(ABSENT_KINDS.has('lying')).toBe(false);
    expect(messages(`${head}## lying\n> x\n`)).toContain('Unknown step kind "lying"');
  });
  it('a manifest with odd kind names adds nothing odd', async () => {
    await start((h) => {
      h.writeMod('odd', { reins: 1, id: 'odd', kind: 'block', version: '1.0.0', label: 'odd', main: 'index.js', order: 1, provides: { kinds: ['bad kind', '__proto__', 'x‮y', 7, 'a'.repeat(80)] }, view: { kind: 'x', order: 5, colour: 'soft', fields: [], line: ['x'], fresh: {} } }, { 'index.js': works('x') });
    });
    expect([...ABSENT_KINDS.keys()].filter((k) => k !== '__proto__')).toEqual([]);
    expect(ABSENT_KINDS.has('bad kind')).toBe(false);
    expect(ABSENT_KINDS.has('x‮y')).toBe(false);
  });
});

describe('the other places that say it', () => {
  it('`reins check` and `reins run` print the words and run nothing', async () => {
    await start(off('recall'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-absent-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'w.reins.md');
    fs.writeFileSync(file, `${head}## recall\nrecall: topic\n`);
    const { diagnostics } = loadWorkflow(file);
    expect(diagnostics.map((d) => formatDiagnostic(file, d)).some((l) => l.endsWith(`error: ${OFF}`))).toBe(true);
    const output = new PassThrough();
    let text = '';
    output.setEncoding('utf8');
    output.on('data', (d: string) => { text += d; });
    const store = openStore(':memory:');
    const engine = new FakeEngine([{ text: 'never' }]);
    const res = await startRunCli({ file, cwd: dir, store, yes: true, input: new PassThrough(), output, makeEngine: () => engine }).done;
    store.close();
    expect(engine.receivedTexts).toEqual([]);
    expect(text).toContain(OFF);
    expect(res.status).not.toBe('done');
  });
  it('the chat tag of a switched-off block says it, and the same tag works when the mod is on', async () => {
    await start(off('recall'));
    const r = taggedWorkflow('hello', [{ tag: 'recall' }]);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('unknown tag "recall": it comes with the mod recall, which is switched off in Settings');
    const nope = taggedWorkflow('hello', [{ tag: 'nothing-here' }]);
    expect((nope as { error: string }).error).toBe('unknown tag "nothing-here"');
  });
});
