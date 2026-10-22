// M2 Task 16b (at the end of this file): what a block, condition or card mod puts in core is carried over a reload and taken out only by dispose.
// M2 Task 16a: a block, a condition and a card are mods. A toy block (`toy-beep`, test/fixtures/mods) goes through the real loader and runs end to end with
// no edit under packages/*/src; the api of a mod is limited to its `provides`. Every mod here is made at run time in a temp home through `tempHome`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CARDS, CONDS, NODES, Run, checkMode, compileProgram, opOf, parseWorkflow, policyOf, printWorkflow, receipt, turnInstr, validate } from '@reins/core';
import { harness } from '../../core/test/m1-harness.js';
import { kindOf, kindsInOrder } from '../src/mods/kinds.js';
import { startMods } from '../src/engines.js';
import { dropCarried, hashFiles, loadMods, readFolder } from '../src/mods/loader.js';
import type { Carried, LoadedMod, Mods } from '../src/mods/types.js';
import { startRunCli } from '../src/run-cli.js';
import { openStore } from '../src/store.js';
import { claudeEngine } from '../src/mods/claude-code-cli/engine.js';
import { FAKE_CLAUDE, fakeSetup } from './helpers.js';
import { tempHome } from './mods-harness.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mods/toy-beep/', import.meta.url));
const beepManifest = () => JSON.parse(fs.readFileSync(path.join(FIXTURE, 'mod.json'), 'utf8')) as Record<string, any>;
const beepCode = () => fs.readFileSync(path.join(FIXTURE, 'index.js'), 'utf8');
const g = globalThis as unknown as Record<string, any>;
const marker = path.join(fs.realpathSync(os.tmpdir()), `reins-toy-beep-marker-${process.pid}.log`);
const marked = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean) : []);

let h: ReturnType<typeof tempHome>;
const loaded: Mods[] = [];
beforeAll(() => { process.env.TOY_MARKER = marker; });
afterAll(() => { delete process.env.TOY_MARKER; fs.rmSync(marker, { force: true }); });
beforeEach(() => { h = tempHome(); fs.rmSync(marker, { force: true }); });
afterEach(() => {
  for (const m of loaded.splice(0).reverse()) m.dispose();
  for (const k of ['__lateApi', '__shape', '__core', '__acts']) delete g[k];
  h.cleanup();
});

const load = async (trusted = true) => {
  const m = await loadMods({ bundledDir: path.join(h.home, 'no-bundled'), userDir: h.modsDir, home: h.home, disabled: new Set(), trusted: () => trusted, env: {} });
  loaded.push(m);
  return m;
};
const find = (m: Mods, id: string) => m.mods.find((x) => x.id === id) as LoadedMod;
const installBeep = () => h.writeMod('toy-beep', beepManifest(), { 'index.js': beepCode() });
/** What core holds, as one string: it must not change when a registration is refused. */
const coreNow = () => JSON.stringify({ n: [...NODES.keys()], c: [...CONDS.keys()], k: [...CARDS.keys()], beep: opOf('BEEP') !== undefined, evil: opOf('EVIL') !== undefined });
const untouched = (m: Mods, before: string, id = 'bad') => {
  expect(coreNow()).toBe(before);
  expect(m.registry.has('block', id)).toBe(false);
  expect(m.registry.has('block-view', 'beep')).toBe(false);
};

const head = '---\nreins: 1\nname: toy\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n';
const text = head + '## beep\ntimes: 2\n\n## phase one\n> go\n';

