// M2 Task 20: a block, condition or card mod uses the provider machinery end to end: the preview lists what it adds from the manifest BEFORE any code
// runs, the code prompt and trust work as for a provider, a changed manifest or code asks again, export and import into a second home give the same
// bytes, and a carried mod that is disabled or removed keeps its place in core and says it applies after a restart. The model of this file is
// toy-provider.test.ts. Every mod is a fixture or is built at run time; the homes are temp folders.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CARDS, CONDS, NODES, Run, compileProgram, opOf, parseWorkflow, printWorkflow, receipt, validate } from '@reins/core';
import { harness } from '../../core/test/m1-harness.js';
import { makeEngineFrom, redactEnvNames, startMods } from '../src/engines.js';
import { CODE_PROMPT } from '../src/mods/actions.js';
import type { Mods } from '../src/mods/types.js';
import { Redactor } from '../src/secrets.js';
import { startServer, type Server } from '../src/server.js';
import { openStore, redactingStore, type Store } from '../src/store.js';
import { PROBE } from './http-helpers.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mods/toy-beep/', import.meta.url));
const rm = (d: string) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the OS */ } };
const marker = path.join(fs.realpathSync(os.tmpdir()), `reins-toy-beep-import-marker-${process.pid}.log`);
const marked = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean) : []);

interface Res { status: number; json: any; text: string }
interface World {
  root: string; dir: string; mods: Mods; store: Store; srv: Server;
  call: (method: string, url: string, body?: unknown) => Promise<Res>;
}
const worlds: World[] = [];

beforeAll(() => {
  rm(marker);
  process.env.TOY_MARKER = marker; // the toy block writes a line here when its code is loaded
});
afterAll(async () => {
  delete process.env.TOY_MARKER;
  rm(marker);
  for (const w of worlds.splice(0)) await close(w);
});

async function close(w: World) {
  await w.srv.close();
  w.store.close();
  w.mods.dispose();
  rm(w.root);
}

