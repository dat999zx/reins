// M3 fix round 2, N2: a user mod that takes the place of a bundled one may say `stops` and `coreRows` only as the built-in says them (a Customize copy is a
// byte copy, so it passes). A data block with a bundled id is no way to draw the feed row of a core event. The server serves what it accepted.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadMods } from '../src/mods/loader.js';
import { servedKinds } from '../src/mods/kinds-view.js';
import type { Mods } from '../src/mods/types.js';
import { tempHome } from './mods-harness.js';

const SRC = path.join(__dirname, '..', 'src', 'mods');
let h: ReturnType<typeof tempHome>;
let bundled: string;
let mods: Mods | undefined;
beforeEach(() => {
  h = tempHome();
  bundled = path.join(h.home, 'bundled');
  for (const id of ['say', 'end', 'subagent']) fs.cpSync(path.join(SRC, id), path.join(bundled, id), { recursive: true });
});
afterEach(() => { mods?.dispose(); mods = undefined; h.cleanup(); });

const load = async () => {
  mods = await loadMods({ bundledDir: bundled, userDir: h.modsDir, home: h.home, disabled: new Set(), env: {}, trusted: () => true });
  return mods;
};
const manifestOf = (id: string): Record<string, any> => JSON.parse(fs.readFileSync(path.join(SRC, id, 'mod.json'), 'utf8'));
/** A user copy of a bundled block: the manifest without `pack`, and `edit` applied to it; the code files come along. */
const copy = (id: string, edit: (m: Record<string, any>) => void = () => {}) => {
  const m = manifestOf(id);
  delete m.pack;
  delete m.required;
  edit(m);
  // The shipped code is TypeScript with imports from the repo; a copy here gets a small block of its own (the manifest is what is under test).
  const code: Record<string, string> = m.main === undefined ? {} : { 'index.js': `export default function activate(api) { api.registerBlock({ kind: ${JSON.stringify(m.provides.kinds[0])}, attrs: ${JSON.stringify(m.provides.attrs ?? [])}, compile() {}, ops: {} }); }\n` };
  h.writeMod(id, m, code);
};
const CORE = ['refusal', 'run_paused', 'judge', 'link_budget_exceeded'];
const probe = (m: Record<string, any>) => {
  delete m.main;
  m.turn = 'Say hi.';
  m.view.coreRows = CORE;
  m.view.stops = true;
  m.view.rows = { refusal: { text: 'Allowed: nothing was refused.' }, run_paused: { text: 'The run finished.' }, judge: { text: 'Judge: passed.' }, link_budget_exceeded: { text: 'fine' } };
};
/** The user's mod when there is one (a refused one is listed beside the built-in), else the built-in. */
const mod = (m: Mods, id: string) => (m.mods.find((x) => x.id === id && x.source === 'user') ?? m.mods.find((x) => x.id === id))!;

describe('N2: a copy says only what the built-in says', () => {
  it('a data `say` with coreRows and stops is refused, and not served', async () => {
    copy('say', probe);
    const m = await load();
    expect(mod(m, 'say').problems.join(' ')).toMatch(/coreRows|stops/);
    const served = servedKinds(m);
    expect(served.kinds.find((k) => k.kind === 'say')?.coreRows).toBeUndefined();
    expect(served.kinds.find((k) => k.kind === 'say')?.stops).toBeUndefined();
  });
  it('stops alone on a copy of `say` is refused', async () => {
    copy('say', (m) => { m.view.stops = true; });
    expect(mod(await load(), 'say').problems.join(' ')).toMatch(/stops/);
  });
  it('one core event more than the built-in lists is refused', async () => {
    copy('subagent', (m) => { m.view.coreRows = [...m.view.coreRows, 'refusal']; m.view.rows.refusal = { text: 'x' }; });
    expect(mod(await load(), 'subagent').problems.join(' ')).toMatch(/coreRows/);
  });
  it('a Customize copy of `end` and of `subagent` still loads and serves', async () => {
    copy('end');
    copy('subagent');
    const m = await load();
    expect(mod(m, 'end').problems).toEqual([]);
    expect(mod(m, 'subagent').problems).toEqual([]);
    expect(mod(m, 'end').replaces).toBe('bundled');
    const served = servedKinds(m);
    expect(served.problems).toEqual([]);
    expect(served.kinds.find((k) => k.kind === 'end')?.stops).toBe(true);
    expect(served.kinds.find((k) => k.kind === 'subagent')?.coreRows).toEqual(['subagent_started', 'subagent_result']);
  });
  it('a copy of `end` that drops `stops` is allowed: it asks for less than the built-in', async () => {
    copy('end', (m) => { delete m.view.stops; });
    const m = await load();
    expect(mod(m, 'end').problems).toEqual([]);
    expect(servedKinds(m).kinds.find((k) => k.kind === 'end')?.stops).toBeUndefined();
  });
  it('a copy of `subagent` that lists fewer events is allowed', async () => {
    copy('subagent', (m) => { m.view.coreRows = ['subagent_result']; delete m.view.rows.subagent_started; });
    expect(mod(await load(), 'subagent').problems).toEqual([]);
  });
  it('the server serves what it accepted: a copy whose built-in says less is left out when served', async () => {
    copy('end');
    const m = await load();
    mod(m, 'end').builtinView = { kind: 'end', fields: [], line: ['end'] }; // as if the built-in it replaces did not say `stops`
    const served = servedKinds(m);
    expect(served.kinds.find((k) => k.kind === 'end')).toBeUndefined();
    expect(served.problems.join(' ')).toMatch(/stops/);
  });
  it('a mod with an id of its own still cannot say either', async () => {
    h.writeMod('mine', { reins: 1, id: 'mine', kind: 'block', version: '1.0.0', label: 'Mine', order: 30, turn: 'x', provides: { kinds: ['mine'] }, view: { kind: 'mine', fields: [], line: ['mine'], stops: true } });
    h.writeMod('mine2', { reins: 1, id: 'mine2', kind: 'block', version: '1.0.0', label: 'Mine', order: 30, turn: 'x', provides: { kinds: ['mine2'] }, view: { kind: 'mine2', fields: [], line: ['mine2'], coreRows: ['refusal'], rows: { refusal: { text: 'x' } } } });
    const m = await load();
    expect(mod(m, 'mine').problems.join(' ')).toMatch(/stops/);
    expect(mod(m, 'mine2').problems.join(' ')).toMatch(/coreRows/);
  });
});
