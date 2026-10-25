// M3 fix round 2, N6: the "switched off" words of core's Unknown step kind line (`ABSENT_KINDS`) survive a reload (the new load fills, the old one disposes), fall
// back when the newest load goes (a failed reload), never carry a folder name that is not a mod id, and say the true reason.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ABSENT_KINDS } from '@reins/core';
import { loadMods } from '../src/mods/loader.js';
import type { Mods } from '../src/mods/types.js';
import { tempHome } from './mods-harness.js';

let h: ReturnType<typeof tempHome>;
const open: Mods[] = [];
beforeEach(() => { h = tempHome(); fs.mkdirSync(path.join(h.home, 'bundled')); });
afterEach(() => { for (const m of open.splice(0).reverse()) m.dispose(); h.cleanup(); });

const load = async (o: { disabled?: string[]; trusted?: boolean } = {}) => {
  const m = await loadMods({ bundledDir: path.join(h.home, 'bundled'), userDir: h.modsDir, home: h.home, disabled: new Set(o.disabled ?? []), env: {}, trusted: () => o.trusted ?? false });
  open.push(m);
  return m;
};
const dispose = (m: Mods) => { open.splice(open.indexOf(m), 1); m.dispose(); };
const manifest = (id: string, kind: string, over: Record<string, unknown> = {}) => ({
  reins: 1, id, kind: 'block', version: '1.0.0', label: id, main: 'index.js', order: 30, provides: { kinds: [kind] }, view: { kind, fields: [], line: [kind] }, ...over,
});
const code = 'export default function activate(api) { api.registerBlock({ kind: "deploy2", attrs: [], compile() {}, ops: {} }); }\n';

describe('N6a: the words survive a reload', () => {
  it('two loads of one home, the first disposed: the words stay; the last disposed: they go', async () => {
    h.writeMod('deploy2', manifest('deploy2', 'deploy2'), { 'index.js': code });
    const first = await load({ disabled: ['deploy2'] });
    expect(ABSENT_KINDS.get('deploy2')).toMatch(/switched off in Settings/);
    const second = await load({ disabled: ['deploy2'] });
    dispose(first);
    expect(ABSENT_KINDS.get('deploy2')).toMatch(/switched off in Settings/);
    dispose(second);
    expect(ABSENT_KINDS.has('deploy2')).toBe(false);
  });
  it('a load disposed twice takes nothing else with it', async () => {
    h.writeMod('deploy2', manifest('deploy2', 'deploy2'), { 'index.js': code });
    const first = await load({ disabled: ['deploy2'] });
    const second = await load({ disabled: ['deploy2'] });
    dispose(first);
    first.dispose();
    expect(ABSENT_KINDS.get('deploy2')).toMatch(/switched off in Settings/);
    dispose(second);
  });
  it('the words of a newer load are not the old one\'s: a reload that turns the mod on drops them', async () => {
    h.writeMod('deploy2', manifest('deploy2', 'deploy2'), { 'index.js': code });
    const first = await load({ disabled: ['deploy2'] });
    const second = await load({ trusted: true });
    dispose(first);
    expect(ABSENT_KINDS.has('deploy2')).toBe(false);
    dispose(second);
  });
  it('a reload that is thrown away (the newest load disposed) brings the words of the load that stays back', async () => {
    h.writeMod('deploy2', manifest('deploy2', 'deploy2'), { 'index.js': code });
    const kept = await load({ disabled: ['deploy2'] });
    const thrown = await load({ trusted: true });
    expect(ABSENT_KINDS.has('deploy2')).toBe(false);
    dispose(thrown);
    expect(ABSENT_KINDS.get('deploy2')).toMatch(/switched off in Settings/);
    dispose(kept);
  });
});

describe('N6b: only a real mod id reaches the words, and the reason is true', () => {
  it('a folder with a bad id and a hidden character is left out', async () => {
    const folder = `evil${String.fromCharCode(0x202e)}txt.exe${'x'.repeat(150)}`;
    h.writeMod(folder, manifest(folder, 'deploy'), { 'index.js': code });
    await load();
    expect(ABSENT_KINDS.has('deploy')).toBe(false);
  });
  it('every line is short and plain', async () => {
    h.writeMod('deploy2', manifest('deploy2', 'deploy2'), { 'index.js': code });
    await load({ disabled: ['deploy2'] });
    const line = ABSENT_KINDS.get('deploy2')!;
    expect(line.length).toBeLessThan(120);
    expect(line).toMatch(/^[ -~]+$/);
  });
  it('a code mod with a broken manifest that is also untrusted does not say "waiting for your trust"', async () => {
    h.writeMod('deploy2', manifest('deploy2', 'deploy2', { label: undefined }), { 'index.js': code });
    await load({ trusted: false });
    expect(ABSENT_KINDS.get('deploy2')).toMatch(/not loaded/);
    expect(ABSENT_KINDS.get('deploy2')).not.toMatch(/trust/);
  });
  it('a sound code mod that is untrusted still says it waits for trust', async () => {
    h.writeMod('deploy2', manifest('deploy2', 'deploy2'), { 'index.js': code });
    await load({ trusted: false });
    expect(ABSENT_KINDS.get('deploy2')).toMatch(/waiting for your trust/);
  });
});
