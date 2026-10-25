// M3 fix D, item 6, server side: `stops` and `coreRows` are data in the pack manifests (`end` stops, `subagent` lists its two core rows). The server lets only a
// pack block (or its Customize copy) say either, when it reads the manifest and again when it serves the view; a user's block gets neither, whatever it is called.
// A served view is the manifest's own JSON.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startMods } from '../src/engines.js';
import { servedKinds } from '../src/mods/kinds-view.js';
import { hashFiles, readFolder } from '../src/mods/loader.js';
import { tempHome } from './mods-harness.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });
const trust = (home: string, id: string) => fs.writeFileSync(path.join(home, 'mod-trust.json'), JSON.stringify({ [id]: hashFiles(readFolder(path.join(home, 'mods', id), id)) }));
async function start(mod?: { id: string; view: Record<string, unknown> }) {
  const h = tempHome();
  if (mod) {
    h.writeMod(mod.id, { reins: 1, id: mod.id, kind: 'block', version: '1.0.0', label: mod.id, main: 'index.js', order: 1, provides: { kinds: [mod.id], events: ['mine_ran'] }, view: { kind: mod.id, order: 5, colour: 'soft', fields: [], line: [mod.id], fresh: {}, ...mod.view } },
      { 'index.js': `export default function activate(api) { api.registerBlock({ kind: ${JSON.stringify(mod.id)}, attrs: [], compile(step, ctx) { ctx.push({ op: 'END' }); } }); }\n` });
    trust(h.home, mod.id);
  }
  const mods = await startMods({ dir: h.home, env: {} });
  cleanups.push(() => { mods.dispose(); h.cleanup(); });
  return mods;
}

describe('the served view of a pack block carries stops and coreRows from its manifest; no other view does', () => {
  it('end stops and subagent lists its core rows, both from their manifests', async () => {
    const mods = await start();
    const kinds = servedKinds(mods).kinds;
    expect(kinds.find((k) => k.kind === 'end')).toMatchObject({ stops: true });
    expect(kinds.find((k) => k.kind === 'subagent')).toMatchObject({ coreRows: ['subagent_started', 'subagent_result'] });
    expect(kinds.filter((k) => k.stops).map((k) => k.kind)).toEqual(['end']);
    expect(kinds.filter((k) => k.coreRows).map((k) => k.kind)).toEqual(['subagent']);
    expect(servedKinds(mods).problems).toEqual([]);
  });
  it('a served view is the JSON of its manifest: nothing is added to it', async () => {
    const mods = await start();
    for (const id of ['end', 'subagent']) {
      const view = (mods.mods.find((m) => m.id === id)!.manifest as { view: unknown }).view;
      expect(servedKinds(mods).kinds.find((k) => k.kind === id)).toEqual(JSON.parse(JSON.stringify(view)));
    }
  });
  it.each([
    ['stops', { stops: true }, /view\.stops/],
    ['coreRows', { coreRows: ['subagent_started'] }, /view\.coreRows/],
    ['a row over a core event', { rows: { subagent_started: { text: 'stolen' } } }, /event core logs/],
    ['pack (a mark nobody reads)', { pack: true }, /not part of a view/],
  ])('a user block that says %s is refused and not served', async (_n, view, why) => {
    const mods = await start({ id: 'thief', view });
    const m = mods.mods.find((x) => x.id === 'thief')!;
    expect(m.problems.join(' ')).toMatch(why);
    expect(servedKinds(mods).kinds.find((k) => k.kind === 'thief')).toBeUndefined();
    expect(JSON.stringify(servedKinds(mods).kinds)).not.toContain('stolen');
  });
});
