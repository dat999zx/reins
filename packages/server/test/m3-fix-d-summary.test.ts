// M3 fix D, item 9: the import summary tells the user that a mod's block may run several sessions at once and spend money on them (spec 9: `starts`, `share`,
// `usd`). It is a field of the summary, `tracksLine`, set from the mod's own manifest (`tracks: true`) or, for a mod that does not say so, from its code text
// (a call to `tracks.start`). The code is read as text and never run. A mod with no code, and a provider, never get the line.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startMods } from '../src/engines.js';
import { importPreview, TRACKS_LINE, type ModEnv } from '../src/mods/actions.js';
import type { Mods } from '../src/mods/types.js';
import { tempHome } from './mods-harness.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });
async function world() {
  const h = tempHome();
  const mods: Mods = await startMods({ dir: h.home, env: {} });
  cleanups.push(() => { mods.dispose(); h.cleanup(); });
  const env: ModEnv = { home: h.home, catalogDir: path.join(h.home, 'no-catalog'), mods, consent: { has: () => false, grant: () => {}, revoke: () => {} } as never, send: async () => new Response(''), env: {}, redact: (t) => t, holdsSecret: () => false };
  return env;
}
const LINE = 'This mod may run several sessions at once and spend money on them.';
const j = (m: unknown) => JSON.stringify(m, null, 2);
const manifest = (over: Record<string, unknown> = {}) => ({
  reins: 1, id: 'tk1', kind: 'block', version: '1.0.0', label: 'Tk 1', main: 'index.js', order: 170, provides: { kinds: ['tkk1'], ops: ['OP_TK1'], attrs: ['times'] },
  view: { kind: 'tkk1', order: 170, colour: 'soft', fields: [{ key: 'times', label: 'Times', input: 'number', check: 'count' }], line: ['tkk1', { field: 'times' }], card: { label: 'tkk1', section: 'Flow' }, fresh: { attrs: { times: '1' } } },
  ...over,
});
const code = (body: string) => `export default function activate(api) {\n  api.registerBlock({ kind: 'tkk1', attrs: ['times'], compile(step, ctx) { ctx.push({ op: 'OP_TK1', step: step.id }); }, ops: { OP_TK1: { async exec(i, vm) { ${body} vm.next(); } } } });\n}\n`;
const file = (m: unknown, js: string) => ({ reinsMod: 1, files: { 'mod.json': j(m), 'index.js': js } });
const sum = (r: { status: number; body: unknown }) => { expect(r.status, JSON.stringify(r.body)).toBe(200); return (r.body as { summary: Record<string, any> }).summary; };

describe('the tracks line', () => {
  it('its words', () => {
    expect(TRACKS_LINE).toBe(LINE);
  });
  it('a code block that says tracks in its manifest gets it', async () => {
    const env = await world();
    const s = sum(importPreview(env, file(manifest({ tracks: true }), code(''))));
    expect(s.tracksLine).toBe(LINE);
    expect(s.codePrompt).toMatch(/^This mod runs its own code inside Reins/);   // the prompt itself is word for word as before
  });
  it('a code block that starts tracks without saying so gets it too (read from its code text)', async () => {
    const env = await world();
    for (const call of ['vm.tracks.start({ at: 3 });', 'vm.tracks .start ({ at: 3, share: true })', 'await vm.tracks\n.start({ at: 3, usd: 2 });']) {
      expect(sum(importPreview(env, file(manifest(), code(call)))).tracksLine, call).toBe(LINE);
    }
  });
  it('a code block that does neither gets none', async () => {
    const env = await world();
    expect(sum(importPreview(env, file(manifest(), code('vm.log("x", {});')))).tracksLine).toBeUndefined();
    expect(sum(importPreview(env, file(manifest({ tracks: false }), code('')))).tracksLine).toBeUndefined();
  });
  it('a manifest that says something else than true is refused', async () => {
    const env = await world();
    for (const bad of ['yes', 1, {}, [], null]) {
      const r = importPreview(env, file(manifest({ tracks: bad }), code('')));
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(JSON.stringify(r.body)).toMatch(/`tracks` must be true or false/);
    }
  });
  it('only the code files are read: a text that mentions the call is not a call', async () => {
    const env = await world();
    const f = file(manifest(), code(''));
    (f.files as Record<string, string>)['notes.txt'] = 'vm.tracks.start is what a fork does';
    expect(sum(importPreview(env, f)).tracksLine).toBeUndefined();
  });
  it('`reads` is checked: a noun, a folder and 1 to 4 field names, all plain names; and nothing else in it', async () => {
    const env = await world();
    const ok = { noun: 'playbook', folder: 'blocks', name: ['title', 'playbook'] };
    expect(importPreview(env, file(manifest({ reads: ok }), code(''))).status).toBe(200);
    for (const bad of ['blocks', null, {}, { ...ok, noun: 'two words' }, { ...ok, folder: '../x' }, { ...ok, name: [] }, { ...ok, name: 'title' }, { ...ok, name: ['a', 'b', 'c', 'd', 'e'] }, { ...ok, name: [3] }, { ...ok, extra: 1 }]) {
      const r = importPreview(env, file(manifest({ reads: bad }), code('')));
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(JSON.stringify(r.body), JSON.stringify(bad)).toMatch(/`reads` must be/);
    }
  });
  it('a mod with no code never gets it, even if it says so', async () => {
    const env = await world();
    const data = { reins: 1, id: 'dt1', kind: 'block', version: '1.0.0', label: 'Dt', turn: 'say {x}', order: 170, tracks: true, provides: { kinds: ['dtk1'], attrs: ['x'] }, view: { kind: 'dtk1', order: 170, colour: 'soft', fields: [{ key: 'x', label: 'X', input: 'text' }], line: ['dtk1'], fresh: {} } };
    expect(sum(importPreview(env, { reinsMod: 1, files: { 'mod.json': j(data) } })).tracksLine).toBeUndefined();
  });
  it('a condition or card mod never gets it, whatever its code says (only a block starts tracks)', async () => {
    const env = await world();
    const cond = { reins: 1, id: 'cn1', kind: 'condition', version: '1.0.0', label: 'C', main: 'index.js', order: 25, tracks: true, provides: { conditions: ['cnx'] } };
    expect(sum(importPreview(env, file(cond, 'export default function activate(api) { api.tracks.start(); }\n'))).tracksLine).toBeUndefined();
  });
  it('a provider never gets it', async () => {
    const env = await world();
    const p = { reins: 1, id: 'pv1', kind: 'provider', version: '1.0.0', label: 'P', protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1', auth: { style: 'none', keyEnv: [] }, defaultModel: 'm', models: [{ id: 'm', label: 'M', context: 1000, maxOutput: 100, tools: true }] };
    expect(sum(importPreview(env, { reinsMod: 1, files: { 'mod.json': j(p) } })).tracksLine).toBeUndefined();
  });
  it('in an envelope each mod has its own', async () => {
    const env = await world();
    const a = file(manifest({ tracks: true }), code(''));
    const b = file(manifest({ id: 'tk2', provides: { kinds: ['tkk2'], ops: ['OP_TK2'], attrs: ['times'] }, view: { ...manifest().view, kind: 'tkk2' } }), code('').replaceAll('tkk1', 'tkk2').replaceAll('OP_TK1', 'OP_TK2'));
    const s = sum(importPreview(env, { reinsMods: 1, mods: { tk1: a.files, tk2: b.files } }));
    const by = Object.fromEntries((s.mods as any[]).map((m) => [m.id, m.tracksLine]));
    expect(by).toEqual({ tk1: LINE, tk2: undefined });
  });
});
