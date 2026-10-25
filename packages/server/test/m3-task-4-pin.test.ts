// M3 Task 4: `gate`, `if`, `recall` and `store` move out of core into the default pack. This file runs the four kinds through the REAL loader (`startMods`, a temp home)
// and compares everything they produce with `m3-task-4-pin.expected.json`, which was recorded at HEAD (the commit before the move, where core registered them):
// the parse, the printed file, the diagnostics, the compiled program, the events and the receipt of runs (with and without the host's recall and store functions,
// a gate held and approved, a gate that judges a condition, an if with and without an else), the chat tags and the served views.
// To record again (only ever at a commit where the answer is known to be right): `PIN_WRITE=1 npx vitest run --project server packages/server/test/m3-task-4-pin.test.ts`.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeEngine, Run, compileProgram, parseWorkflow, printWorkflow, receipt, validate, type ScriptedTurn } from '@reins/core';
import { startMods } from '../src/engines.js';
import { servedKinds } from '../src/mods/kinds-view.js';
import { buildTagged, tagCatalogue } from '../src/tags.js';
import { tempHome } from './mods-harness.js';

const EXPECTED = new URL('./m3-task-4-pin.expected.json', import.meta.url);
const homes: Array<ReturnType<typeof tempHome>> = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });

const head = (name: string) => `---\nreins: 1\nname: ${name}\nbudget: { turns: 30, minutes: 9 }\nalways: []\n---\n\n`;
const MEM = head('pin4-mem') + [
  '## recall', 'knowl: upload, retry ,, deploy', '',
  '## phase plan', '> plan it', '',
  '## store', 'knowl: decision', '',
  '## recall', '',
  '## store', '',
].join('\n');
const GATES = head('pin4-gates') + [
  '## phase first', '> go', '',
  '## gate', 'until: you approve', '',
  '## gate', 'until: agent says done', '',
  '## gate', 'until: tests pass', 'next: first (max 2)', '',
  '## phase last', '> finish', '',
].join('\n');
const IFS = head('pin4-ifs') + [
  '## phase first', '> go', '',
  '## if agent says done', '### phase yes', '> yes branch', '',
  '### else', '',
  '### phase no', '> no branch', '',
  '## if you approve', '### phase only', '> only branch', '',
  '## if', '### phase nocond', '> no condition', '',
  '## phase after', '> after', '',
].join('\n');
const IF_NO = head('pin4-if-no') + [
  '## phase first', '> go', '',
  '## if agent says done', '### phase yes', '> yes branch', '',
  '### else', '',
  '### phase no', '> no branch', '',
].join('\n');
const BAD = head('pin4-bad') + [
  '## gate', '',
  '## if wibble', '### phase a', '> a', '',
  '## gate', 'until: wibble', '',
  '## recall', 'knowl: a', 'mode: write', '',
  '## store', 'max: 3', '',
  '## gate', 'until: you approve', '> text on a gate', '',
].join('\n');

const turn = (text: string): ScriptedTurn => ({ text, cost: 0.01 });
const scripted = (n: number, text = 'done'): ScriptedTurn[] => Array.from({ length: n }, (_, i) => turn(`reply ${i + 1}\nREINS: ${text}`));

async function drive(text: string, turns: ScriptedTurn[], services: 'none' | 'both') {
  const w = parseWorkflow(text).workflow!;
  const engine = new FakeEngine(turns);
  let t = 0;
  const calls: unknown[] = [];
  const run = new Run({
    workflow: w, engine, now: () => (t += 1000),
    ...(services === 'both' ? {
      recall: async (topics: string[]) => { calls.push(['recall', topics]); return topics.map((x) => `ctx ${x}`); },
      store: async (what: string, summary: string) => { calls.push(['store', what, summary]); },
    } : {}),
  });
  const seen: string[] = [];
  for (let i = 0; i < 80; i++) {
    if (run.status === 'running') await run.step();
    else if (run.status === 'paused') { seen.push(JSON.stringify((run.snapshot() as { pause?: unknown }).pause ?? null)); try { run.approve(); } catch { break; } if (run.status === 'paused') break; }
    else break;
  }
  const snap = run.snapshot();
  return { status: run.status, texts: engine.receivedTexts, events: snap.events, receipt: receipt(snap.events), counter: snap.programCounter, calls, seen };
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
    const catalogue = tagCatalogue();
    const tags = [[], ...catalogue.map((c) => [{ tag: c.name, ...(c.arg ? { arg: 'write' } : {}) }]), [{ tag: 'gate' }], [{ tag: 'if' }], [{ tag: 'recall' }], [{ tag: 'store' }]];
    const served = servedKinds(mods).kinds;
    return JSON.parse(JSON.stringify({
      mem: parsed(MEM), gates: parsed(GATES), ifs: parsed(IFS), bad: parsed(BAD),
      runMemNone: await drive(MEM, scripted(5), 'none'),
      runMemBoth: await drive(MEM, scripted(5), 'both'),
      runGates: await drive(GATES, scripted(8), 'none'),
      runIfYes: await drive(IFS, scripted(8, 'done'), 'none'),
      runIfNo: await drive(IF_NO, [turn('go'), turn('REINS: working'), turn('no branch'), turn('REINS: done')], 'none'),
      tagged: tags.map((t) => buildTagged('hello\nworld', t)),
      catalogue,
      order: served.map((k) => k.kind),
      views: served.filter((k) => ['gate', 'if', 'recall', 'store'].includes(k.kind)),
    }));
  } finally {
    mods.dispose();
  }
}

describe('M3 Task 4: gate, if, recall and store behave exactly as when core registered them', () => {
  it('the parse, print, diagnostics, program, runs, receipts, chat tags and served views match the record made at HEAD', async () => {
    const actual = await record();
    if (process.env.PIN_WRITE === '1') {
      fs.writeFileSync(EXPECTED, JSON.stringify(actual, null, 1) + '\n');
      return;
    }
    expect(actual).toEqual(JSON.parse(fs.readFileSync(EXPECTED, 'utf8')));
  }, 30_000);

  it('the recording is not empty (a missing file or an empty pack would pass an empty comparison)', async () => {
    const e = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
    expect(e.mem.diagnostics).toEqual([]);
    expect(e.gates.program.some((i: { op: string }) => i.op === 'GATE')).toBe(true);
    expect(e.ifs.program.some((i: { op: string }) => i.op === 'IF')).toBe(true);
    expect(e.mem.program.map((i: { op: string }) => i.op)).toEqual(expect.arrayContaining(['RECALL', 'STORE']));
    expect(e.bad.diagnostics.length + e.bad.validate.length).toBeGreaterThan(3);
    expect(e.runMemBoth.calls.length).toBe(4);
    expect(e.runMemNone.receipt.knowlSkipped).toBeGreaterThan(0);
    expect(e.runMemBoth.receipt.knowlRecalls).toBe(2);
    expect(e.runGates.receipt.gatesHeld).toBeGreaterThan(0);
    expect(e.runGates.seen.length).toBeGreaterThan(0);
    expect(e.views.map((v: { kind: string }) => v.kind)).toEqual(['gate', 'if', 'recall', 'store']);
    expect(e.tagged.filter((t: { ok: boolean }) => t.ok).length).toBeGreaterThan(0);
  });
});
