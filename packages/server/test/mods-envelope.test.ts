// M3 Task 14 (Group E): the shareable envelope { reinsMods: 1, mods: { <id>: files }, workflow?: { name, text } }. Imports run strangers' code after a trust prompt, so
// the hostile cases come first: every one is refused by the preview AND the apply, with a byte-for-byte equal home and an equal core afterwards. Then trust (one
// choice per code mod, by hash), all-or-nothing installs, the unknown-kind words, export, the round trip into a second home, and the old `reinsMod` file.
// The homes are `tempHome` folders and the loader is the real one (the default pack is loaded by it); every mod here is made at run time.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NODES } from '@reins/core';
import { makeEngineFrom, startMods } from '../src/engines.js';
import { exportBundle, importApply, importPreview, listMods, type ModEnv } from '../src/mods/actions.js';
import type { Mods } from '../src/mods/types.js';
import { startServer } from '../src/server.js';
import { openStore } from '../src/store.js';
import { PROBE } from './http-helpers.js';
import { tempHome } from './mods-harness.js';

const KEY = 'sk-test-0123456789abcdef';
interface World { t: ReturnType<typeof tempHome>; mods: Mods; env: ModEnv }
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) { w.mods.dispose(); w.t.cleanup(); } });

async function world(): Promise<World> {
  const t = tempHome();
  const mods = await startMods({ dir: t.home, env: {} });
  const w: World = {
    t, mods,
    env: { home: t.home, catalogDir: path.join(t.home, 'no-catalog'), mods, consent: { has: () => false, grant: () => {}, revoke: () => {} }, send: async () => new Response(''), env: {}, redact: (x) => x, holdsSecret: (x) => x.includes(KEY) },
  };
  worlds.push(w);
  return w;
}
const close = (w: World) => { worlds.splice(worlds.indexOf(w), 1); w.mods.dispose(); w.t.cleanup(); };

/** Every file under the home, as { relative path: sha256 }; a folder is a key too. Equal before and after means nothing was written, moved or left behind. */
function snap(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      const rel = path.relative(home, p).replaceAll('\\', '/');
      if (e.isDirectory()) { out[`${rel}/`] = 'dir'; walk(p); } else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(home);
  return out;
}
const coreKinds = () => JSON.stringify([...NODES.keys()]);