describe('toy-beep: a block mod, from one folder to `reins run`', () => {
  it('loads trusted; parses, prints back, validates, compiles to BEEP, runs, logs beeped and counts', async () => {
    installBeep();
    const before = [...NODES.keys()];
    const mods = await load();
    expect(find(mods, 'toy-beep')).toMatchObject({ kind: 'block', problems: [], trusted: true, hasCode: true });
    expect(marked()).toEqual(['toy-beep loaded']);
    expect([...NODES.keys()]).toEqual([...before, 'beep']); // order 140: after `end` (130)
    expect(mods.registry.get('block-view', 'beep')).toEqual(beepManifest().view);

    const p = parseWorkflow(text);
    expect(p.diagnostics).toEqual([]);
    const w = p.workflow!;
    expect(printWorkflow(w)).toBe(text);
    expect(validate(w).filter((d) => d.severity === 'error')).toEqual([]);
    expect(compileProgram(w)[0]).toMatchObject({ op: 'BEEP', times: 2 });

    const hr = harness('beep', [{ text: 'ok\nREINS: done' }]);
    const run = new Run({ workflow: w, engine: hr.engine, now: hr.now });
    for (let k = 0; k < 20 && run.status === 'running'; k++) await run.step();
    expect(run.status).toBe('done');
    expect(run.getEvents().filter((e) => e.type === 'beeped').map((e) => e.data)).toEqual([{ step: 'beep-1', times: 2 }]);
    expect(receipt(run.getEvents()).counts).toEqual({ beeps: 1 });
  });

  it('`reins run` prints the block\'s line and the count tail line', async () => {
    installBeep();
    await load();
    const f = fakeSetup([]);
    const file = path.join(f.dir, 'w.reins.md');
    fs.writeFileSync(file, text);
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.setEncoding('utf8');
    output.on('data', (d: string) => { out += d; });
    const store = openStore(':memory:');
    const res = await startRunCli({
      file, cwd: f.dir, input, output, store,
      makeEngine: ({ onApprove, onLive }) => claudeEngine({ bin: FAKE_CLAUDE, onApprove, onLive }),
    }).done;
    expect(res.status).toBe('done');
    expect(res.receipt!.counts).toEqual({ beeps: 1 });
    const lines = out.split('\n');
    expect(lines).toContain('  beeped x2');
    expect(lines[lines.findIndex((l) => l.startsWith('run id ')) - 1]).toBe('beeps 1');
    store.close();
  }, 60_000);

  it('an UNTRUSTED copy does not run, registers no kind, and its view is already there from the manifest', async () => {
    installBeep();
    const before = coreNow();
    const mods = await load(false);
    const m = find(mods, 'toy-beep');
    expect(m).toMatchObject({ trusted: false, hasCode: true });
    expect(m.problems.join(' ')).toContain('needs trust');
    expect(marked()).toEqual([]); // the code was not imported
    expect(fs.existsSync(path.join(h.home, 'mod-cache'))).toBe(false);
    expect(coreNow()).toBe(before);
    expect(mods.registry.has('block', 'toy-beep')).toBe(false);
    expect(mods.registry.get('block-view', 'beep')).toEqual(beepManifest().view); // served before trust, from mod.json
    mods.dispose();
    expect(mods.registry.has('block-view', 'beep')).toBe(false);
  });

  it('dispose takes the kind, its op and its view out again', async () => {
    installBeep();
    const before = coreNow();
    const mods = await load();
    expect(NODES.has('beep')).toBe(true);
    mods.dispose();
    expect(coreNow()).toBe(before);
    expect(mods.registry.has('block-view', 'beep')).toBe(false);
  });
});

// A block whose node is `{ ...BASE, <extra> }`, registered by hand-written code, under a manifest that lists `kinds: beep, ops: BEEP, attrs: times`.
const BASE = "{ kind: 'beep', attrs: ['times'], compile() {}, ops: { BEEP: { async exec(i, vm) { vm.next(); } } } }";
const baseNode = () => ({ kind: 'beep', attrs: ['times'], compile() {}, ops: { BEEP: { async exec() {} } } });
const withExtra = (extra: string) => `{ ...${BASE}, ${extra} }`;
const code = (body: string) => `export default function activate(api) { ${body} }\n`;
const blockManifest = (over: Record<string, unknown> = {}, provides: Record<string, unknown> = {}) => ({
  reins: 1, id: 'bad', kind: 'block', version: '1.0.0', label: 'Bad', main: 'index.js', order: 140,
  provides: { kinds: ['beep'], ops: ['BEEP'], attrs: ['times'], events: [], ...provides },
  view: { kind: 'beep', fields: [], line: ['beep'] },
  ...over,
});

