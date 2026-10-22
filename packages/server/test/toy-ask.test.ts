// M2 Task 19: a block mod with no `main` is a data block. Its manifest's `turn` is the prompt, filled from the step's attributes, and the step compiles
// to one TURN through `turnInstr`; its policy is the step's (`policyOf`), never the manifest's. No code, so no trust is needed to load; it is still
// validated. Every mod here is made at run time in a temp home through `tempHome`; the manifest is the fixture `toy-ask`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NODES, Run, compileProgram, opOf, parseWorkflow, printWorkflow, validate } from '@reins/core';
import { harness } from '../../core/test/m1-harness.js';
import { startMods } from '../src/engines.js';
import { loadMods } from '../src/mods/loader.js';
import type { LoadedMod, Mods } from '../src/mods/types.js';
import { tempHome } from './mods-harness.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mods/toy-ask/', import.meta.url));
const askManifest = () => JSON.parse(fs.readFileSync(path.join(FIXTURE, 'mod.json'), 'utf8')) as Record<string, any>;
const BIDI = String.fromCharCode(0x202e); // a right-to-left override, written so no source line holds it
const head = '---\nreins: 1\nname: toy\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n';

let h: ReturnType<typeof tempHome>;
const loaded: Mods[] = [];
beforeEach(() => { h = tempHome(); });
afterEach(() => {
  for (const m of loaded.splice(0).reverse()) m.dispose();
  h.cleanup();
});

const load = async (trusted = true) => {
  const m = await loadMods({ bundledDir: path.join(h.home, 'no-bundled'), userDir: h.modsDir, home: h.home, disabled: new Set(), trusted: () => trusted, env: {} });
  loaded.push(m);
  return m;
};
const find = (m: Mods, id: string) => m.mods.find((x) => x.id === id) as LoadedMod;
/** What core holds, as one string: it must not change when a data block is refused. */
const coreNow = () => JSON.stringify({ n: [...NODES.keys()], ask: NODES.has('ask'), turn: opOf('TURN') !== undefined });
const untouched = (m: Mods, before: string) => {
  expect(coreNow()).toBe(before);
  expect(NODES.has('ask')).toBe(false);
  expect(m.registry.has('block', 'toy-ask')).toBe(false);
  expect(m.registry.has('block-view', 'ask')).toBe(false);
};
/** The fixture with some keys changed (a key set to undefined is removed), written as the home's one mod. */
const installAsk = (change: (m: Record<string, any>) => void = () => {}) => {
  const m = askManifest();
  change(m);
  h.writeMod('toy-ask', m);
};
const compile = (text: string) => {
  const w = parseWorkflow(head + text).workflow!;
  return { w, errors: validate(w).filter((d) => d.severity === 'error').map((d) => d.message), program: compileProgram(w) };
};

