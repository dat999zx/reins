// M3 Task 2: a block mod brings its events end to end with no edit under packages/*/src: `count` (a fixed receipt field and a free name), `print`,
// and in its manifest view `status` and `hidden`. The mod is made at run time in a temp home (`tempHome`) and goes through the real loader.
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEngine, Run, parseWorkflow, receipt } from '@reins/core';
import { harness } from '../../core/test/m1-harness.js';
import { loadMods } from '../src/mods/loader.js';
import { servedKinds } from '../src/mods/kinds-view.js';
import type { LoadedMod, Mods } from '../src/mods/types.js';
import { startRunCli } from '../src/run-cli.js';
import { openStore } from '../src/store.js';
import { tempHome } from './mods-harness.js';

declare module '../../core/src/model.js' {
  interface NodeKinds { flag: true }
}
declare module '../../core/src/compile.js' {
  interface Instrs { FLAG: { step: string } }
}
declare module '../../core/src/run.js' {
  interface RunEvents { flagged: unknown; flag_done: unknown }
}

const CODE = `
const flag = {
  kind: 'flag',
  attrs: ['n'],
  compile(step, ctx) { ctx.push({ op: 'FLAG', step: step.id, n: parseInt(step.attrs.n || '1', 10) }); },
  ops: { FLAG: { async exec(i, vm) { vm.log('flagged', { step: i.step, n: i.n }); vm.log('flag_done', { step: i.step, ok: false }); vm.next(); } } },
  count: { flagged: () => 'gatesHeld', flag_done: (d) => (d.ok ? 'flagsOk' : 'flagsBad') },
  print: { flagged: (d) => '  flagged ' + d.n },
};
export default function activate(api) { api.registerBlock(flag); }
`;

const MANIFEST = (view: Record<string, unknown> = {}) => ({
  reins: 1, id: 'toy-flag', kind: 'block', version: '1.0.0', label: 'Toy flag', main: 'index.js', order: 150,
  provides: { kinds: ['flag'], ops: ['FLAG'], attrs: ['n'], events: ['flagged', 'flag_done'] },
  view: {
    kind: 'flag', order: 150, colour: 'soft',
    fields: [{ key: 'n', label: 'N', input: 'number', check: 'count' }],
    line: ['flag', { field: 'n' }],
    card: { label: 'flag', section: 'Flow' },
    fresh: { attrs: { n: '1' } },
    status: {
      flagged: { state: 'waiting', attempts: 'n' },
      flag_done: { when: { key: 'ok', is: [false] }, state: 'failed', why: 'flag' },
    },
    hidden: ['flag_done'],
    ...view,
  },
});

let h: ReturnType<typeof tempHome>;
const loaded: Mods[] = [];
beforeEach(() => { h = tempHome(); });
afterEach(() => { for (const m of loaded.splice(0).reverse()) m.dispose(); h.cleanup(); });

const load = async () => {
  const m = await loadMods({ bundledDir: path.join(h.home, 'no-bundled'), userDir: h.modsDir, home: h.home, disabled: new Set(), trusted: () => true, env: {} });
  loaded.push(m);
  return m;
};
const text = '---\nreins: 1\nname: toy\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n## flag\nn: 3\n\n## phase one\n> go\n';