describe('the api registers only what `provides` lists, and a refusal leaves nothing', () => {
  it('control: the base node under the base manifest loads', async () => {
    h.writeMod('bad', blockManifest(), { 'index.js': code(`api.registerBlock(${BASE});`) });
    const mods = await load();
    expect(find(mods, 'bad').problems).toEqual([]);
    expect(opOf('BEEP')).toBeDefined();
  });

  const cases: Array<[string, string, Record<string, unknown>, string]> = [
    ['a kind that is not listed', withExtra("kind: 'other'"), {}, '`provides.kinds` does not list the kind "other".'],
    ['an op that is not listed', withExtra('ops: { BEEP: { async exec() {} }, EVIL: { async exec() {} } }'), {}, '`provides.ops` does not list the op "EVIL".'],
    ['an attribute that is not listed', withExtra("attrs: ['times', 'mode']"), {}, '`provides.attrs` does not list the attribute "mode".'],
    ['a heading.owns key that is not listed', withExtra("heading: { parse: () => false, print: () => ({ text: '', condInHeading: false }), owns: ['zzz'] }"), {}, '`provides.attrs` does not list the heading key "zzz".'],
    ['a count key that is not listed', withExtra("count: { beeped: () => 'beeps' }"), {}, '`provides.events` does not list the counted event "beeped".'],
    ['a print key that is not listed', withExtra("print: { beeped: () => 'x' }"), {}, '`provides.events` does not list the printed event "beeped".'],
    ['an attrs list that is not names', withExtra('attrs: [7]'), {}, '`attrs` must be a list of names.'],
  ];
  for (const [name, node, provides, message] of cases) {
    it(`refuses ${name}, and nothing stays`, async () => {
      h.writeMod('bad', blockManifest({}, provides), { 'index.js': code(`api.registerBlock(${node});`) });
      const before = coreNow();
      const mods = await load();
      expect(find(mods, 'bad').problems).toEqual([`\`bad\`: ${message}`]);
      untouched(mods, before);
    });
  }

  it('a listed count, print and heading key are accepted when `provides` lists them', async () => {
    const node = withExtra("heading: { parse: () => false, print: () => ({ text: '', condInHeading: false }), owns: ['times'] }, count: { beeped: () => 'b' }, print: { beeped: () => 'x' }");
    h.writeMod('bad', blockManifest({}, { events: ['beeped'] }), { 'index.js': code(`api.registerBlock(${node});`) });
    expect(find(await load(), 'bad').problems).toEqual([]);
  });

  it('a first good registration is taken out again when a second one is refused', async () => {
    h.writeMod('bad', blockManifest(), { 'index.js': code(`api.registerBlock(${BASE}); api.registerBlock(${withExtra("kind: 'two'")});`) });
    const before = coreNow();
    const mods = await load();
    expect(find(mods, 'bad').problems).toEqual(['`bad`: `provides.kinds` does not list the kind "two".']);
    untouched(mods, before);
  });

  it('a mod naming the core op TURN is refused by core', async () => {
    h.writeMod('bad', blockManifest({}, { ops: ['TURN'] }), { 'index.js': code(`api.registerBlock(${withExtra('ops: { TURN: { async exec() {} } }')});`) });
    const before = coreNow();
    const mods = await load();
    expect(find(mods, 'bad').problems).toEqual(['`bad`: op "TURN" is a core op']);
    untouched(mods, before);
  });

  it('a kind core already has is refused', async () => {
    h.writeMod('bad', blockManifest({ view: { kind: 'say', fields: [], line: ['say'] } }, { kinds: ['say'] }), { 'index.js': code(`api.registerBlock(${withExtra("kind: 'say', ops: undefined")});`) });
    const before = coreNow();
    const mods = await load();
    expect(find(mods, 'bad').problems).toEqual(['`bad`: kind "say" is already registered']);
    untouched(mods, before);
    expect(mods.registry.has('block-view', 'say')).toBe(false);
  });

  it('what is checked is what is stored: a getter that answers differently the second time has no effect', async () => {
    const node = "{ kind: 'beep', attrs: ['times'], compile() {}, get ops() { return n++ === 0 ? { BEEP: { async exec(i, vm) { vm.next(); } } } : { EVIL: { async exec() {} } }; } }";
    h.writeMod('bad', blockManifest(), { 'index.js': `let n = 0;\n${code(`api.registerBlock(${node});`)}` });
    const mods = await load();
    expect(find(mods, 'bad').problems).toEqual([]);
    expect(Object.keys(NODES.get('beep')!.ops!)).toEqual(['BEEP']);
    expect(opOf('EVIL')).toBeUndefined();
    expect(Object.isFrozen(NODES.get('beep'))).toBe(true);
  });

  it('a condition mod calling registerBlock is refused, and a block mod calling registerCondition or registerCard', async () => {
    h.writeMod('ping', { reins: 1, id: 'ping', kind: 'condition', version: '1.0.0', label: 'Ping', main: 'index.js', order: 120, provides: { conditions: ['ping'] } }, { 'index.js': code(`api.registerBlock(${BASE});`) });
    h.writeMod('bad', blockManifest(), { 'index.js': code("api.registerCondition({ t: 'ping', parse: () => null, print: () => '', judge: 'agent' });") });
    h.writeMod('bad2', blockManifest({ id: 'bad2' }), { 'index.js': code("api.registerCard({ kind: 'zap' });") });
    const before = coreNow();
    const mods = await load();
    expect(find(mods, 'ping').problems).toEqual(['`ping`: `registerBlock` is for block mods; this is a condition mod.']);
    expect(find(mods, 'bad').problems).toEqual(['`bad`: `registerCondition` is for condition mods; this is a block mod.']);
    expect(find(mods, 'bad2').problems).toEqual(['`bad2`: `registerCard` is for card mods; this is a block mod.']);
    expect(coreNow()).toBe(before);
  });

  it('every function member refuses once activate has returned; core stays callable', async () => {
    h.writeMod('bad', blockManifest(), { 'index.js': code('globalThis.__lateApi = api;') });
    const before = coreNow();
    const mods = await load();
    expect(find(mods, 'bad').problems).toEqual([]);
    const api = g.__lateApi;
    const words = 'the api can only be used while the mod activates.';
    expect(() => api.registerBlock(baseNode())).toThrow(words);
    expect(() => api.registerCondition({ t: 'ping', parse: () => null, print: () => '', judge: 'agent' })).toThrow(words);
    expect(() => api.registerCard({ kind: 'zap' })).toThrow(words);
    expect(() => api.registerProtocol({ id: 'late', conversation: 'reins', wire: {} })).toThrow(words);
    expect(coreNow()).toBe(before);
    expect(api.core.turnInstr).toBe(turnInstr);
  });

  it('the api also closes when activate throws', async () => {
    h.writeMod('bad', blockManifest(), { 'index.js': code("globalThis.__lateApi = api; throw new Error('boom');") });
    const mods = await load();
    expect(find(mods, 'bad').problems).toEqual(['`bad`: boom']);
    expect(() => g.__lateApi.registerBlock(baseNode())).toThrow('the api can only be used while the mod activates.');
    expect(NODES.has('beep')).toBe(false);
  });

  it('an async activate may register after an await, before it settles', async () => {
    h.writeMod('bad', blockManifest(), { 'index.js': `export default async function activate(api) { await null; api.registerBlock(${BASE}); }\n` });
    expect(find(await load(), 'bad').problems).toEqual([]);
    expect(NODES.has('beep')).toBe(true);
  });

  it('the api and api.core are frozen, and core holds exactly checkMode, policyOf and turnInstr', async () => {
    h.writeMod('bad', blockManifest(), { 'index.js': code('globalThis.__core = api.core; globalThis.__shape = { api: Object.keys(api).sort(), core: Object.keys(api.core).sort(), frozen: [Object.isFrozen(api), Object.isFrozen(api.core)] };') });
    await load();
    expect(g.__shape).toEqual({
      api: ['core', 'env', 'registerBlock', 'registerCard', 'registerCondition', 'registerProtocol'],
      core: ['checkMode', 'policyOf', 'turnInstr'],
      frozen: [true, true],
    });
    expect(g.__core.checkMode).toBe(checkMode);
    expect(g.__core.policyOf).toBe(policyOf);
    expect(g.__core.turnInstr).toBe(turnInstr);
  });
});