describe('a data block loads with no code and is validated like any block', () => {
  it('loads with no trust and no problem: the kind sits in core after end, and its view is recorded from the manifest', async () => {
    installAsk();
    const before = [...NODES.keys()];
    const mods = await load(false); // trust says no; a data block has no code to trust
    expect(find(mods, 'toy-ask')).toMatchObject({ kind: 'block', problems: [], hasCode: false });
    expect([...NODES.keys()]).toEqual([...before, 'ask']); // order 150: after end (130)
    expect(mods.registry.get('block-view', 'ask')).toEqual(askManifest().view);
    expect(fs.existsSync(path.join(h.home, 'mod-cache'))).toBe(false); // nothing was copied or imported
  });

  it('parses, prints back, validates, and compiles to exactly one TURN whose prompt is the filled template', async () => {
    installAsk();
    await load();
    const text = head + '## ask\ntopic: cats\n';
    const p = parseWorkflow(text);
    expect(p.diagnostics).toEqual([]);
    expect(printWorkflow(p.workflow!)).toBe(text);
    const { errors, program } = compile('## ask\ntopic: cats\n');
    expect(errors).toEqual([]);
    expect(program.map((i) => i.op)).toEqual(['TURN', 'END']); // the step's one TURN, then the workflow's END
    expect(program[0]).toMatchObject({ op: 'TURN', policy: { mode: 'write' }, src: { prompt: 'Answer about cats in one line. Mode: cats.' } });
  });

  it('`mode: read-only` on the step is the only way to a read-only policy', async () => {
    installAsk();
    await load();
    expect(compile('## ask\ntopic: cats\nmode: read-only\n').program[0]).toMatchObject({ policy: { mode: 'read-only' } });
    expect(compile('## ask\ntopic: cats\n').program[0]).toMatchObject({ policy: { mode: 'write' } });
  });

  it('a multi-line template keeps its line breaks in the prompt', async () => {
    installAsk((m) => { m.turn = 'Answer about {topic}.\nOne line only.'; });
    expect(find(await load(), 'toy-ask').problems).toEqual([]);
    expect(compile('## ask\ntopic: dogs\n').program[0]).toMatchObject({ src: { prompt: 'Answer about dogs.\nOne line only.' } });
  });

  it('runs in a fake-engine run: the model is sent the filled prompt, and the step is done', async () => {
    installAsk();
    await load();
    const w = parseWorkflow(head + '## ask\ntopic: dogs\nmode: read-only\n').workflow!;
    const hr = harness('ask', [{ text: 'ok\nREINS: done' }]);
    const run = new Run({ workflow: w, engine: hr.engine, now: hr.now });
    for (let k = 0; k < 20 && run.status === 'running'; k++) await run.step();
    expect(run.status).toBe('done');
    expect(hr.engine.receivedTexts.join('\n')).toContain('Answer about dogs in one line. Mode: read-only.');
  });

  it('an untrusted copy is still validated: a bad template is refused, and nothing registers', async () => {
    installAsk((m) => { m.turn = 'Answer about {colour}.'; });
    const before = coreNow();
    const mods = await load(false);
    expect(find(mods, 'toy-ask').problems).toEqual(['`toy-ask`: `turn` names {colour}, which is not in `provides.attrs`.']);
    untouched(mods, before);
  });

  it('dispose takes the kind and its view out again', async () => {
    installAsk();
    const before = coreNow();
    const mods = await load();
    expect(NODES.has('ask')).toBe(true);
    mods.dispose();
    expect(coreNow()).toBe(before);
    expect(mods.registry.has('block-view', 'ask')).toBe(false);
  });
});

