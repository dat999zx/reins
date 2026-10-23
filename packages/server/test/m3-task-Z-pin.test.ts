// M3 Task 7 (group Z): `model` and `subagent` move out of core into the default pack. This file runs them through the REAL loader (`startMods`, a temp home)
// and compares everything they produce with `m3-task-Z-pin.expected.json`, which was recorded at HEAD (where core registered them): the parse, the printed
// file, the diagnostics, the compiled program, the events, the receipt and the USD slices of runs, the printed line of a model switch and the served views.
// To record again (only ever at a commit where the answer is known to be right): `PIN_WRITE=1 npx vitest run --project server packages/server/test/m3-task-Z-pin.test.ts`.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeEngine, NODES, Run, compileProgram, parseWorkflow, printWorkflow, receipt, validate, type ScriptedTurn, type SubagentOpen, type SwitchOutcome } from '@reins/core';
import { startMods } from '../src/engines.js';
import { servedKinds } from '../src/mods/kinds-view.js';
import { tempHome } from './mods-harness.js';

const EXPECTED = new URL('./m3-task-Z-pin.expected.json', import.meta.url);
const homes: Array<ReturnType<typeof tempHome>> = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });

const head = (name: string, usd = 2) => `---\nreins: 1\nname: ${name}\nbudget: { turns: 30, minutes: 9, usd: ${usd} }\nalways: []\n---\n\n`;
const MAIN = head('pinZ') + [
  '## model claude-x', 'usd: 0.10', 'reasoning: high', '',
  '## phase work', '> work', '',
  '## subagent research', 'model: m1', 'usd: 0.50', 'mode: read-only', '> Look it up.', '',
  '## phase use', '> use it', '',
  '## end', '',
].join('\n');
const BAD = head('badZ') + [
  '## model', '',
  '## model', 'usd: 1', '',
  '## model m', 'model: other', '> a prompt on a model step', '',
  '## model m2', '> p', '',
  '## subagent', 'mode: readonly', '',
  '## subagent two', '> fine', '',
  '## subagent two', 'next: model-1', '> x', '',
].join('\n');
const REASON = head('reasonZ') + '## model\nreasoning: low\n\n## phase a\n> a\n';

const phase = (id: string) => `## phase ${id}\n> do ${id}\n`;
const RUNS: Record<string, string> = {
  switched: head('r1') + '## model claude-x\nusd: 0.10\nreasoning: high\n\n' + phase('a') + '\n' + phase('b') + '\n' + phase('c'),
  noSwitch: head('r2') + '## model claude-x\nreasoning: low\n\n' + phase('a'),
  kept: head('r3') + '## model claude-x\nreasoning: low\n\n' + phase('a'),
  stop: head('r4') + '## model claude-x\n\n' + phase('a'),
  closed: head('r5') + '## model claude-x\n\n' + phase('a'),
  sub: head('r6') + phase('a') + '\n## subagent research\nmodel: m1\nusd: 0.50\nmode: read-only\n> Look.\n\n' + phase('b'),
  subOver: head('r7') + '## subagent research\nmodel: m1\nusd: 0.50\n> Look.\n\n' + phase('b') + '\n' + phase('c'),
  subFail: head('r9') + '## subagent research\nmodel: m1\n> Look.\n\n' + phase('b'),
  subLimit: head('r8', 0.2) + '## subagent research\nmodel: m1\nusd: 0.50\n> Look.\n\n' + phase('b'),
};

const turns = (n: number, cost = 0.04): ScriptedTurn[] => Array.from({ length: n }, (_, i) => ({ text: `reply ${i + 1}\nREINS: done`, cost }));

