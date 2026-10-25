// M3 Task 3: what core does when the default pack is not loaded at all (an empty registry), for the required kinds `phase` and `end`.
// The decision, made from the code: core NEEDS neither kind to run. The `END` instruction and the `TURN` instruction are core's own, and a program always
// closes with an `END` (compile.ts), so a workflow with no step compiles and finishes. A step of a kind nobody registered is an ERROR in the parse and in
// `validate` ("Unknown step kind"), so no program is made from it, and `reins check` / `reins run` / the editor say so in plain words. The one place that built
// a step by name was the chat's tags (`## phase prompt`); they now ask for the block marked `chatTurn` and, with none loaded, refuse with words.
// So the loader does not refuse to start: a missing pack is reported, in the place the user meets it, and nothing crashes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_VIEWS, FakeEngine, NODES, Run, compileProgram, parseWorkflow, validate } from '@reins/core';
import { startMods } from '../src/engines.js';
import { servedKinds } from '../src/mods/kinds-view.js';
import { formatDiagnostic, loadWorkflow, startRunCli } from '../src/run-cli.js';
import { openStore } from '../src/store.js';
import { buildTagged, tagCatalogue, taggedWorkflow } from '../src/tags.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-nopack-')); dirs.push(d); return d; };
const head = '---\nreins: 1\nname: t\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n';

/** Starts the loader on a bundled folder with no mod in it: the same as an install that lost the pack. */
async function withoutPack() {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'bundled'));
  return startMods({ dir: path.join(root, 'home'), env: {}, bundledDir: path.join(root, 'bundled') });
}

describe('no pack loaded: an empty registry', () => {
  it('has no phase, say or end, and the loader starts without a problem', async () => {
    const mods = await withoutPack();
    try {
      expect(mods.problems).toEqual([]);
      for (const k of ['phase', 'say', 'end']) expect(NODES.has(k)).toBe(false);
    } finally {
      mods.dispose();
    }
  });

  it('a step of a missing kind is an error in the parse and in validate, with the words of an unknown kind', async () => {
    const mods = await withoutPack();
    try {
      const p = parseWorkflow(`${head}## phase one\n> go\n\n## end\n`);
      expect(p.diagnostics.map((d) => d.message)).toEqual(['Unknown step kind "phase"', 'Unknown step kind "end"']);
      expect(p.diagnostics.every((d) => d.severity === 'error')).toBe(true);
      expect(validate(p.workflow!).map((d) => d.message)).toContain('Unknown step kind "phase"');
    } finally {
      mods.dispose();
    }
  });

  it('a workflow with no step still compiles (core closes it with its own END) and a run of it finishes', async () => {
    const mods = await withoutPack();
    try {
      const p = parseWorkflow(head);
      expect(p.diagnostics).toEqual([]);
      expect(compileProgram(p.workflow!).map((i) => i.op)).toEqual(['END']);
      const run = new Run({ workflow: p.workflow!, engine: new FakeEngine([]) });
      for (let i = 0; i < 5 && run.status === 'running'; i++) await run.step();
      expect(run.status).toBe('done');
    } finally {
      mods.dispose();
    }
  });

  it('`reins check` and `reins run` say the kind is unknown and run nothing', async () => {
    const mods = await withoutPack();
    try {
      const dir = tmp();
      const file = path.join(dir, 'w.reins.md');
      fs.writeFileSync(file, `${head}## phase one\n> go\n`);
      const { diagnostics } = loadWorkflow(file);
      expect(diagnostics.length).toBeGreaterThan(0);
      for (const d of diagnostics) expect(formatDiagnostic(file, d)).toMatch(/error: Unknown step kind "phase"$/);
      const output = new PassThrough();
      let text = '';
      output.setEncoding('utf8');
      output.on('data', (d: string) => { text += d; });
      const store = openStore(':memory:');
      const engine = new FakeEngine([{ text: 'never' }]);
      const res = await startRunCli({ file, cwd: dir, store, yes: true, input: new PassThrough(), output, makeEngine: () => engine }).done;
      store.close();
      expect(engine.receivedTexts).toEqual([]);
      expect(text).toContain('Unknown step kind "phase"');
      expect(res.status).not.toBe('done');
    } finally {
      mods.dispose();
    }
  });

  it('the chat tags refuse with words and build nothing; the tag list has no attribute tag', async () => {
    const mods = await withoutPack();
    try {
      const said = 'No block that takes a turn is installed, so a chat message cannot be wrapped in one. The default pack is missing: reinstall Reins.';
      expect(buildTagged('hi', [])).toEqual({ ok: false, error: said });
      expect(buildTagged('hi', [{ tag: 'read-only' }])).toEqual({ ok: false, error: said });
      expect(taggedWorkflow('hi', [])).toEqual({ ok: false, error: said });
      expect(tagCatalogue().filter((t) => t.place === 'attr' && t.name === 'mode')).toEqual([]);
    } finally {
      mods.dispose();
    }
  });

  it('the app is served the ten views that stay in core and no problem', async () => {
    const mods = await withoutPack();
    try {
      const served = servedKinds(mods);
      expect(served.problems).toEqual([]);
      expect(served.kinds.map((k) => k.kind)).toEqual([...BUILTIN_VIEWS].sort((a, b) => a.order - b.order).map((v) => v.kind));   // whatever stays in core, whichever kinds have moved
    } finally {
      mods.dispose();
    }
  });
});