describe('a data block refuses what could change its policy or run code', () => {
  for (const key of ['policy', 'mode', 'allowShell', 'tools']) {
    it(`refuses a manifest that sets \`${key}\`, and nothing stays`, async () => {
      installAsk((m) => { m[key] = true; });
      const before = coreNow();
      const mods = await load();
      const problems = find(mods, 'toy-ask').problems;
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`\`${key}\``);
      expect(problems[0]).toContain('never the manifest');
      untouched(mods, before);
    });
  }

  it('refuses a block with both `main` and `turn`', async () => {
    installAsk((m) => { m.main = 'index.js'; });
    const mods = await load();
    expect(find(mods, 'toy-ask').problems).toEqual(['`toy-ask`: a block has code (`main`) or a `turn`, not both.']);
  });

  it('refuses a block with neither `main` nor `turn`, in words that name both', async () => {
    installAsk((m) => { delete m.turn; });
    const mods = await load();
    expect(find(mods, 'toy-ask').problems).toEqual(['`toy-ask`: a block mod needs code (`main`). A block with no code needs a `turn` instead.']);
  });

  it('refuses `ops` on a data block, since it has no code', async () => {
    installAsk((m) => { m.provides.ops = ['ASK']; });
    const before = coreNow();
    const mods = await load();
    expect(find(mods, 'toy-ask').problems).toHaveLength(1);
    expect(find(mods, 'toy-ask').problems[0]).toContain('adds no ops');
    untouched(mods, before);
  });

  it('refuses more than one kind on a data block', async () => {
    installAsk((m) => { m.provides.kinds = ['ask', 'more']; });
    expect(find(await load(), 'toy-ask').problems[0]).toContain('adds one kind');
  });

  it('refuses a placeholder that names an attribute the block does not provide, such as constructor', async () => {
    for (const turn of ['Answer about {colour}.', 'Answer about {constructor}.', 'Answer {topic|colour}.', 'Answer {}.']) {
      installAsk((m) => { m.turn = turn; });
      const before = coreNow();
      const mods = await load();
      expect(find(mods, 'toy-ask').problems).toHaveLength(1);
      expect(find(mods, 'toy-ask').problems[0]).toContain('is not in `provides.attrs`');
      untouched(mods, before);
    }
  });

  it('refuses a hidden character in the template', async () => {
    installAsk((m) => { m.turn = `Answer about {topic}${BIDI}.`; });
    expect(find(await load(), 'toy-ask').problems[0]).toContain('holds a control, direction-changing or zero-width character');
  });

  it('refuses a template of more than 4 KB', async () => {
    installAsk((m) => { m.turn = 'x'.repeat(4 * 1024 + 1); });
    expect(find(await load(), 'toy-ask').problems[0]).toContain('larger than 4 KB');
  });

  it('refuses a status line with a hidden character, or one of more than 200 characters', async () => {
    installAsk((m) => { m.statusLine = `REINS: done${BIDI}`; });
    expect(find(await load(), 'toy-ask').problems[0]).toContain('`statusLine` must be one line');
    installAsk((m) => { m.statusLine = 'x'.repeat(201); });
    expect(find(await load(), 'toy-ask').problems[0]).toContain('`statusLine` must be one line');
  });

  it('refuses a data block that shadows a kind core has, as a code block does', async () => {
    installAsk((m) => { m.provides = { kinds: ['say'], attrs: ['mode'] }; m.view = { kind: 'say', fields: [], line: ['say'] }; m.turn = 'Say {mode}.'; });
    const say = NODES.get('say');
    const mods = await load();
    expect(find(mods, 'toy-ask').problems).toEqual(['`toy-ask`: kind "say" is already registered']);
    expect(NODES.get('say')).toBe(say);
    expect(mods.registry.has('block-view', 'say')).toBe(false);
  });
});

describe('a data block is carried over a reload like a code block (start-time)', () => {
  it('after reload() the node is the same object and one key; a changed template says "applies after a restart" and keeps the old prompt', async () => {
    installAsk();
    const mods = await startMods({ dir: h.home, env: {} });
    loaded.push(mods);
    expect(find(mods, 'toy-ask').problems).toEqual([]);
    const node = NODES.get('ask');
    const keys = [...NODES.keys()];
    expect(await mods.reload!()).toEqual([]);
    expect(NODES.get('ask')).toBe(node);
    expect([...NODES.keys()]).toEqual(keys);
    expect(mods.registry.get('block-view', 'ask')).toEqual(askManifest().view);
    installAsk((m) => { m.turn = 'Something else {topic}.'; });
    expect(await mods.reload!()).toEqual([]);
    expect(find(mods, 'toy-ask').problems).toEqual(['`toy-ask`: applies after a restart.']);
    expect(NODES.get('ask')).toBe(node);
    expect(compile('## ask\ntopic: cats\n').program[0]).toMatchObject({ src: { prompt: 'Answer about cats in one line. Mode: cats.' } });
  });
});

describe('a condition mod and a card mod still need code (their words did not change)', () => {
  it('refuses a condition or a card with no `main`, in the same words as before', async () => {
    h.writeMod('ping', { reins: 1, id: 'ping', kind: 'condition', version: '1.0.0', label: 'Ping', order: 25, provides: { conditions: ['ping'] } });
    h.writeMod('zap', { reins: 1, id: 'zap', kind: 'card', version: '1.0.0', label: 'Zap', order: 15, provides: { cards: ['zap'] } });
    const mods = await load();
    expect(find(mods, 'ping').problems).toEqual(['`ping`: a condition mod needs code (`main`).']);
    expect(find(mods, 'zap').problems).toEqual(['`zap`: a card mod needs code (`main`).']);
  });
});