/** A real server over HTTP on a temp Reins folder with the real loader. `root` names a folder that is already there: that is a restart. */
async function boot(root?: string): Promise<World> {
  root ??= fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-beep-')));
  const dir = path.join(root, '.reins');
  fs.mkdirSync(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  const mods = await startMods({ dir, env });
  const redactor = new Redactor({ home: dir, env, keyEnvNames: () => redactEnvNames(mods) });
  const store = redactingStore(openStore(':memory:'), redactor);
  const srv = await startServer({
    store, dir, mods, env, redactor, catalogDir: path.join(root, 'no-catalog'), probe: async () => PROBE,
    makeEngine: makeEngineFrom(mods, { env, home: dir }, (id, origin) => store.hasConsent(id, origin)),
  });
  const call: World['call'] = (method, url, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: srv.port, path: url, method, agent: false,
      headers: { authorization: `Bearer ${srv.token}`, ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (text += d));
      res.on('end', () => {
        let json: unknown;
        try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
  const w: World = { root, dir, mods, store, srv, call };
  worlds.push(w);
  return w;
}
/** Stops the server and the mods of a world (core is emptied of what they registered) and starts a new one on the same folder. */
async function restart(w: World): Promise<World> {
  worlds.splice(worlds.indexOf(w), 1);
  await w.srv.close();
  w.store.close();
  w.mods.dispose();
  return boot(w.root);
}

const beepFiles = (): Record<string, string> => Object.fromEntries(fs.readdirSync(FIXTURE).map((n) => [n, fs.readFileSync(path.join(FIXTURE, n), 'utf8')]));
const asFile = (files: Record<string, string>) => ({ reinsMod: 1, files });
/** The toy-beep files with the manifest changed by `edit` (written as JSON text) and the code changed by `code`. */
function beep(edit?: (m: Record<string, any>) => void, code?: (s: string) => string) {
  const files = beepFiles();
  if (edit) {
    const m = JSON.parse(files['mod.json']!);
    edit(m);
    files['mod.json'] = JSON.stringify(m, null, 2);
  }
  if (code) files['index.js'] = code(files['index.js']!);
  return asFile(files);
}
const preview = (w: World, file: unknown) => w.call('POST', '/api/mods/import/preview', { file });
const importMod = (w: World, file: unknown, trust?: boolean) => w.call('POST', '/api/mods/import', { file, ...(trust ? { trust } : {}) });
const list = async (w: World) => (await w.call('GET', '/api/mods')).json.mods as Array<Record<string, any>>;
const modOf = async (w: World, id: string) => (await list(w)).find((m) => m.id === id);
const folderFiles = (w: World, id: string) => Object.fromEntries(fs.readdirSync(path.join(w.dir, 'mods', id)).sort().map((n) => [n, fs.readFileSync(path.join(w.dir, 'mods', id, n))]));
/** What is in the folder the trusted code runs from (the toy-say step below puts a copy there). */
const cache = (w: World) => (fs.existsSync(path.join(w.dir, 'mod-cache')) ? fs.readdirSync(path.join(w.dir, 'mod-cache')).sort() : []);
const coreNow = () => JSON.stringify({ n: [...NODES.keys()], c: [...CONDS.keys()], k: [...CARDS.keys()], op: opOf('BEEP') !== undefined });

const ADDS = [
  'adds the block `beep`',
  'its operations: BEEP',
  'may log the events: beeped',
  'may use the attributes: times',
  'shown in the block list as "beep" under "Flow"',
];
const NOTICE = '`toy-beep`: applies after a restart.';
const head = '---\nreins: 1\nname: toy\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n';
const text = head + '## beep\ntimes: 2\n\n## phase one\n> go\n';

describe('toy-beep: a block mod through preview, trust, restart, run, export, import, disable and remove', () => {
  let a: World;
  let exported: Res;
  let hash: string;

  beforeAll(async () => {
    a = await boot();
  });

  it('the preview lists what the block adds, its code prompt and its hash BEFORE any code runs; nothing is written or registered', async () => {
    const before = coreNow();
    const p = await preview(a, beep());
    expect(p.status, p.text).toBe(200);
    expect(p.json.summary).toMatchObject({ id: 'toy-beep', kind: 'block', protocol: null, hasCode: true, trusted: false, codePrompt: CODE_PROMPT, adds: ADDS, warnings: [] });
    expect(typeof p.json.summary.hash).toBe('string');
    hash = p.json.summary.hash;
    expect(NODES.has('beep')).toBe(false);
    expect(opOf('BEEP')).toBeUndefined();
    expect(coreNow()).toBe(before);
    expect(marked()).toEqual([]); // the code was not imported
    expect(fs.existsSync(path.join(a.dir, 'mod-cache'))).toBe(false);
    expect(fs.existsSync(path.join(a.dir, 'mods', 'toy-beep'))).toBe(false); // a preview writes nothing
    expect(fs.existsSync(path.join(a.dir, 'mod-trust.json'))).toBe(false);
  });

  it('a condition and a card say what they add in the same way', async () => {
    const man = (kind: string, provides: unknown) => ({ reins: 1, id: `toy-${kind}`, kind, version: '1.0.0', label: `Toy ${kind}`, main: 'index.js', order: 150, provides });
    const code = 'export default function activate() {}\n';
    const c = await preview(a, asFile({ 'mod.json': JSON.stringify(man('condition', { conditions: ['ping'] })), 'index.js': code }));
    expect(c.json.summary).toMatchObject({ kind: 'condition', hasCode: true, codePrompt: CODE_PROMPT, adds: ['adds the condition `ping`'] });
    const k = await preview(a, asFile({ 'mod.json': JSON.stringify(man('card', { cards: ['zap'] })), 'index.js': code }));
    expect(k.json.summary).toMatchObject({ kind: 'card', hasCode: true, codePrompt: CODE_PROMPT, adds: ['adds the card `zap`'] });
    expect(CONDS.has('ping') || CARDS.has('zap')).toBe(false);
  });

  it('a kind core already has is shown as a warning in the preview; importing it with trust leaves core as it was', async () => {
    const say = beep((m) => { m.id = 'toy-say'; m.provides.kinds = ['say']; m.view.kind = 'say'; }, () => "export default function activate(api) { api.registerBlock({ kind: 'say', attrs: [], compile() {}, ops: {} }); }\n");
    const p = await preview(a, say);
    expect(p.json.summary.warnings).toEqual(['the block `say` already exists in Reins, so the code of this mod would be refused.']);
    const before = coreNow();
    const r = await importMod(a, say, true);
    expect(r.status, r.text).toBe(200);
    expect((await modOf(a, 'toy-say'))!.problems.join(' ')).toContain('already registered');
    expect(coreNow()).toBe(before);
    expect((await a.call('DELETE', '/api/mods/toy-say')).status).toBe(200);
    expect(coreNow()).toBe(before);
  });

  // Task 25a (MINOR 2): a condition or card name core has is refused at the manifest, not a warning. (This pin said "a warning".)
  it('a condition or a card core already has is refused with words', async () => {
    const man = (kind: string, provides: unknown) => ({ reins: 1, id: `toy-${kind}`, kind, version: '1.0.0', label: `Toy ${kind}`, main: 'index.js', order: 150, provides });
    const code = 'export default function activate() {}\n';
    const atom = [...CONDS.keys()][0]!;
    const card = [...CARDS.keys()][0]!;
    const c = await preview(a, asFile({ 'mod.json': JSON.stringify(man('condition', { conditions: [atom, 'ping'] })), 'index.js': code }));
    expect([c.status, c.json.problems.join(' ')]).toEqual([400, expect.stringContaining(`lists \`${atom}\`, which Reins already has`)]);
    const k = await preview(a, asFile({ 'mod.json': JSON.stringify(man('card', { cards: [card] })), 'index.js': code }));
    expect([k.status, k.json.problems.join(' ')]).toEqual([400, expect.stringContaining(`lists \`${card}\`, which Reins already has`)]);
  });

  it('import without trust: listed as a block that needs trust, its view is served from the manifest, nothing runs or registers, also through reloads', async () => {
    const before = coreNow();
    const cached = cache(a);
    const r = await importMod(a, beep());
    expect([r.status, r.json.trust]).toEqual([200, 'needs-trust']);
    expect(marked()).toEqual([]);
    expect(coreNow()).toBe(before);
    expect(cache(a)).toEqual(cached); // no code was copied to where it runs from
    expect(a.mods.registry.get('block-view', 'beep')).toEqual(JSON.parse(beepFiles()['mod.json']!).view);
    const row = await modOf(a, 'toy-beep');
    expect(row).toMatchObject({ kind: 'block', id: 'toy-beep', label: 'Toy beep', trust: 'needs-trust', enabled: true, hash, codePrompt: CODE_PROMPT, adds: ADDS });
    expect(row!.problems.join(' ')).toContain('needs trust');
    expect(row!.notices).toBeUndefined();
    // another reload (disable, enable) does not run it either
    expect((await a.call('POST', '/api/mods/toy-beep/disable')).status).toBe(200);
    expect((await a.call('POST', '/api/mods/toy-beep/enable')).status).toBe(200);
    expect(coreNow()).toBe(before);
    expect(marked()).toEqual([]);
  });

  it('a Trust with a wrong hash does nothing; the hash the list showed registers the block at once and the run works', async () => {
    const before = coreNow();
    const bad = await a.call('POST', '/api/mods/toy-beep/trust', { hash: 'f'.repeat(64) });
    expect(bad.status).toBe(409);
    expect(coreNow()).toBe(before);
    const ok = await a.call('POST', '/api/mods/toy-beep/trust', { hash });
    expect([ok.status, ok.json.trust]).toEqual([200, 'trusted']);
    expect(marked()).toEqual(['toy-beep loaded']);
    expect(NODES.has('beep')).toBe(true);
    expect(await modOf(a, 'toy-beep')).toMatchObject({ kind: 'block', trust: 'trusted', problems: [], adds: ADDS });

    const p = parseWorkflow(text);
    expect(p.diagnostics).toEqual([]);
    expect(printWorkflow(p.workflow!)).toBe(text);
    expect(validate(p.workflow!).filter((d) => d.severity === 'error')).toEqual([]);
    expect(compileProgram(p.workflow!)[0]).toMatchObject({ op: 'BEEP', times: 2 });
    const hr = harness('beep', [{ text: 'ok\nREINS: done' }]);
    const run = new Run({ workflow: p.workflow!, engine: hr.engine, now: hr.now });
    for (let k = 0; k < 20 && run.status === 'running'; k++) await run.step();
    expect(run.status).toBe('done');
    expect(receipt(run.getEvents()).counts).toEqual({ beeps: 1 });
  });

  it('restart: the folder, the trust line and the kind come back; the block is registered at start', async () => {
    const node = NODES.get('beep');
    expect(node).toBeDefined();
    a = await restart(a);
    expect(NODES.has('beep')).toBe(true);
    expect(NODES.get('beep')).not.toBe(node); // the old one was taken out with the old mods, the new start registered its own
    expect(await modOf(a, 'toy-beep')).toMatchObject({ kind: 'block', trust: 'trusted', problems: [], enabled: true });
    expect((await modOf(a, 'toy-beep'))!.notices).toBeUndefined();
  });

  it('a changed provides, or changed code, after trust asks for trust again (the preview, the list); core keeps the old block until a restart', async () => {
    const more = beep((m) => { m.provides.attrs.push('extra'); });
    const p = await preview(a, more);
    expect(p.json.summary).toMatchObject({ trusted: false, codePrompt: CODE_PROMPT });
    expect(p.json.summary.hash).not.toBe(hash);
    expect(p.json.summary.adds).toContain('may use the attributes: times, extra');
    expect(p.json.summary.warnings).toEqual([]); // its own earlier copy holds `beep` in core: that is not a clash
    const code = await preview(a, beep(undefined, (s) => `${s}// one more line\n`));
    expect(code.json.summary).toMatchObject({ trusted: false });
    expect(code.json.summary.hash).not.toBe(hash);
    expect((await preview(a, beep())).json.summary).toMatchObject({ trusted: true, hash }); // the same bytes are still trusted

    const node = NODES.get('beep');
    const before = coreNow();
    const r = await importMod(a, more);
    expect([r.status, r.json.trust]).toEqual([200, 'needs-trust']);
    expect(NODES.get('beep')).toBe(node);
    expect(coreNow()).toBe(before);
    const row = await modOf(a, 'toy-beep');
    expect(row).toMatchObject({ trust: 'needs-trust', hash: p.json.summary.hash });
    expect(row!.notices).toEqual([NOTICE]);
    expect(row!.problems.join(' ')).not.toContain('applies after a restart'); // not shown as an error
    // the old bytes again: trusted as before, and nothing to say
    const back = await importMod(a, beep());
    expect(back.json.trust).toBe('trusted');
    expect((await modOf(a, 'toy-beep'))!.notices).toBeUndefined();
    expect(NODES.get('beep')).toBe(node);
  });

  it('export, then import into a second clean home: the same bytes, not trusted there, nothing registered there', async () => {
    exported = await a.call('GET', '/api/mods/toy-beep/export');
    expect(exported.status, exported.text).toBe(200);
    expect(Object.keys(exported.json)).toEqual(['reinsMod', 'files']);
    expect(Object.keys(exported.json.files)).toEqual(['index.js', 'mod.json']);
    expect(exported.json.files).toEqual(beepFiles());
    const b = await boot();
    const before = coreNow();
    const first = await importMod(b, exported.json);
    expect([first.status, first.json.trust]).toEqual([200, 'needs-trust']);
    const here = folderFiles(a, 'toy-beep');
    const there = folderFiles(b, 'toy-beep');
    expect(Object.keys(there)).toEqual(Object.keys(here));
    for (const name of Object.keys(here)) expect(there[name]!.equals(here[name]!)).toBe(true);
    expect((await b.call('GET', '/api/mods/toy-beep/export')).json).toEqual(exported.json);
    expect(await modOf(b, 'toy-beep')).toMatchObject({ trust: 'needs-trust', adds: ADDS });
    expect((await preview(b, exported.json)).json.summary).toMatchObject({ trusted: false, hash });
    expect(coreNow()).toBe(before);
  });

  it('disable and enable of a carried mod keep it registered and say it applies after a restart; nothing in core changes', async () => {
    const node = NODES.get('beep');
    const before = coreNow();
    expect((await a.call('POST', '/api/mods/toy-beep/disable')).status).toBe(200);
    const off = await modOf(a, 'toy-beep');
    expect(off).toMatchObject({ enabled: false, kind: 'block' });
    expect(off!.notices).toEqual([NOTICE]);
    expect(off!.problems).toEqual([]);
    expect(NODES.get('beep')).toBe(node);
    expect(coreNow()).toBe(before);
    expect((await a.call('POST', '/api/mods/toy-beep/enable')).status).toBe(200);
    expect(await modOf(a, 'toy-beep')).toMatchObject({ enabled: true, trust: 'trusted', problems: [] });
    expect((await modOf(a, 'toy-beep'))!.notices).toBeUndefined();
    expect(NODES.get('beep')).toBe(node);
  });

  it('remove takes the folder and the trust line, keeps the block in core until a restart, and still lists it with the notice', async () => {
    const node = NODES.get('beep');
    const before = coreNow();
    expect((await a.call('DELETE', '/api/mods/toy-beep')).status).toBe(200);
    expect(fs.existsSync(path.join(a.dir, 'mods', 'toy-beep'))).toBe(false);
    expect(fs.readFileSync(path.join(a.dir, 'mod-trust.json'), 'utf8')).not.toContain('toy-beep');
    expect(NODES.get('beep')).toBe(node);
    expect(coreNow()).toBe(before);
    const row = await modOf(a, 'toy-beep');
    expect(row).toMatchObject({ kind: 'block', id: 'toy-beep' });
    expect(row!.notices).toEqual([NOTICE]);
    expect(a.mods.registry.get('block-view', 'beep')).toBeDefined();
    // a restart forgets it
    a = await restart(a);
    expect(NODES.has('beep')).toBe(false);
    expect(await modOf(a, 'toy-beep')).toBeUndefined();
  });

  it('Trust and import of a condition registers it at once; a card likewise; dispose takes both out', async () => {
    const c = asFile({
      'mod.json': JSON.stringify({ reins: 1, id: 'toy-ping', kind: 'condition', version: '1.0.0', label: 'Toy ping', main: 'index.js', order: 25, provides: { conditions: ['ping'] } }),
      'index.js': "export default function activate(api) { api.registerCondition({ t: 'ping', parse(s) { if (!s.src.startsWith('ping', s.idx)) return null; s.idx += 4; return { t: 'ping' }; }, print: () => 'ping', judge: 'agent', evalSync: () => true }); }\n",
    });
    expect((await importMod(a, c)).json.trust).toBe('needs-trust');
    expect(CONDS.has('ping')).toBe(false);
    expect(await modOf(a, 'toy-ping')).toMatchObject({ kind: 'condition', trust: 'needs-trust', adds: ['adds the condition `ping`'] });
    expect((await importMod(a, c, true)).json.trust).toBe('trusted');
    expect(CONDS.has('ping')).toBe(true);
    expect(await modOf(a, 'toy-ping')).toMatchObject({ kind: 'condition', trust: 'trusted', problems: [] });
    a.mods.dispose();
    expect(CONDS.has('ping')).toBe(false);
  });
});

describe('a hostile mod file is refused in words and writes nothing', () => {
  let w: World;
  beforeAll(async () => {
    rm(marker);
    w = await boot();
  });

  const hidden = String.fromCharCode(0x202e);
  const zero = String.fromCharCode(0x200b);
  const cases: Array<[string, ReturnType<typeof beep>, RegExp]> = [
    ['hidden characters in the label', beep((m) => { m.label = `Toy${hidden}peeb`; }), /label must not hold a control/],
    ['a zero-width character in a shown view text', beep((m) => { m.view.fields[0].label = `Ti${zero}mes`; }), /a text in `view` holds a control/],
    ['a hidden character in a view key', beep((m) => { m.view.fresh = { [`a${hidden}b`]: 1 }; }), /a text in `view` holds a control/],
    ['a view of 100 kB', beep((m) => { m.view.fields[0].label = 'x'.repeat(100_000); }), /`view` is larger than 32 KB/],
    ['a view that is not an object', beep((m) => { m.view = 'beep'; }), /`view` must be an object/],
    ['a view of another kind', beep((m) => { m.view.kind = 'other'; }), /`view.kind` must be one of `provides.kinds`/],
    ['a provides name with a path', beep((m) => { m.provides.kinds = ['../beep']; }), /`provides.kinds` must be a list of at most 50 names/],
    ['a provides op with a slash and a dot', beep((m) => { m.provides.ops = ['a/b', 'c.d']; }), /`provides.ops` must be a list/],
    ['a provides key a block cannot add', beep((m) => { m.provides.conditions = ['x']; }), /`provides.conditions` is not something a block mod can add/],
    ['a name twice', beep((m) => { m.provides.kinds = ['beep', 'beep']; }), /lists a name twice/],
    ['no kinds', beep((m) => { m.provides.kinds = []; m.view.kind = 'beep'; }), /`provides.kinds` lists nothing/],
    ['no order', beep((m) => { delete m.order; }), /`order` must be a number/],
    ['no code', beep((m) => { delete m.main; }), /needs code/],
    ['a main that is not in the file', beep((m) => { m.main = 'other.js'; }), /which is not one of the files in this mod file/],
    ['an id with ..', beep((m) => { m.id = '../evil'; }), /The id must be lowercase letters/],
    ['an id that is only ..', beep((m) => { m.id = '..'; }), /The id must be lowercase letters/],
    ['an id with a slash', beep((m) => { m.id = 'a/../b'; }), /The id must be lowercase letters/],
    ['a file name with a path', asFile({ ...beepFiles(), '../index.js': 'x' }), /must not hold/],
  ];
  const state = () => {
    const mods = path.join(w.dir, 'mods');
    return JSON.stringify({ mods: fs.existsSync(mods) ? fs.readdirSync(mods) : [], home: fs.readdirSync(w.dir).filter((n) => n !== 'mods' && !n.startsWith('first-run')).sort(), core: coreNow(), outside: fs.readdirSync(w.root).sort() });
  };

  it.each(cases)('%s: preview and import (even with trust) refuse it with words, and nothing is written', async (_name, file, words) => {
    const before = state();
    const p = await preview(w, file);
    expect(p.status, p.text).toBe(400);
    expect(p.json.problems.join(' ')).toMatch(words);
    const r = await importMod(w, file, true);
    expect(r.status, r.text).toBe(400);
    expect(r.json.problems.join(' ')).toMatch(words);
    expect(state()).toBe(before);
    expect(fs.existsSync(path.join(w.dir, 'mod-trust.json'))).toBe(false);
    expect((await list(w)).filter((m) => m.kind === 'block')).toEqual([]);
    expect(marked()).toEqual([]);
  });

  it('a bad mod found in the mods folder is listed with its problems, and the list adds only plain names and clean texts', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-beep-')));
    const evil = path.join(root, '.reins', 'mods', 'evil');
    fs.mkdirSync(evil, { recursive: true });
    const m = JSON.parse(beepFiles()['mod.json']!);
    m.id = 'evil';
    m.provides = { kinds: ['good', '<img src=x>', '../up', 'x'.repeat(41), 7], ops: ['OP', 'a b'], events: 'beeped', attrs: Array.from({ length: 80 }, (_, i) => `a${i}`) };
    m.view.card = { label: `Ev${hidden}il`, section: 'Flow' };
    fs.writeFileSync(path.join(evil, 'mod.json'), JSON.stringify(m));
    fs.writeFileSync(path.join(evil, 'index.js'), 'export default function activate() {}\n');
    const other = path.join(root, '.reins', 'mods', 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'mod.json'), JSON.stringify({ reins: 1, id: 'other', kind: 'protocol', provides: { ops: ['OP'] }, view: { card: { label: 'Other' } } }));
    const b = await boot(root);
    expect((await modOf(b, 'other'))!.adds).toBeUndefined(); // only a mod that brings a block, condition or card says what it adds
    const row = await modOf(b, 'evil');
    expect(row!.problems.length).toBeGreaterThan(0);
    expect(row!.adds).toEqual(['adds the block `good`', 'its operations: OP', `may use the attributes: ${Array.from({ length: 50 }, (_, i) => `a${i}`).join(', ')}`]);
    expect(NODES.has('good')).toBe(false);
  });

  it('what a refusal shows is cut and shown as it is: no raw hidden character in any problem line', async () => {
    for (const [, file] of cases) {
      const r = await preview(w, file);
      expect(JSON.stringify(r.json)).not.toMatch(new RegExp(`[${hidden}${zero}]`));
      expect(r.text.length).toBeLessThan(5000);
    }
  });
});