describe('a block manifest is checked before any code runs', () => {
  const cases: Array<[string, (m: Record<string, any>) => void, string]> = [
    ['no code', (m) => { delete m.main; }, 'a block mod needs code (`main`).'],
    ['no order', (m) => { delete m.order; }, '`order` must be a number (got undefined).'],
    ['an order that is not a number', (m) => { m.order = '20'; }, '`order` must be a number (got "20").'],
    ['no provides', (m) => { delete m.provides; }, '`provides` must be an object listing what the mod adds.'],
    ['a provides key the kind cannot add', (m) => { m.provides.conditions = ['x']; }, '`provides.conditions` is not something a block mod can add. It can add: kinds, ops, attrs, events.'],
    ['a provides list that is not names', (m) => { m.provides.ops = ['not a name']; }, '`provides.ops` must be a list of at most 50 names'],
    ['a provides list that is not a list', (m) => { m.provides.attrs = 'times'; }, '`provides.attrs` must be a list of at most 50 names'],
    ['a name twice', (m) => { m.provides.kinds = ['beep', 'beep']; }, '`provides.kinds` lists a name twice.'],
    ['more than 50 names', (m) => { m.provides.ops = Array.from({ length: 51 }, (_, i) => `OP${i}`); }, '`provides.ops` must be a list of at most 50 names'],
    ['no kinds', (m) => { m.provides.kinds = []; }, '`provides.kinds` lists nothing.'],
    ['no view', (m) => { delete m.view; }, '`view` must be an object.'],
    ['a view whose kind is not provided', (m) => { m.view.kind = 'other'; }, '`view.kind` must be one of `provides.kinds`.'],
    ['a view without fields', (m) => { delete m.view.fields; }, '`view` needs `fields` and `line`.'],
    ['a view without line', (m) => { delete m.view.line; }, '`view` needs `fields` and `line`.'],
    ['a view whose fresh is not an object', (m) => { m.view.fresh = 'x'; }, '`view.fresh` must be an object.'],
    ['a view order that is not a number', (m) => { m.view.order = 'x'; }, '`view.order` must be a number.'],
    ['a view with too many fields', (m) => { m.view.fields = Array.from({ length: 51 }, () => ({})); }, '`view.fields` and `view.line` hold at most 50 entries.'],
    ['a view that is too big', (m) => { m.view.fields = [{ label: 'x'.repeat(33 * 1024) }]; }, '`view` is larger than 32 KB.'],
    ['a hidden character in a shown text', (m) => { m.view.fields = [{ key: 'times', label: 'Times‮' }]; }, 'a text in `view` holds a control, line-break or direction-changing character'],
    ['a hidden character in a key', (m) => { m.view.fields = [{ 'ti​mes': 1 }]; }, 'a text in `view` holds a control, line-break or direction-changing character'],
  ];
  for (const [name, change, message] of cases) {
    it(`refuses ${name}; the code is not read`, async () => {
      const m = blockManifest();
      change(m);
      h.writeMod('bad', m, { 'index.js': code(`globalThis.__lateApi = 'ran'; api.registerBlock(${BASE});`) });
      const before = coreNow();
      const mods = await load();
      const mod = find(mods, 'bad');
      expect(mod.problems).toHaveLength(1);
      expect(mod.problems[0]).toContain(`\`bad\`: ${message}`);
      expect(mod.hash).toBeUndefined(); // the files were not even hashed
      expect(g.__lateApi).toBeUndefined();
      untouched(mods, before);
    });
  }
});

