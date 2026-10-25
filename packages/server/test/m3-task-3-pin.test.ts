// M3 Task 3: `say`, `phase` and `end` move out of core into the default pack. This file runs the three kinds through the REAL loader (`startMods`, a temp home)
// and compares everything they produce with `m3-task-3-pin.expected.json`, which was recorded at HEAD (the commit before the move, where core registered them):
// the parse, the printed file, the diagnostics, the compiled program, the events and the receipt of runs, the chat tags and the served views.
// To record again (only ever at a commit where the answer is known to be right): `PIN_WRITE=1 npx vitest run --project server packages/server/test/m3-task-3-pin.test.ts`.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeEngine, Run, compileProgram, parseWorkflow, printWorkflow, receipt, validate, type ScriptedTurn } from '@reins/core';
import { startMods } from '../src/engines.js';
import { servedKinds } from '../src/mods/kinds-view.js';
import { buildTagged, tagCatalogue, taggedWorkflow } from '../src/tags.js';
import { tempHome } from './mods-harness.js';

const EXPECTED = new URL('./m3-task-3-pin.expected.json', import.meta.url);
const homes: Array<ReturnType<typeof tempHome>> = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });

const head = (name: string) => `---\nreins: 1\nname: ${name}\nbudget: { turns: 20, minutes: 9 }\nalways: []\n---\n\n`;
const LONG = 'Write the migration for the user table and then update every caller of the old programming interface in the whole code base';
const MAIN = head('pin3') + [
  '## phase Plan the work', '> plan it', '',
  '## say', 'mode: read-only', '> say hello', '',
  `## phase ${LONG}`, 'mode: write', '> long one', '',
  '## phase Odd -- Title!! (v2) ##', '> odd', '',
  '## end', '',
  '## phase never', '> after the end', '',
].join('\n');
const SAY_ONLY = head('say-only') + '## say\n> just say\n';
const IN_REPEAT = head('end-in-repeat') + '## repeat\nuntil: you approve\nmax: 3\n\n### phase work\n> work\n\n### end\n';
const BAD = head('bad') + [
  '## phase a', 'mode: readonly', '> a', '',
  '## say', 'mode: readonly', '> b', '',
  '## phase empty', '',
  '## end', 'next: a (max 2)', '> text on an end', '',
  '## phase same', '> x', '', '## phase same', '> y', '',
].join('\n');

const scripted = (n: number): ScriptedTurn[] => Array.from({ length: n }, (_, i) => ({ text: `reply ${i + 1}\nREINS: done`, cost: 0.01 }));

async function drive(text: string, turns: number) {
  const w = parseWorkflow(text).workflow!;
  const engine = new FakeEngine(scripted(turns));
  let t = 0;
  const run = new Run({ workflow: w, engine, now: () => (t += 1000) });
  for (let i = 0; i < 40 && run.status === 'running'; i++) await run.step();
  const snap = run.snapshot();
  return { status: run.status, texts: engine.receivedTexts, events: snap.events, receipt: receipt(snap.events), counter: snap.programCounter };
}

async function record() {
  const h = tempHome();
  homes.push(h);
  const mods = await startMods({ dir: h.home, env: {} });
  try {
    const parsed = (text: string) => {
      const p = parseWorkflow(text);
      return { diagnostics: p.diagnostics, steps: p.workflow?.steps, printed: p.workflow ? printWorkflow(p.workflow) : undefined, validate: p.workflow ? validate(p.workflow) : undefined, program: p.workflow ? compileProgram(p.workflow) : undefined };
    };
    const tags = [[], [{ tag: 'read-only' }], [{ tag: 'mode', arg: 'write' }], [{ tag: 'mode', arg: 'readonly' }], [{ tag: 'bogus' }], [{ tag: 'mode' }], [{ tag: 'read-only', arg: 'x' }], [{ tag: 'read-only' }, { tag: 'mode', arg: 'write' }], [{ tag: 'Bad Name' }]];
    const served = servedKinds(mods).kinds;
    return JSON.parse(JSON.stringify({
      main: parsed(MAIN), sayOnly: parsed(SAY_ONLY), inRepeat: parsed(IN_REPEAT), bad: parsed(BAD),
      runMain: await drive(MAIN, 5), runSay: await drive(SAY_ONLY, 2), runRepeat: await drive(IN_REPEAT, 4),
      tagged: tags.map((t) => buildTagged('hello\nworld', t)),
      taggedWorkflow: taggedWorkflow('hi', [{ tag: 'read-only' }]),
      catalogue: tagCatalogue(),
      order: served.map((k) => k.kind),
      views: served.filter((k) => ['phase', 'say', 'end'].includes(k.kind)),
    }));
  } finally {
    mods.dispose();
  }
}

describe('M3 Task 3: say, phase and end behave exactly as when core registered them', () => {
  it('the parse, print, diagnostics, program, runs, receipts, chat tags and served views match the record made at HEAD', async () => {
    const actual = await record();
    if (process.env.PIN_WRITE === '1') {
      fs.writeFileSync(EXPECTED, JSON.stringify(actual, null, 1) + '\n');
      return;
    }
    expect(actual).toEqual(JSON.parse(fs.readFileSync(EXPECTED, 'utf8')));
  }, 30_000);

  it('the recording is not empty (a missing file or an empty pack would pass an empty comparison)', async () => {
    const expected = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
    expect(expected.main.program.length).toBeGreaterThan(5);
    expect(expected.main.diagnostics).toEqual([]);
    expect(expected.runMain.status).toBe('done');
    expect(expected.runMain.events.length).toBeGreaterThan(10);
    expect(expected.bad.validate.length).toBeGreaterThan(3);
    expect(expected.tagged.filter((t: { ok: boolean }) => t.ok).length).toBeGreaterThan(3);
    expect(expected.views.map((v: { kind: string }) => v.kind)).toEqual(['phase', 'say', 'end']);
  });
});