const view = (kind: string, order: number) => ({
  kind, order, colour: 'soft', fields: [{ key: 'times', label: 'Times', input: 'number', check: 'count' }], line: [kind, { field: 'times' }],
  card: { label: kind, section: 'Flow' }, fresh: { attrs: { times: '1' } },
});
const j = (m: unknown) => JSON.stringify(m, null, 2);
/** A code block mod `eb<n>` that brings the kind `ebk<n>`; `over` changes the manifest, `code` the code. */
function codeMod(n: number, over: Record<string, unknown> = {}, code = ''): Record<string, string> {
  const kind = `ebk${n}`;
  const K = kind.toUpperCase();
  return {
    'mod.json': j({ reins: 1, id: `eb${n}`, kind: 'block', version: '1.0.0', label: `Eb ${n}`, main: 'index.js', order: 160 + n, provides: { kinds: [kind], ops: [`OP_${K}`], attrs: ['times'], events: [`${kind}ran`] }, view: view(kind, 160 + n), ...over }),
    'index.js': `export default function activate(api) {
  api.registerBlock({ kind: '${kind}', attrs: ['times'], compile(step, ctx) { ctx.push({ op: 'OP_${K}', step: step.id }); },
    ops: { OP_${K}: { async exec(i, vm) { vm.log('${kind}ran', { step: i.step }); vm.next(); } } } });
}
${code}`,
  };
}
/** A mod with no code: a provider (it only names a protocol that Reins has). */
const dataMod = (id: string, over: Record<string, unknown> = {}): Record<string, string> => ({
  'mod.json': j({ reins: 1, id, kind: 'provider', version: '1.0.0', label: `Data ${id}`, protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1', auth: { style: 'none', keyEnv: [] }, defaultModel: 'm-1', models: [{ id: 'm-1', label: 'M1', context: 100000, maxOutput: 4000, tools: true }], ...over }),
});
const env1 = (mods: Record<string, unknown>, workflow?: unknown) => ({ reinsMods: 1, mods, ...(workflow !== undefined ? { workflow } : {}) });
const head = '---\nreins: 1\nname: share\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n';
const wf = (...kinds: string[]) => ({ name: 'share', text: head + kinds.map((k) => `## ${k}\ntimes: 2\n\n`).join('') + '## phase one\n> go\n' });
const body = (r: { body: unknown }) => r.body as Record<string, any>;
const words = (r: { body: unknown }) => JSON.stringify(r.body);

/** Preview and apply (with every choice a hostile sender could hope for) both refuse; the home and core are as they were; the key never comes back. */
async function refused(w: World, file: unknown, want?: RegExp) {
  const before = snap(w.t.home);
  const kinds = coreKinds();
  const ids = typeof file === 'object' ? Object.keys((file as { mods?: object })?.mods ?? {}).filter((i) => /^[a-z0-9-]{1,40}$/.test(i)).slice(0, 20) : [];
  const p = importPreview(w.env, file);
  const a = await importApply(w.env, { file, ...(ids.length ? { trust: Object.fromEntries(ids.map((i) => [i, 'x'])), replaceBuiltin: ids } : {}) });
  for (const r of [p, a]) {
    expect(r.status, words(r)).toBeGreaterThanOrEqual(400);
    expect(words(r)).not.toContain(KEY);
    if (want) expect(words(r)).toMatch(want);
  }
  expect(snap(w.t.home)).toEqual(before);
  expect(coreKinds()).toBe(kinds);
  return { p, a };
}
/** The hash the preview shows for each code mod. */
const hashes = (file: unknown, w: World) => Object.fromEntries((() => { const r = importPreview(w.env, file); if (r.status !== 200) throw new Error(words(r)); return body(r).summary.mods as any[]; })().filter((m) => m.hasCode).map((m) => [m.id, m.hash as string]));

describe('hostile envelopes are refused whole', () => {
  it('a 10 000-mod envelope (as an object, and as text)', async () => {
    const w = await world();
    const mods = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`m${i}`, dataMod(`m${i}`)]));
    await refused(w, env1(mods), /the most is 20/);
    await refused(w, JSON.stringify(env1(mods)), /larger than 1 MB|the most is 20/);
  });
  it('21 mods is over the count, 20 is not', async () => {
    const w = await world();
    const many = (n: number) => env1(Object.fromEntries(Array.from({ length: n }, (_, i) => [`m${i}`, dataMod(`m${i}`)])));
    await refused(w, many(21), /the most is 20/);
    expect(importPreview(w.env, many(20)).status).toBe(200);
  });
  it.each(['..', '.', 'a/b', 'a\\b', '../x', 'A', 'Eb1', 'con', '', 'x'.repeat(41), '__proto__', 'a b', '-x', 'a\0b', 'ebé'])('a mod named %j', async (name) => {
    const w = await world();
    const file = JSON.parse(`{"reinsMods":1,"mods":{${JSON.stringify(name)}:${JSON.stringify(dataMod('victim'))}}}`);
    await refused(w, file, /mod id in the file must be/);
    expect(fs.existsSync(path.join(w.t.home, 'mods', 'victim'))).toBe(false);
  });
  it('the key and the id inside mod.json must agree; two keys cannot carry one id', async () => {
    const w = await world();
    await refused(w, env1({ a: dataMod('b') }), /lists a mod as `a`, but its mod.json says `b`/);
    await refused(w, env1({ a: dataMod('b'), b: dataMod('b') }), /lists a mod as `a`/);
  });
  it('two mods that bring the same block are refused', async () => {
    const w = await world();
    const a = codeMod(1);
    const b = codeMod(2, { provides: { kinds: ['ebk1'], ops: ['OP_B2'], attrs: ['times'], events: ['b2ran'] }, view: view('ebk1', 162) });
    await refused(w, env1({ eb1: a, eb2: b }), /Two mods in the file bring the block `ebk1`/);
  });
  it('a mod that takes the id of a built-in pack mod needs the built-in confirm, by id; no other choice stands in for it', async () => {
    const w = await world();
    const say = codeMod(1, { id: 'say', provides: { kinds: ['ebk1'], ops: ['OP_EBK1'], attrs: ['times'], events: ['ebk1ran'] } });
    const file = env1({ say });
    const before = snap(w.t.home);
    const p = importPreview(w.env, file);
    expect(p.status, words(p)).toBe(200);
    expect(body(p).summary.mods[0]).toMatchObject({ id: 'say', replaces: 'builtin' });
    expect(body(p).summary.mods[0].warnings.join(' ')).toMatch(/ships with Reins/);
    const hash = body(p).summary.mods[0].hash as string;
    for (const choice of [{}, { trust: { say: hash } }, { replaceBuiltin: true }, { replaceBuiltin: ['phase'] }, { replaceBuiltin: 'say' }]) {
      const a = await importApply(w.env, { file, ...choice });
      expect(a.status, words(a)).toBeGreaterThanOrEqual(400);
    }
    expect(snap(w.t.home)).toEqual(before);
    expect(fs.existsSync(path.join(w.t.home, 'mod-trust.json'))).toBe(false);
  });
  it('a mod with pack or required in its manifest is refused, whatever the value', async () => {
    const w = await world();
    for (const over of [{ pack: 'default' }, { required: true }, { required: false }, { pack: null }, { pack: 'default', required: true }]) {
      await refused(w, env1({ eb1: codeMod(1, over) }), /pack|required/);
    }
  });
  it('a workflow with a hidden character is refused (zero-width, direction, NUL, BOM, line separator, lone surrogate)', async () => {
    const w = await world();
    for (const c of ['\u200b', '\u202e', '\u0000', '\ufeff', '\u2028', '\ud800', '\u0085', '\u2066']) {
      await refused(w, env1({}, { name: 'share', text: `${wf().text}a${c}b\n` }), /hidden character/);
    }
  });
  it('a workflow text may hold line breaks, tabs and carriage returns', async () => {
    const w = await world();
    const text = `${wf().text.replaceAll('\n', '\r\n')}\t> tab\r\n`;
    expect(importPreview(w.env, env1({}, { name: 'share', text })).status).toBe(200);
  });
  it('a 5 MB workflow, a workflow just over its own cap, and a 5 MB file are refused', async () => {
    const w = await world();
    await refused(w, env1({}, { name: 'share', text: 'x'.repeat(5 * 1024 * 1024) }), /larger than 1 MB/);
    await refused(w, env1({}, { name: 'share', text: 'x'.repeat(256 * 1024 + 1) }), /playbook text is larger than 256 KB/);
    await refused(w, JSON.stringify(env1({}, { name: 'share', text: 'x'.repeat(5 * 1024 * 1024) })), /larger than 1 MB/);
    expect(importPreview(w.env, env1({}, { name: 'share', text: wf().text + 'x'.repeat(256 * 1024 - 2000) })).status).toBe(200);
  });
  it('two mods that each fit are refused when the file together is over 1 MB', async () => {
    const w = await world();
    const big = (n: number) => ({ ...codeMod(n), 'notes.txt': 'n'.repeat(600 * 1024) });
    await refused(w, env1({ eb1: big(1), eb2: big(2) }), /larger than 1 MB together/);
  });
  it('a workflow that names a file path or carries a path field is refused', async () => {
    const w = await world();
    const t = wf().text;
    for (const name of ['../evil', 'a/b', 'a\\b', 'C:\\x', '/etc/passwd', 'x.reins.md', '.hidden', 'con', 'nul', '', 'x'.repeat(61), 'a b', '..', 'a:b']) {
      await refused(w, env1({}, { name, text: t }), /playbook name/);
    }
    await refused(w, env1({}, { name: 'share', text: t, path: '/etc/passwd' }), /not a field of the playbook/);
    await refused(w, env1({}, { name: 'share', text: t, file: 'x' }), /not a field of the playbook/);
    await refused(w, env1({}, 'workflows/share.reins.md'), /`workflow` must be/);
    await refused(w, env1({}, { name: 5, text: t }), /playbook name/);
    await refused(w, env1({}, { name: 'share', text: 5 }), /playbook text must be text/);
    await refused(w, env1({}, { name: 'share', text: '' }), /not empty/);
  });
  it('a nested envelope is refused as a mod, and is plain text anywhere else', async () => {
    const w = await world();
    const inner = env1({ eb1: codeMod(1) });
    await refused(w, env1({ evil: inner }), /must be text/);
    await refused(w, env1({ evil: { reinsMod: 1, files: dataMod('evil') } }), /must be text/);
    await refused(w, { reinsMods: 1, mods: { evil: { 'mod.json': inner } } }, /must be text/);
    await refused(w, { reinsMods: 1, mods: {}, workflow: inner }, /playbook/);
    // inside a file's text it is only text: the outer file installs, the inner one is not read
    const carrier = { ...dataMod('carrier'), 'notes.txt': JSON.stringify(inner) };
    const r = await importApply(w.env, { file: env1({ carrier }, { name: 'share', text: wf().text + JSON.stringify(inner).replaceAll('\n', ' ') + '\n' }) });
    expect(r.status, words(r)).toBe(200);
    expect(fs.readdirSync(path.join(w.t.home, 'mods')).sort()).toEqual(['carrier']);
    expect(w.mods.mods.some((m) => m.id === 'eb1')).toBe(false);
  });
  it('a key anywhere is refused and never repeated: a file text, mod.json, a file name, a property name, the workflow, a mod id', async () => {
    const w = await world();
    await refused(w, env1({ eb1: { ...codeMod(1), 'notes.txt': `token ${KEY}` } }), /key Reins knows/);
    await refused(w, env1({ eb1: codeMod(1, { description: `d ${KEY}` }) }), /key Reins knows/);
    await refused(w, env1({ eb1: { ...codeMod(1), [`k-${KEY}.txt`]: 'x' } }), /key Reins knows/);
    await refused(w, env1({ eb1: codeMod(1, { [`x${KEY}`]: 1 }) }), /key Reins knows/);
    await refused(w, env1({}, { name: 'share', text: `${wf().text}> ${KEY}\n` }), /key Reins knows/);
    await refused(w, env1({ [KEY]: dataMod('x') }), /key Reins knows|mod id in the file must be/);
    await refused(w, JSON.stringify(env1({ eb1: { ...codeMod(1), 'notes.txt': KEY } })), /key Reins knows/);
  });
  it('shape: extra fields, another version, an array of mods, no mods, text that is not JSON, a mod with no mod.json, too many files, odd files', async () => {
    const w = await world();
    await refused(w, { ...env1({ x: dataMod('x') }), extra: 1 }, /not a field of a mods file/);
    await refused(w, { reinsMods: 2, mods: {} }, /`reinsMods` is 2/);
    await refused(w, { reinsMods: 1, mods: [dataMod('x')] }, /`mods` must be an object/);
    await refused(w, { reinsMods: 1 }, /no mods and no playbook/);
    await refused(w, env1({}), /no mods and no playbook/);
    await refused(w, '{"reinsMods":1,', /not valid JSON/);
    await refused(w, { reinsMods: 1, mods: { x: { 'a.txt': 'x' } } }, /mod.json/);
    await refused(w, env1({ x: 'text' }), /files|object/);
    await refused(w, env1({ x: { ...dataMod('x'), ...Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}.txt`, 'x'])) } }), /the most is 50/);
    await refused(w, env1({ x: { ...dataMod('x'), 'a/b.txt': 'x' } }), /must not hold \//);
    await refused(w, env1({ x: { ...dataMod('x'), 'bin.dat': 'a\u0001b' } }), /not text/);
    await refused(w, env1({ x: { ...dataMod('x'), '..': 'x' } }), /file name/);
    await refused(w, { reinsMods: 1, mods: { x: dataMod('x') }, workflow: null }, /`workflow` must be/);
  });
  it('a refused file with a mod that has bad code metadata names the mod, and a mod missing its main file', async () => {
    const w = await world();
    const bad = codeMod(1);
    delete (bad as Record<string, string>)['index.js'];
    const { a } = await refused(w, env1({ eb1: bad }), /eb1/);
    expect(body(a).error).toMatch(/The mod `eb1` was refused, so nothing was installed/);
  });
});

describe('all or nothing', () => {
  it('mod 3 of 5 refused by its manifest: nothing of the file is installed or saved', async () => {
    const w = await world();
    const mods = { m1: dataMod('m1'), m2: dataMod('m2'), m3: dataMod('m3', { protocol: 'no-such-protocol' }), m4: dataMod('m4'), m5: dataMod('m5') };
    const { a } = await refused(w, env1(mods, wf()), /m3/);
    expect(body(a).problems.join(' ')).toMatch(/mod `m3`:/);
    expect(fs.existsSync(path.join(w.t.home, 'workflows'))).toBe(false);
  });
  it('mod 3 of 5 fails when it is placed: the two before it are taken back, with their trust lines, and the old trusted copy they replaced comes back', async () => {
    const w = await world();
    // m1 is installed already with its code trusted: the file replaces it, and the replacing is undone
    const first = env1({ eb1: codeMod(1) });
    expect((await importApply(w.env, { file: first, trust: hashes(first, w) })).status).toBe(200);
    fs.writeFileSync(path.join(w.t.home, 'mods', 'm3'), 'a plain file stands where mod 3 goes');
    const before = snap(w.t.home);
    const kinds = coreKinds();
    const file = env1({ eb1: codeMod(1, {}, '// new\\n'), eb2: codeMod(2), m3: dataMod('m3'), m4: dataMod('m4'), m5: dataMod('m5') }, wf());
    const r = await importApply(w.env, { file, trust: hashes(file, w) });
    expect(r.status, words(r)).toBeGreaterThanOrEqual(400);
    expect(body(r).error).toMatch(/Nothing from this file was installed/);
    expect(Object.keys(snap(w.t.home))).toEqual(Object.keys(before));
    expect(snap(w.t.home)).toEqual(before);
    expect(coreKinds()).toBe(kinds);
    expect(fs.readFileSync(path.join(w.t.home, 'mods', 'eb1', 'index.js'), 'utf8')).toBe(codeMod(1)['index.js']);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(w.t.home, 'mod-trust.json'), 'utf8')))).toEqual(['eb1']);
  });
  it('the workflow cannot be saved after the mods were placed: the mods are taken back', async () => {
    const w = await world();
    fs.writeFileSync(path.join(w.t.home, 'workflows'), 'a file where the folder goes');
    const before = snap(w.t.home);
    const file = env1({ eb1: codeMod(1), m2: dataMod('m2') }, wf());
    const r = await importApply(w.env, { file, trust: hashes(file, w) });
    expect(r.status, words(r)).toBe(409);
    expect(body(r).error).toMatch(/playbooks folder/);
    expect(snap(w.t.home)).toEqual(before);
    expect(NODES.has('ebk1')).toBe(false);
  });
  it('a workflow name that is taken refuses the whole file before anything is written', async () => {
    const w = await world();
    fs.mkdirSync(path.join(w.t.home, 'workflows'));
    fs.writeFileSync(path.join(w.t.home, 'workflows', 'share.reins.md'), 'mine\n');
    const before = snap(w.t.home);
    const file = env1({ m1: dataMod('m1') }, wf());
    expect(body(importPreview(w.env, file)).summary.warnings.join(' ')).toMatch(/already saved/);
    const r = await importApply(w.env, { file });
    expect(r.status).toBe(409);
    expect(body(r).error).toMatch(/Nothing was installed/);
    expect(snap(w.t.home)).toEqual(before);
    expect(fs.readFileSync(path.join(w.t.home, 'workflows', 'share.reins.md'), 'utf8')).toBe('mine\n');
  });
  it('a choice that names a mod that is not in the file refuses the file', async () => {
    const w = await world();
    const file = env1({ m1: dataMod('m1') });
    const before = snap(w.t.home);
    for (const choice of [{ trust: { other: 'h' } }, { replaceBuiltin: ['other'] }]) expect((await importApply(w.env, { file, ...choice })).status).toBe(400);
    expect(snap(w.t.home)).toEqual(before);
  });
});

describe('one trust choice per code mod', () => {
  const two = () => env1({ eb1: codeMod(1), eb2: codeMod(2), d1: dataMod('d1') }, wf('ebk1', 'ebk2'));

  it('one summary lists every mod and what it adds; each code mod has its own prompt and hash, a data mod has none', async () => {
    const w = await world();
    const p = importPreview(w.env, two());
    expect(p.status, words(p)).toBe(200);
    const s = body(p).summary;
    expect(s.envelope).toBe(true);
    expect(s.mods.map((m: any) => m.id)).toEqual(['eb1', 'eb2', 'd1']);
    expect(s.mods.filter((m: any) => m.hasCode).map((m: any) => [m.id, typeof m.hash, typeof m.codePrompt, m.trusted])).toEqual([['eb1', 'string', 'string', false], ['eb2', 'string', 'string', false]]);
    expect(s.mods[2]).not.toHaveProperty('codePrompt');
    expect(s.mods[2]).not.toHaveProperty('hash');
    expect(s.adds).toContain('eb1: adds the block `ebk1`');
    expect(s.adds).toContain('eb2: adds the block `ebk2`');
    expect(s.adds).toContain('eb2: its operations: OP_EBK2');
    expect(new Set(s.mods.map((m: any) => m.hash).filter(Boolean)).size).toBe(2);
    expect(NODES.has('ebk1')).toBe(false); // a preview runs nothing
  });
  it('only the code mod that is named with its hash is trusted; the other is installed and waits', async () => {
    const w = await world();
    const file = two();
    const h = hashes(file, w);
    const r = await importApply(w.env, { file, trust: { eb1: h.eb1 } });
    expect(r.status, words(r)).toBe(200);
    expect(body(r).trust).toEqual({ eb1: 'trusted', eb2: 'needs-trust' });
    expect(NODES.has('ebk1')).toBe(true);
    expect(NODES.has('ebk2')).toBe(false);
    expect(fs.readdirSync(w.t.home).filter((n) => n.startsWith('.mod-'))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(w.t.home, 'mod-trust.json'), 'utf8'))).toEqual({ eb1: h.eb1 });
    expect(fs.readdirSync(path.join(w.t.home, 'mods')).sort()).toEqual(['d1', 'eb1', 'eb2']);
    const rows = ((await listMods(w.env)).body as any).mods;
    expect(rows.find((m: any) => m.id === 'eb2').trust).toBe('needs-trust');
  });
  it('true, a wrong hash, a data mod and a hash of another mod trust nothing and install nothing', async () => {
    const w = await world();
    const file = two();
    const h = hashes(file, w);
    const before = snap(w.t.home);
    for (const trust of [true, 'yes', ['eb1'], { eb1: 'wrong' }, { eb1: h.eb2 }, { d1: 'x' }, { eb1: 5 }, { eb1: h.eb1, eb2: 'wrong' }]) {
      const r = await importApply(w.env, { file, trust });
      expect(r.status, JSON.stringify(trust)).toBeGreaterThanOrEqual(400);
      expect(snap(w.t.home)).toEqual(before);
    }
    const data = await importApply(w.env, { file, trust: { d1: 'x' } });
    expect(data.status).toBe(400);
    expect(body(data).error).toMatch(/has no code/);
    expect(snap(w.t.home)).toEqual(before);
    expect(NODES.has('ebk1')).toBe(false);
  });
  it('the same bytes already trusted are not asked again; changed code asks again, and the old hash trusts nothing', async () => {
    const w = await world();
    const file = two();
    const h = hashes(file, w);
    expect((await importApply(w.env, { file, trust: h })).status).toBe(200);
    const again = body(importPreview(w.env, file)).summary.mods;
    expect(again.filter((m: any) => m.hasCode).map((m: any) => m.trusted)).toEqual([true, true]);
    const changed = env1({ eb1: codeMod(1, {}, '// changed\n'), eb2: codeMod(2) });
    const s = body(importPreview(w.env, changed)).summary.mods;
    expect(s.find((m: any) => m.id === 'eb1')).toMatchObject({ trusted: false });
    expect(s.find((m: any) => m.id === 'eb1').hash).not.toBe(h.eb1);
    expect(s.find((m: any) => m.id === 'eb2')).toMatchObject({ trusted: true });
    const before = snap(w.t.home);
    expect((await importApply(w.env, { file: changed, trust: { eb1: h.eb1 } })).status).toBe(409); // the old hash does not trust the new code
    expect(snap(w.t.home)).toEqual(before);
    const r = await importApply(w.env, { file: changed });
    expect(r.status, words(r)).toBe(200);
    expect(fs.readdirSync(w.t.home).filter((n) => n.startsWith('.mod-'))).toEqual([]); // the copy it replaced is gone, not left beside it
    expect(body(r).trust.eb1).not.toBe('trusted');
    expect(body(r).trust.eb2).toBe('trusted');
  });
});

describe('the unknown block names the mod that brings it', () => {
  it('preview and the import reply say it; a block nobody brings stays plain', async () => {
    const w = await world();
    const file = env1({ eb1: codeMod(1) }, wf('ebk1', 'ghost'));
    const p = body(importPreview(w.env, file)).summary.workflow;
    expect(p.diagnostics).toContain('Unknown step kind "ebk1": the mod eb1 brings it');
    expect(p.diagnostics).toContain('Unknown step kind "ghost"');
    const untrusted = await importApply(w.env, { file });
    expect(body(untrusted).workflow.diagnostics).toContain('Unknown step kind "ebk1": the mod eb1 brings it');
    expect(fs.readFileSync(path.join(w.t.home, 'workflows', 'share.reins.md'), 'utf8')).toBe(wf('ebk1', 'ghost').text);
  });
  it('once the mod is trusted the kind is known and only the ghost is left', async () => {
    const w = await world();
    const file = env1({ eb1: codeMod(1) }, wf('ebk1', 'ghost'));
    const r = await importApply(w.env, { file, trust: hashes(file, w) });
    expect(body(r).workflow).toEqual({ name: 'share', diagnostics: ['Unknown step kind "ghost"'] });
  });
});

describe('export', () => {
  const install = async (w: World, n: number[]) => {
    const file = env1(Object.fromEntries(n.map((i) => [`eb${i}`, codeMod(i)])));
    expect((await importApply(w.env, { file, trust: hashes(file, w) })).status).toBe(200);
  };

  it('a workflow with its user mods: the mods it uses are in the file, the built-in blocks and unused mods are not, a missing block is named', async () => {
    const w = await world();
    await install(w, [1, 2]);
    const r = exportBundle(w.env, { workflow: wf('say', 'ebk1', 'ghost') });
    expect(r.status, words(r)).toBe(200);
    const o = JSON.parse(body(r).text);
    expect(Object.keys(o.mods)).toEqual(['eb1']);
    expect(o.workflow).toEqual(wf('say', 'ebk1', 'ghost'));
    expect(body(r).ids).toEqual(['eb1']);
    expect(body(r).missing).toEqual(['ghost']);
    expect(body(r).notes.join(' ')).toMatch(/block "ghost".*brought by no mod installed here/);
    expect(body(r).text.endsWith('\n')).toBe(true);
    expect(exportBundle(w.env, { workflow: wf('say', 'ebk1', 'ghost') })).toEqual(r);
  });
  it('nested steps count; a built-in pack mod is never exported even when asked for', async () => {
    const w = await world();
    await install(w, [1]);
    const nested = { name: 'share', text: `${head}## repeat\nuntil: you approve\nmax: 3\n\n### ebk1\ntimes: 1\n\n### phase work\n> go\n\n## phase one\n> go\n` };
    const r = exportBundle(w.env, { workflow: nested });
    expect(r.status, words(r)).toBe(200);
    expect(body(r).ids).toEqual(['eb1']); // the block is only inside the repeat
    for (const bundled of ['say', 'phase', 'end']) {
      const x = exportBundle(w.env, { ids: [bundled] });
      expect(x.status).toBe(409);
      expect(body(x).error).toMatch(/ships with Reins/);
    }
  });
  it('mods without a workflow, and a workflow without mods, export', async () => {
    const w = await world();
    await install(w, [1, 2]);
    expect(JSON.parse(body(exportBundle(w.env, { ids: ['eb2', 'eb1'] })).text)).toMatchObject({ reinsMods: 1 });
    expect(Object.keys(JSON.parse(body(exportBundle(w.env, { ids: ['eb2', 'eb1'] })).text).mods)).toEqual(['eb1', 'eb2']);
    const only = JSON.parse(body(exportBundle(w.env, { workflow: wf('say') })).text);
    expect(only.mods).toEqual({});
  });
  it('bad requests: nothing to export, unknown fields, an id that is not installed, a key in a mod file, a hidden character', async () => {
    const w = await world();
    await install(w, [1]);
    for (const b of [{}, { ids: [] }, { extra: 1, ids: ['eb1'] }, { ids: 'eb1' }, { ids: ['../x'] }, { ids: Array(21).fill('eb1') }, { workflow: { name: '../x', text: 'a' } }, { ids: [5] }, { workflow: { name: 'share', text: `${wf().text}> ${KEY}\n` } }]) {
      expect(words(exportBundle(w.env, b as Record<string, unknown>))).not.toContain(KEY);
      expect(exportBundle(w.env, b as Record<string, unknown>).status, JSON.stringify(b)).toBe(400);
    }
    expect(exportBundle(w.env, { ids: ['nope'] }).status).toBe(404);
    fs.writeFileSync(path.join(w.t.home, 'mods', 'eb1', 'notes.txt'), `x ${KEY}`);
    const k = exportBundle(w.env, { ids: ['eb1'] });
    expect(k.status).toBe(409);
    expect(words(k)).not.toContain(KEY);
    expect(exportBundle(w.env, { workflow: { name: 'share', text: `a\u200bb` } }).status).toBe(400);
  });
  it('a user mod that would not import is not exported (the file is read back before it is handed out)', async () => {
    const w = await world();
    w.t.writeMod('bad', { reins: 1, id: 'bad', kind: 'provider', version: '1.0.0', label: 'Bad', protocol: 'no-such-protocol', baseUrl: 'https://example.invalid/v1', auth: { style: 'none', keyEnv: [] } });
    await w.mods.reload?.();
    const r = exportBundle(w.env, { ids: ['bad'] });
    expect(r.status, words(r)).toBe(409);
    expect(body(r).error).toMatch(/would not import/);
  });
  it('text that grows when written as JSON can push a file over 1 MB; it is not exported', async () => {
    const w = await world();
    await install(w, [1]);
    fs.writeFileSync(path.join(w.t.home, 'mods', 'eb1', 'lines.txt'), '\n'.repeat(700 * 1024));
    const r = exportBundle(w.env, { ids: ['eb1'] });
    expect(r.status, words(r)).toBe(409);
    expect(body(r).error).toMatch(/The file would be larger than 1 MB/);
  });
  it('a file that would be over 1 MB is not exported', async () => {
    const w = await world();
    await install(w, [1]);
    fs.writeFileSync(path.join(w.t.home, 'mods', 'eb1', 'big.txt'), 'x'.repeat(900 * 1024));
    const r = exportBundle(w.env, { ids: ['eb1'], workflow: { name: 'share', text: 'w'.repeat(200 * 1024) } });
    expect(r.status).toBe(409);
    expect(body(r).error).toMatch(/larger than 1 MB/);
  });
});

describe('round trip', () => {
  it('exported from one home and imported into a second: same bytes for every mod and the workflow, and the same export again', async () => {
    const a = await world();
    const seed = env1({ eb1: { ...codeMod(1), 'notes.txt': 'line one\r\nline two \u00e9\n' }, eb2: codeMod(2), d1: dataMod('d1') });
    expect((await importApply(a.env, { file: seed, trust: hashes(seed, a) })).status).toBe(200);
    const text = { name: 'share', text: `${wf('ebk1', 'ebk2').text.replaceAll('\n', '\r\n')}> caf\u00e9 \ud83d\ude00\r\n` };
    const out = exportBundle(a.env, { ids: ['d1'], workflow: text });
    expect(out.status, words(out)).toBe(200);
    const t1 = body(out).text as string;
    const bytes = (w: World) => Object.fromEntries(['d1', 'eb1', 'eb2'].map((id) => [id, Object.fromEntries(fs.readdirSync(path.join(w.t.home, 'mods', id)).sort().map((f) => [f, fs.readFileSync(path.join(w.t.home, 'mods', id, f)).toString('hex')]))]));
    const bytesA = bytes(a);
    close(a);

    const b = await world();
    const p = importPreview(b.env, t1);
    expect(p.status, words(p)).toBe(200);
    expect(body(p).summary.mods.map((m: any) => m.id)).toEqual(['d1', 'eb1', 'eb2']);
    const r = await importApply(b.env, { file: t1, trust: hashes(t1, b) });
    expect(r.status, words(r)).toBe(200);
    expect(bytes(b)).toEqual(bytesA);
    expect(fs.readFileSync(path.join(b.t.home, 'workflows', 'share.reins.md'), 'utf8')).toBe(text.text);
    expect(fs.readFileSync(path.join(b.t.home, 'workflows', 'share.reins.md')).equals(Buffer.from(text.text, 'utf8'))).toBe(true);
    const again = exportBundle(b.env, { ids: ['d1'], workflow: text });
    expect(body(again).text).toBe(t1);
  });
  it('a Customize copy travels: the user copy of a built-in mod is in the file, and a second home takes it only on the built-in confirm', async () => {
    const a = await world();
    // the copy of `say`: what Customize makes (the built-in's files without pack and required), installed over the built-in with the confirm
    const src = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'src', 'mods', 'say');
    const manifest = JSON.parse(fs.readFileSync(path.join(src, 'mod.json'), 'utf8'));
    delete manifest.pack;
    const copy = { 'mod.json': j(manifest), 'index.js': 'export default function activate() {}\n' };
    const file = env1({ say: copy });
    const first = await importApply(a.env, { file, replaceBuiltin: ['say'] });
    expect(first.status, words(first)).toBe(200);
    const out = exportBundle(a.env, { workflow: wf('say', 'phase') });
    expect(out.status, words(out)).toBe(200);
    expect(body(out).ids).toEqual(['say']); // the copy, not `phase`, which ships with Reins
    const t1 = body(out).text as string;
    close(a);
    const b = await world();
    await expect(importApply(b.env, { file: t1 })).resolves.toMatchObject({ status: 409 });
    const r = await importApply(b.env, { file: t1, replaceBuiltin: ['say'] });
    expect(r.status, words(r)).toBe(200);
    expect(fs.readFileSync(path.join(b.t.home, 'mods', 'say', 'index.js'), 'utf8')).toBe(copy['index.js']);
  });
});

describe('the single mod file and the routes', () => {
  it('a reinsMod file still previews and imports, with trust: true', async () => {
    const w = await world();
    const file = { reinsMod: 1, files: codeMod(1) };
    const p = importPreview(w.env, file);
    expect(p.status, words(p)).toBe(200);
    expect(body(p).summary).toMatchObject({ id: 'eb1', hasCode: true });
    expect(body(p).summary).not.toHaveProperty('envelope');
    const r = await importApply(w.env, { file: JSON.stringify(file), trust: true });
    expect(r.status, words(r)).toBe(200);
    expect(body(r)).toMatchObject({ id: 'eb1', trust: 'trusted' });
    await expect(importApply(w.env, { file: { reinsMod: 1, files: dataMod('d9') }, trust: 'yes' })).resolves.toMatchObject({ status: 400 });
  });
  it('a single file whose text only mentions reinsMods is a single file', async () => {
    const w = await world();
    const file = { reinsMod: 1, files: { ...dataMod('d9'), 'notes.txt': '"reinsMods"' } };
    expect(body(importPreview(w.env, JSON.stringify(file))).summary).toMatchObject({ id: 'd9' });
  });
  it('over HTTP: preview, import and bundle', async () => {
    const t = tempHome();
    const mods = await startMods({ dir: t.home, env: {} });
    const store = openStore(':memory:');
    const srv = await startServer({ store, dir: t.home, mods, env: {}, catalogDir: path.join(t.home, 'no-catalog'), probe: async () => PROBE, makeEngine: makeEngineFrom(mods, { env: {}, home: t.home }, () => false) });
    const call = (method: string, url: string, b?: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
      const payload = b === undefined ? undefined : JSON.stringify(b);
      const req = http.request({ host: '127.0.0.1', port: srv.port, path: url, method, agent: false, headers: { authorization: `Bearer ${srv.token}`, ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) } }, (res) => {
        let s = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (s += d));
        res.on('end', () => { let json: unknown; try { json = JSON.parse(s); } catch { json = undefined; } resolve({ status: res.statusCode ?? 0, json }); });
      });
      req.on('error', reject);
      req.end(payload);
    });
    try {
      const file = env1({ eb1: codeMod(1), d1: dataMod('d1') }, wf('ebk1'));
      const p = await call('POST', '/api/mods/import/preview', { file });
      expect(p.status).toBe(200);
      expect(p.json.summary.mods).toHaveLength(2);
      const hash = p.json.summary.mods.find((m: any) => m.id === 'eb1').hash;
      const r = await call('POST', '/api/mods/import', { file, trust: { eb1: hash } });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json.trust).toEqual({ eb1: 'trusted' });
      const out = await call('POST', '/api/mods/bundle', { workflow: wf('ebk1', 'say') });
      expect(out.status, JSON.stringify(out.json)).toBe(200);
      expect(Object.keys(JSON.parse(out.json.text).mods)).toEqual(['eb1']);
      expect((await call('POST', '/api/mods/bundle', {})).status).toBe(400);
      expect((await call('POST', '/api/mods/import', { file: env1({}, { name: '../x', text: 'a' }) })).status).toBe(400);
    } finally {
      await srv.close();
      store.close();
      mods.dispose();
      t.cleanup();
    }
  });
});