describe('a condition mod and a card mod, one each', () => {
  it('a condition is registered at its order, is refused when not listed, and goes with dispose', async () => {
    const atom = "{ t: 'ping', parse(s) { if (!s.src.startsWith('ping', s.idx)) return null; s.idx += 4; return { t: 'ping' }; }, print: () => 'ping', judge: 'agent', evalSync: () => true }";
    const manifest = (id: string) => ({ reins: 1, id, kind: 'condition', version: '1.0.0', label: id, main: 'index.js', order: 25, provides: { conditions: ['ping'] } });
    h.writeMod('ping', manifest('ping'), { 'index.js': code(`api.registerCondition(${atom});`) });
    const before = [...CONDS.keys()];
    const mods = await load();
    expect(find(mods, 'ping').problems).toEqual([]);
    const now = [...CONDS.keys()];
    expect(now).toEqual([...before.slice(0, 2), 'ping', ...before.slice(2)]); // order 25: between tests (20) and cmd (30)
    mods.dispose();
    expect([...CONDS.keys()]).toEqual(before);

    h.writeMod('ping', manifest('ping'), { 'index.js': code(`api.registerCondition(${atom.replace("t: 'ping'", "t: 'pong'")});`) });
    const refused = await load();
    expect(find(refused, 'ping').problems).toEqual(['`ping`: `provides.conditions` does not list the condition "pong".']);
    expect([...CONDS.keys()]).toEqual(before);
  });

  it('a card is registered at its order, is refused when not listed, and goes with dispose', async () => {
    const manifest = { reins: 1, id: 'zap', kind: 'card', version: '1.0.0', label: 'Zap', main: 'index.js', order: 15, provides: { cards: ['zap'] } };
    h.writeMod('zap', manifest, { 'index.js': code("api.registerCard({ kind: 'zap', delivery: 'now' });") });
    const before = [...CARDS.keys()];
    const mods = await load();
    expect(find(mods, 'zap').problems).toEqual([]);
    expect([...CARDS.keys()]).toEqual([before[0], 'zap', ...before.slice(1)]); // order 15: between guard (10) and now (20)
    mods.dispose();
    expect([...CARDS.keys()]).toEqual(before);

    h.writeMod('zap', manifest, { 'index.js': code("api.registerCard({ kind: 'boom' });") });
    const refused = await load();
    expect(find(refused, 'zap').problems).toEqual(['`zap`: `provides.cards` does not list the card "boom".']);
    expect([...CARDS.keys()]).toEqual(before);
  });
});

describe('the kinds', () => {
  it('block, condition and card are startOnly; protocol and provider are not', () => {
    for (const id of ['block', 'condition', 'card']) expect(kindOf(id)?.startOnly, id).toBe(true);
    for (const id of ['protocol', 'provider']) expect(kindOf(id)?.startOnly, id).toBeUndefined();
  });

  it('block loads after condition and card', () => {
    const ids = kindsInOrder().map((k) => k.id);
    expect(ids.indexOf('block')).toBeGreaterThan(ids.indexOf('condition'));
    expect(ids.indexOf('block')).toBeGreaterThan(ids.indexOf('card'));
  });

  it('mods load in that order: condition, card, then block', async () => {
    installBeep();
    h.writeMod('ping', { reins: 1, id: 'ping', kind: 'condition', version: '1.0.0', label: 'Ping', main: 'index.js', order: 120, provides: { conditions: ['ping'] } }, { 'index.js': code('') });
    h.writeMod('zap', { reins: 1, id: 'zap', kind: 'card', version: '1.0.0', label: 'Zap', main: 'index.js', order: 40, provides: { cards: ['zap'] } }, { 'index.js': code('') });
    const mods = await load();
    expect(mods.mods.map((m) => m.id)).toEqual(['ping', 'zap', 'toy-beep']);
  });
});