async function drive(name: string, o: { parent?: ScriptedTurn[]; sub?: ScriptedTurn[]; switchTo?: SwitchOutcome | 'none'; openError?: string }) {
  const w = parseWorkflow(RUNS[name]!).workflow!;
  const parent = new FakeEngine(o.parent ?? turns(4));
  const sub = new FakeEngine(o.sub ?? []);
  const opens: Array<{ model?: string; reasoning?: string; maxUsd?: number; mode: string }> = [];
  const calls: string[] = [];
  const sw = o.switchTo === 'none' ? undefined : o.switchTo;
  let t = 0;
  const run = new Run({
    workflow: w, engine: parent, now: () => (t += 1000),
    ...(o.switchTo === 'none' ? {} : { switchModel: async (m: string, s: string): Promise<SwitchOutcome> => { calls.push(`switch ${m} ${s}`); return sw ?? { to: 'switched', label: `L-${m}` }; } }),
    ...(o.switchTo === 'none' ? {} : { setReasoning: (l: string, s: string) => { calls.push(`reasoning ${l} ${s}`); } }),
    openSubagent: async (open: SubagentOpen) => {
      if (o.openError) throw new Error(o.openError);
      opens.push({ model: open.model, reasoning: open.reasoning, maxUsd: open.maxUsd, mode: open.policy().mode });
      const s = await sub.open({ policy: open.policy });
      return { session: s, model: open.model ?? 'm0', label: 'L' };
    },
  });
  for (let i = 0; i < 40 && run.status === 'running'; i++) await run.step();
  const snap = run.snapshot();
  return { status: run.status, pause: run.pauseReason, calls, opens, parentTexts: parent.receivedTexts, subTexts: sub.receivedTexts, events: snap.events, receipt: receipt(snap.events), counter: snap.programCounter };
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
    const served = servedKinds(mods).kinds;
    const modelPrint = NODES.get('model')!.print!;
    return JSON.parse(JSON.stringify({
      main: parsed(MAIN), bad: parsed(BAD), reason: parsed(REASON),
      runs: {
        switched: await drive('switched', {}),
        noSwitch: await drive('noSwitch', { switchTo: 'none' }),
        kept: await drive('kept', { switchTo: { to: 'kept', label: 'the default model' } }),
        stop: await drive('stop', { switchTo: { to: 'stop' } }),
        closed: await drive('closed', { switchTo: { to: 'closed' } }),
        sub: await drive('sub', { parent: turns(2), sub: [{ text: 'found it', cost: 0.06 }] }),
        subOver: await drive('subOver', { parent: turns(3), sub: [{ text: 'too dear', cost: 0.6 }] }),
        subFail: await drive('subFail', { parent: turns(2), openError: 'no session today' }),
        subLimit: await drive('subLimit', { parent: turns(2), sub: [{ text: 'too dear', cost: 0.3 }] }),
      },
      print: {
        unsupported: modelPrint.model_switched!({ step: 'model-1', model: 'x', how: 'unsupported' }),
        switched: modelPrint.model_switched!({ step: 'model-1', model: 'x', how: 'switched', label: 'L' }),
        events: Object.keys(modelPrint),
      },
      order: served.map((k) => k.kind),
      registry: [...NODES.keys()].filter((k) => ['phase', 'say', 'store', 'model', 'subagent', 'end'].includes(k)),   // the neighbours of the two; the other kinds' places are their own pins
      // the one intended difference from HEAD: the subagent view now carries the two ows templates (the row files are gone); they are asserted on their own below
      views: served.filter((k) => ['model', 'subagent'].includes(k.kind)).map(({ rows: _rows, ...rest }) => rest),
      rows: served.find((k) => k.kind === 'subagent')?.rows,
      nodes: ['model', 'subagent'].map((k) => ({ kind: k, attrs: NODES.get(k)!.attrs, sendsTurn: NODES.get(k)!.sendsTurn, owns: NODES.get(k)!.heading?.owns })),
    }));
  } finally {
    mods.dispose();
  }
}

describe('M3 Task 7: model and subagent behave exactly as when core registered them', () => {
  it('the parse, print, diagnostics, program, runs, receipts, slices, printed line and served views match the record made at HEAD', async () => {
    const actual = await record();
    if (process.env.PIN_WRITE === '1') {
      fs.writeFileSync(EXPECTED, JSON.stringify(actual, null, 1) + '\n');
      return;
    }
    const { rows, ...same } = actual;
    expect(Object.keys(rows).sort()).toEqual(['subagent_result', 'subagent_started']);
    expect(same).toEqual(JSON.parse(fs.readFileSync(EXPECTED, 'utf8')));
  }, 30_000);

  it('the recording is not empty and covers each path (a missing file or an empty pack would pass an empty comparison)', () => {
    const e = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
    expect(e.main.program.length).toBeGreaterThan(5);
    expect(e.main.diagnostics).toEqual([]);
    expect(e.bad.validate.length + e.bad.diagnostics.length).toBeGreaterThan(4);
    const types = (r: { events: Array<{ type: string }> }) => r.events.map((x) => x.type);
    expect(types(e.runs.switched)).toContain('model_switched');
    expect(e.runs.noSwitch.events.find((x: { type: string }) => x.type === 'model_switched').data.how).toBe('unsupported');
    expect(e.runs.kept.events.find((x: { type: string }) => x.type === 'model_switched').data.how).toBe('kept');
    expect(e.runs.stop.status).toBe('stopped');
    expect(e.runs.closed.status).toBe('paused');
    expect(types(e.runs.sub)).toEqual(expect.arrayContaining(['subagent_started', 'subagent_result']));
    expect(types(e.runs.subOver)).toContain('budget_warning');
    expect(e.runs.subFail.status).not.toBe('done');
    expect(e.registry.indexOf('model')).toBeLessThan(e.registry.indexOf('subagent'));
    expect(e.runs.subLimit.pause).toEqual({ type: 'usd-budget-used', limit: 0.2, spent: 0.3 });
    expect(e.runs.switched.calls).toEqual(['switch claude-x model-1', 'reasoning high model-1']);
    expect(e.runs.kept.calls).toEqual(['switch claude-x model-1']);
    expect(e.views.map((v: { kind: string }) => v.kind)).toEqual(['model', 'subagent']);
  });
});