describe('M3 Task 2: a mod kind with count, print, view.status and view.hidden', () => {
  it('loads, serves its view with the status rules and the hidden list, and the receipt counts into a fixed field and its own names', async () => {
    h.writeMod('toy-flag', MANIFEST(), { 'index.js': CODE });
    const mods = await load();
    expect((mods.mods.find((m) => m.id === 'toy-flag') as LoadedMod).problems).toEqual([]);
    const served = servedKinds(mods);
    expect(served.problems).toEqual([]);
    const v = served.kinds.find((k) => k.kind === 'flag')!;
    expect(v.status).toEqual({ flagged: { state: 'waiting', attempts: 'n' }, flag_done: { when: { key: 'ok', is: [false] }, state: 'failed', why: 'flag' } });
    expect(v.hidden).toEqual(['flag_done']);

    const hr = harness('flag', [{ text: 'ok\nREINS: done' }]);
    const run = new Run({ workflow: parseWorkflow(text).workflow!, engine: hr.engine, now: hr.now });
    for (let k = 0; k < 20 && run.status === 'running'; k++) await run.step();
    expect(run.status).toBe('done');
    const r = receipt(run.getEvents());
    expect(r.gatesHeld).toBe(1);   // the mod's count named a fixed field
    expect(r.counts).toEqual({ flagsBad: 1 });   // and a name of its own
  });

  it('`reins run` prints the mod\'s line from its print hook', async () => {
    h.writeMod('toy-flag', MANIFEST(), { 'index.js': CODE });
    await load();
    const dir = path.join(h.home, 'w');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'w.reins.md');
    fs.writeFileSync(file, text);
    const output = new PassThrough();
    let out = '';
    output.setEncoding('utf8');
    output.on('data', (d: string) => { out += d; });
    const store = openStore(':memory:');
    const res = await startRunCli({ file, cwd: dir, store, yes: true, input: new PassThrough(), output, makeEngine: () => new FakeEngine([{ text: 'REINS: done' }]) }).done;
    store.close();
    expect(res.status).toBe('done');
    expect(out.split('\n')).toContain('  flagged 3');
    expect(res.receipt!.gatesHeld).toBe(1);
  });

  it.each([
    ['a status key that is not in provides.events', { status: { other: { state: 'done' } } }, /not in `provides.events`/],
    ['a status key that is an event core logs', { status: { turn_ended: { state: 'done' } } }, /event core logs/],
    ['a hidden entry that is an event core logs', { hidden: ['run_finished'] }, /event core logs/],
    ['a hidden entry that is not provided', { hidden: ['nope'] }, /not in `provides.events`/],
    ['a status key __proto__', { status: JSON.parse('{"__proto__":{"state":"done"}}') }, /bad name/],
    ['a status key constructor', { status: { constructor: { state: 'done' } } }, /bad name/],
    ['a state that is not one of the five', { status: { flagged: { state: 'exploded' } } }, /state is/],
    ['a rule with an extra key', { status: { flagged: { state: 'done', run: 'rm -rf' } } }, /not part of a status rule/],
    ['a rule that is not an object', { status: { flagged: 'done' } }, /must be an object/],
    ['a status that is a list', { status: [] }, /must be an object/],
    ['a hidden that is not a list', { hidden: 'flag_done' }, /must be a list/],
    ['a hidden entry that is not text', { hidden: [1] }, /bad name/],
    ['a hidden entry twice', { hidden: ['flag_done', 'flag_done'] }, /twice/],
    ['a why text with a hidden character', { status: { flagged: { why: 'a' + String.fromCharCode(0x202e) + 'b' } } }, /hidden character|control|direction/],
    ['a why text far too long', { status: { flagged: { why: 'x'.repeat(5000) } } }, /1 to 200|larger/],
    ['a data key that is an Object member', { status: { flagged: { attempts: 'constructor' } } }, /data name/],
    ['a when with no values', { status: { flagged: { when: { key: 'ok', is: [] } } } }, /1 to 8/],
    ['a when value that is an object', { status: { flagged: { when: { key: 'ok', is: [{}] } } } }, /short text, a number/],
    ['a why with a words table of 9 words', { status: { flagged: { why: { key: 'how', words: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`w${i}`, 'x'])) } } } }, /1 to 8/],
    ['a words key __proto__', { status: { flagged: { why: { key: 'how', words: JSON.parse('{"__proto__":"x"}') } } } }, /not a name/],
    ['a step that is not "track"', { status: { flagged: { step: 'row' } } }, /"track"/],
    ['cursor that is a string', { status: { flagged: { cursor: 'yes' } } }, /must be true/],
  ])('refuses %s', async (_name, view, why) => {
    h.writeMod('toy-flag', MANIFEST(view as Record<string, unknown>), { 'index.js': CODE });
    const mods = await load();
    const mod = mods.mods.find((m) => m.id === 'toy-flag') as LoadedMod;
    expect(mod.problems.join(' ')).toMatch(why);
    expect(servedKinds(mods).kinds.some((k) => k.kind === 'flag')).toBe(false);
  });
});