// ---- Task 16b: the server's own `startMods`, which owns the carry. Trust is the real `<home>/mod-trust.json`.
const trust = (...ids: string[]) => fs.writeFileSync(path.join(h.home, 'mod-trust.json'), JSON.stringify(Object.fromEntries(ids.map((id) => [id, hashFiles(readFolder(path.join(h.modsDir, id), id))]))));
const start = async () => {
  const m = await startMods({ dir: h.home, env: {} });
  loaded.push(m);
  return m;
};
const acts = () => (g.__acts as number | undefined) ?? 0;
const NOTICE = (id: string) => `\`${id}\`: applies after a restart.`;
/** A block mod `cnt` whose activate counts its calls in a global; `v` changes its files (and so its hash). */
const countedBlock = (v = '1.0.0', label = 'Cnt') => h.writeMod('cnt', blockManifest({ id: 'cnt', version: v, view: { kind: 'beep', fields: [], line: [label] } }), { 'index.js': code(`globalThis.__acts = (globalThis.__acts ?? 0) + 1; api.registerBlock(${BASE});`) });
const ATOM = "{ t: 'ping', parse(s) { if (!s.src.startsWith('ping', s.idx)) return null; s.idx += 4; return { t: 'ping' }; }, print: () => 'ping', judge: 'agent', evalSync: () => true }";
const countedCondition = () => h.writeMod('ping', { reins: 1, id: 'ping', kind: 'condition', version: '1.0.0', label: 'Ping', main: 'index.js', order: 25, provides: { conditions: ['ping'] } }, { 'index.js': code(`globalThis.__acts = (globalThis.__acts ?? 0) + 1; api.registerCondition(${ATOM});`) });
const countedCard = () => h.writeMod('zap', { reins: 1, id: 'zap', kind: 'card', version: '1.0.0', label: 'Zap', main: 'index.js', order: 15, provides: { cards: ['zap'] } }, { 'index.js': code("globalThis.__acts = (globalThis.__acts ?? 0) + 1; api.registerCard({ kind: 'zap', delivery: 'now' });") });

describe('start-time carry: a reload keeps what block, condition and card mods put in core', () => {
  it('after reload() the node is the same object, one key, same order, activate ran once, the view is recorded again', async () => {
    countedBlock();
    trust('cnt');
    const before = coreNow();
    const mods = await start();
    expect(find(mods, 'cnt').problems).toEqual([]);
    const node = NODES.get('beep');
    const keys = [...NODES.keys()];
    const first = mods.registry;
    expect(acts()).toBe(1);
    for (let n = 0; n < 2; n++) {
      expect(await mods.reload!()).toEqual([]);
      expect(NODES.get('beep')).toBe(node);
      expect([...NODES.keys()]).toEqual(keys);
      expect(keys.filter((k) => k === 'beep')).toHaveLength(1);
      expect(acts()).toBe(1); // the code's activate was not called again
      expect(mods.registry).not.toBe(first); // a new registry was built ...
      expect(mods.registry.get('block-view', 'beep')).toEqual({ kind: 'beep', fields: [], line: ['Cnt'] }); // ... and holds the view
      expect(mods.registry.has('block', 'cnt')).toBe(true);
      expect(first.has('block-view', 'beep')).toBe(false); // the old one was disposed
      expect(find(mods, 'cnt')).toMatchObject({ problems: [], trusted: true, enabled: true });
    }
    mods.dispose();
    expect(coreNow()).toBe(before);
  });

  it('a failed activation leaves nothing in core, at start and on a reload that already carries another mod', async () => {
    h.writeMod('bad', blockManifest(), { 'index.js': code(`api.registerBlock(${BASE}); throw new Error('boom');`) });
    trust('bad');
    const before = coreNow();
    const mods = await start();
    expect(find(mods, 'bad').problems).toEqual(['`bad`: boom']);
    untouched(mods, before);
    const size = NODES.size;

    h.writeMod('bad2', blockManifest({ id: 'bad2' }), { 'index.js': code(`api.registerBlock(${BASE}); api.registerBlock(${withExtra("kind: 'two'")});`) });
    countedCondition();
    trust('bad', 'bad2', 'ping');
    expect(await mods.reload!()).toEqual([]);
    expect(find(mods, 'bad2').problems).toEqual(['`bad2`: `provides.kinds` does not list the kind "two".']);
    expect(NODES.size).toBe(size);
    expect(NODES.has('beep')).toBe(false);
    expect(opOf('BEEP')).toBeUndefined();
    expect(CONDS.has('ping')).toBe(true); // the good one beside it is carried
    expect(mods.registry.has('block-view', 'beep')).toBe(false);
    mods.dispose();
    expect(coreNow()).toBe(before);
  });

  it('dispose() removes the kinds and restores the registries; a second startMods in the same process registers cleanly', async () => {
    countedBlock();
    countedCondition();
    countedCard();
    trust('cnt', 'ping', 'zap');
    const before = coreNow();
    const lists = () => [[...NODES.keys()], [...CONDS.keys()], [...CARDS.keys()]];
    const clean = lists();
    const a = await start();
    expect(a.mods.filter((m) => m.problems.length)).toEqual([]);
    expect(NODES.has('beep') && CONDS.has('ping') && CARDS.has('zap')).toBe(true);
    await a.reload!();
    a.dispose();
    expect(lists()).toEqual(clean);
    expect(coreNow()).toBe(before);
    expect(a.registry.has('block-view', 'beep')).toBe(false);

    const b = await start();
    expect(b.mods.filter((m) => m.problems.length)).toEqual([]); // not "already registered"
    expect(NODES.has('beep') && CONDS.has('ping') && CARDS.has('zap')).toBe(true);
    expect(acts()).toBe(6);
    expect(b.registry.get('block-view', 'beep')).toBeDefined();
    b.dispose();
    expect(lists()).toEqual(clean);
  });

  it('a changed carried mod says "applies after a restart", keeps the old registration and the old view, and does not run the new code', async () => {
    countedBlock();
    trust('cnt');
    const mods = await start();
    const node = NODES.get('beep');
    countedBlock('1.0.1', 'Changed');
    trust('cnt');
    expect(await mods.reload!()).toEqual([]);
    expect(find(mods, 'cnt').problems).toEqual([NOTICE('cnt')]);
    expect(NODES.get('beep')).toBe(node);
    expect(acts()).toBe(1);
    expect(mods.registry.get('block-view', 'beep')).toEqual({ kind: 'beep', fields: [], line: ['Cnt'] }); // what is running, not what the file now says
    expect(mods.registry.has('block', 'cnt')).toBe(true);
  });

  it('a carried mod whose manifest or code changed says so even when trust says yes (the loader alone, one carry map)', async () => {
    countedBlock();
    const carry = new Map<string, Carried>();
    const opts = { bundledDir: path.join(h.home, 'no-bundled'), userDir: h.modsDir, home: h.home, disabled: new Set<string>(), trusted: () => true, env: {}, carry };
    loaded.push(await loadMods(opts));
    const node = NODES.get('beep');
    countedBlock('1.0.1', 'Changed');
    const next = await loadMods(opts);
    loaded.push(next);
    expect(find(next, 'cnt').problems).toEqual([NOTICE('cnt')]);
    expect(NODES.get('beep')).toBe(node);
    expect(acts()).toBe(1);
    expect(next.registry.get('block-view', 'beep')).toEqual({ kind: 'beep', fields: [], line: ['Cnt'] });
    dropCarried(carry);
    expect(NODES.has('beep')).toBe(false);
  });

  it('a carried mod whose index.js changed under a byte-identical mod.json says so and keeps the old node; the same code says nothing', async () => {
    countedBlock();
    const carry = new Map<string, Carried>();
    const opts = { bundledDir: path.join(h.home, 'no-bundled'), userDir: h.modsDir, home: h.home, disabled: new Set<string>(), trusted: () => true, env: {}, carry };
    loaded.push(await loadMods(opts));
    const node = NODES.get('beep');
    const manifestBytes = fs.readFileSync(path.join(h.modsDir, 'cnt', 'mod.json'));
    const same = await loadMods(opts);
    loaded.push(same);
    expect(find(same, 'cnt').problems).toEqual([]);

    fs.appendFileSync(path.join(h.modsDir, 'cnt', 'index.js'), '// changed code, same manifest\n');
    expect(fs.readFileSync(path.join(h.modsDir, 'cnt', 'mod.json')).equals(manifestBytes)).toBe(true);
    const next = await loadMods(opts);
    loaded.push(next);
    expect(find(next, 'cnt').problems).toEqual([NOTICE('cnt')]);
    expect(NODES.get('beep')).toBe(node);
    expect(acts()).toBe(1);
    dropCarried(carry);
  });

  it('a carried mod is not published or announced again: beforeActivate ran once and the code folder did not change', async () => {
    countedBlock();
    const carry = new Map<string, Carried>();
    const ran: string[] = [];
    const opts = { bundledDir: path.join(h.home, 'no-bundled'), userDir: h.modsDir, home: h.home, disabled: new Set<string>(), trusted: () => true, env: {}, carry, beforeActivate: (m: LoadedMod) => { ran.push(m.id); } };
    const cache = path.join(h.home, 'mod-cache');
    const listing = () => fs.readdirSync(cache, { recursive: true }).map(String).sort().map((rel) => `${rel} ${fs.statSync(path.join(cache, rel)).mtimeMs}`);
    loaded.push(await loadMods(opts));
    expect(ran).toEqual(['cnt']);
    const before = listing();
    expect(before.length).toBeGreaterThan(0);
    for (let n = 0; n < 2; n++) {
      const next = await loadMods(opts);
      loaded.push(next);
      expect(find(next, 'cnt').problems).toEqual([]);
      expect(ran).toEqual(['cnt']); // not announced again
      expect(listing()).toEqual(before); // nothing written
    }
    dropCarried(carry);
  });

  it('a disabled carried mod stays registered and says so; enabled again it is quiet and still the same node', async () => {
    countedBlock();
    trust('cnt');
    const mods = await start();
    const node = NODES.get('beep');
    fs.writeFileSync(path.join(h.home, 'disabled-mods.json'), JSON.stringify(['cnt']));
    expect(await mods.reload!()).toEqual([]);
    expect(find(mods, 'cnt')).toMatchObject({ enabled: false, problems: [NOTICE('cnt')] });
    expect(NODES.get('beep')).toBe(node);
    expect(mods.registry.get('block-view', 'beep')).toBeDefined();
    fs.rmSync(path.join(h.home, 'disabled-mods.json'));
    expect(await mods.reload!()).toEqual([]);
    expect(find(mods, 'cnt')).toMatchObject({ enabled: true, problems: [] });
    expect(NODES.get('beep')).toBe(node);
    expect(acts()).toBe(1);
  });

  it('a carried mod whose trust is taken back is not unregistered live; it says so', async () => {
    countedBlock();
    trust('cnt');
    const mods = await start();
    const node = NODES.get('beep');
    fs.rmSync(path.join(h.home, 'mod-trust.json'));
    expect(await mods.reload!()).toEqual([]);
    expect(find(mods, 'cnt')).toMatchObject({ trusted: false, problems: [NOTICE('cnt')] });
    expect(NODES.get('beep')).toBe(node);
    expect(mods.registry.get('block-view', 'beep')).toBeDefined();
    expect(acts()).toBe(1);
  });

  it('a removed carried mod is not unregistered live; it stays listed with the same words', async () => {
    countedBlock();
    trust('cnt');
    const mods = await start();
    const node = NODES.get('beep');
    fs.rmSync(path.join(h.modsDir, 'cnt'), { recursive: true });
    expect(await mods.reload!()).toEqual([]);
    expect(find(mods, 'cnt').problems).toEqual([NOTICE('cnt')]);
    expect(NODES.get('beep')).toBe(node);
    expect(mods.registry.get('block-view', 'beep')).toEqual({ kind: 'beep', fields: [], line: ['Cnt'] }); // the kind is still in core, so its view is still served
  });

  it('a condition mod and a card mod are carried the same way', async () => {
    countedCondition();
    countedCard();
    trust('ping', 'zap');
    const mods = await start();
    const cond = CONDS.get('ping');
    const card = CARDS.get('zap');
    const keys = [[...CONDS.keys()], [...CARDS.keys()]];
    expect(await mods.reload!()).toEqual([]);
    expect(CONDS.get('ping')).toBe(cond);
    expect(CARDS.get('zap')).toBe(card);
    expect([[...CONDS.keys()], [...CARDS.keys()]]).toEqual(keys);
    expect(acts()).toBe(2);
    expect(mods.registry.has('condition', 'ping') && mods.registry.has('card', 'zap')).toBe(true);
    expect(mods.mods.filter((m) => m.problems.length)).toEqual([]);
  });

  it('the carry key holds the kind: a mod that changes kind under the same id is not taken for the carried one', async () => {
    countedCondition();
    const carry = new Map<string, Carried>();
    const opts = { bundledDir: path.join(h.home, 'no-bundled'), userDir: h.modsDir, home: h.home, disabled: new Set<string>(), trusted: () => true, env: {}, carry };
    const first = await loadMods(opts);
    loaded.push(first);
    const cond = CONDS.get('ping');
    expect([...carry.keys()]).toEqual(['condition:ping']);
    h.writeMod('ping', blockManifest({ id: 'ping' }), { 'index.js': code(`globalThis.__acts = (globalThis.__acts ?? 0) + 1; api.registerBlock(${BASE});`) });
    loaded.push(await loadMods(opts));
    expect(NODES.has('beep')).toBe(true); // the block was activated, not skipped as "carried"
    expect(acts()).toBe(2);
    expect(CONDS.get('ping')).toBe(cond); // and the condition was not unregistered
    expect([...carry.keys()].sort()).toEqual(['block:ping', 'condition:ping']);
    dropCarried(carry);
  });

  it('a live mod (a protocol) is NOT carried: its code runs again and its registration goes with the load', async () => {
    h.writeMod('wire', { reins: 1, id: 'wire', kind: 'protocol', version: '1.0.0', label: 'Wire', main: 'index.js' }, { 'index.js': code("globalThis.__acts = (globalThis.__acts ?? 0) + 1; api.registerProtocol({ id: 'wire-p', conversation: 'reins', wire: {} });") });
    trust('wire');
    const mods = await start();
    const first = mods.registry;
    expect(first.has('protocol-impl', 'wire-p')).toBe(true);
    expect(await mods.reload!()).toEqual([]);
    expect(acts()).toBe(2);
    expect(mods.registry.has('protocol-impl', 'wire-p')).toBe(true);
    expect(first.has('protocol-impl', 'wire-p')).toBe(false);
  });

  it('only startOnly mods are written to the carry map', async () => {
    h.writeMod('wire', { reins: 1, id: 'wire', kind: 'protocol', version: '1.0.0', label: 'Wire', main: 'index.js' }, { 'index.js': code("api.registerProtocol({ id: 'wire-p', conversation: 'reins', wire: {} });") });
    countedBlock();
    const carry = new Map<string, Carried>();
    loaded.push(await loadMods({ bundledDir: path.join(h.home, 'no-bundled'), userDir: h.modsDir, home: h.home, disabled: new Set(), trusted: () => true, env: {}, carry }));
    expect([...carry.keys()]).toEqual(['block:cnt']);
    expect(carry.get('block:cnt')!.undo).toHaveLength(1); // the node, and nothing else: the view and the mod record belong to the load
    dropCarried(carry);
  });
});
