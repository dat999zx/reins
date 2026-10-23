// M3 Task 8 (group W): the 11 conditions and the 3 cards move out of core into the default pack. This file runs them through the REAL loader (`startMods`,
// a temp home) and compares everything they do with `m3-task-w-pin.expected.json`, which was recorded at HEAD (the commit before the move, where core registered
// them): parse and print of many sources (good, malformed, nested), the judge kind, eval (sync, async, for an auto card) against fixed contexts, `sameAsRun`,
// the validator's words, the trust list of commands, the compiled turn lines, the chat tags of the cards and the served editor data.
// To record again (only ever at a commit where the answer is known to be right): `PIN_WRITE=1 npx vitest run --project server packages/server/test/m3-task-w-pin.test.ts`.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { CARDS, CONDS, FakeEngine, Run, compileProgram, condAtoms, evalCond, evalCondSync, judgeOf, parseCond, parseWorkflow, printCond, printWorkflow, validate, type Cond, type EvalCtx, type RunEventRecord, type Step, type Workflow } from '@reins/core';
import { startMods } from '../src/engines.js';
import { servedKinds } from '../src/mods/kinds-view.js';
import { tagCatalogue } from '../src/tags.js';
import { commandsOf } from '../src/trust.js';
import { tempHome } from './mods-harness.js';

const EXPECTED = new URL('./m3-task-w-pin.expected.json', import.meta.url);
const homes: Array<ReturnType<typeof tempHome>> = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });

const SOURCES = [
  'you approve', 'tests pass', '`npm run lint` passes', '`a b` passes', 'llm says "the plan is good"', "llm says 'it is'", 'llm says "a \\" quote"', 'reviewer approves', 'reviewer approves "is it safe"',
  'agent says done', 'diff > 300 lines', 'diff>5lines', 'touches migrations/**', 'touches src/*.ts', 'attempts > 3', 'attempts>12', 'same error twice', 'drift',
  'not tests pass', 'not (tests pass or drift)', 'tests pass and you approve or drift', 'tests pass and (you approve or drift)', '(tests pass or drift) and not diff > 9 lines',
  'not not you approve', '  you approve  ', 'you approve and', 'you', 'you approved', 'tests', 'tests pass extra', '`unterminated passes', '`x` pass', 'llm says', 'llm says "open',
  'reviewer approves "open', 'diff 300 lines', 'diff > lines', 'diff > 3', 'touches', 'attempts 3', 'attempts >', 'agent says', 'same error', 'drifting', 'drift and', '( drift', 'nonsense here', '', 'touches a)b',
  'agent says done or tests pass', 'attempts > 2 and same error twice and drift',
];

const ev = (type: string, data: unknown, i: number): RunEventRecord => ({ id: `e${i}`, timestamp: i, type: type as RunEventRecord['type'], data });
const calls = (n: number, tool = 'Read', input: unknown = { file_path: '/work/a.ts' }) => Array.from({ length: n }, (_, i) => ev('tool_call', { tool, input }, i));
const EVENTS: Record<string, RunEventRecord[]> = {
  none: [],
  repeated: calls(3),
  touched: [ev('tool_call', { tool: 'Edit', input: { file_path: '/work/migrations/001.sql' } }, 0), ev('tool_call', { tool: 'Read', input: { path: 'src/x.ts' } }, 1), ev('turn_ended', {}, 2)],
  stagnant: Array.from({ length: 26 }, (_, i) => ev('tool_call', { tool: 'Read', input: { n: i } }, i)),
  refused: [ev('refusal', { reason: 'edit in read-only mode' }, 0)],
  sameErr: [ev('tool_call', { tool: 'Bash', exitCode: 1, output: 'fail 12 at /a/b.ts:3' }, 0), ev('tool_call', { tool: 'Bash', exitCode: 2, output: 'fail 99 at /c/d.ts:4' }, 1)],
};
const RESULTS: Record<string, EvalCtx['commandResults']> = {
  none: [],
  testPass: [{ cmd: 'npm test', exitCode: 0, output: 'ok' }],
  lintPass: [{ cmd: 'npm run lint', exitCode: 0, output: 'ok' }],
  twoFails: [{ cmd: 'npm test', exitCode: 1, output: 'error 12 at line 7' }, { cmd: 'npm test', exitCode: 1, output: 'error 99 at line  70' }],
  failThenPass: [{ cmd: 'npm test', exitCode: 1, output: 'x' }, { cmd: 'npm test', exitCode: 0, output: 'x' }],
};
const FIXTURES: Array<[string, { events: string; results: string; text: string | undefined; total: number; atRun: boolean; judge: boolean; diff: number | undefined; testCmd: string }]> = [
  ['empty', { events: 'none', results: 'none', text: undefined, total: 0, atRun: false, judge: false, diff: undefined, testCmd: 'npm test' }],
  ['done-and-test', { events: 'touched', results: 'testPass', text: 'all fine\nREINS: done\n', total: 4, atRun: true, judge: true, diff: 500, testCmd: 'npm test' }],
  ['done-not-last', { events: 'repeated', results: 'lintPass', text: 'REINS: done\nbut more', total: 3, atRun: true, judge: true, diff: 3, testCmd: 'make' }],
  ['fails', { events: 'sameErr', results: 'twoFails', text: 'trying', total: 2, atRun: false, judge: false, diff: 300, testCmd: 'npm test' }],
  ['stagnant-refused', { events: 'stagnant', results: 'failThenPass', text: '', total: 9, atRun: true, judge: true, diff: undefined, testCmd: 'npm test' }],
  ['refused', { events: 'refused', results: 'testPass', text: 'REINS: done', total: 1, atRun: false, judge: true, diff: 301, testCmd: 'make' }],
  // the command ran last and passed, but not at a run block: the atom runs it again (the shortcut is only for the instruction that just ran it)
  ['pass-not-at-run', { events: 'none', results: 'testPass', text: 'x', total: 0, atRun: false, judge: false, diff: undefined, testCmd: 'npm test' }],
  ['lint-not-at-run', { events: 'none', results: 'lintPass', text: 'x', total: 0, atRun: false, judge: false, diff: undefined, testCmd: 'npm test' }],
  ['lint-at-run', { events: 'none', results: 'lintPass', text: 'x', total: 0, atRun: true, judge: false, diff: undefined, testCmd: 'npm test' }],
];

async function evaluate(c: Cond, fx: (typeof FIXTURES)[number][1]) {
  const ran: string[] = [];
  const judged: unknown[] = [];
  const logged: unknown[] = [];
  const ctx: EvalCtx = {
    lastTurnText: fx.text,
    commandResults: RESULTS[fx.results]!,
    runCommand: async (cmd) => { ran.push(cmd); return { exitCode: cmd === 'fail' ? 1 : 0, stdout: '', stderr: '' }; },
    loopTotal: fx.total,
    events: EVENTS[fx.events]!,
    cwd: '/work',
    testCmd: fx.testCmd,
    atRun: fx.atRun,
    ...(fx.judge ? { judge: async (cond: Cond, e: { lastText: string }) => { judged.push([cond, e]); return judged.length % 2 === 1; } } : {}),
    logEvent: (type, data) => { logged.push([type, data]); },
    ...(fx.diff === undefined ? {} : { diffLines: async () => fx.diff! }),
  };
  const sync = evalCondSync(c, ctx);
  const plain = await evalCond(c, ctx);
  const auto = await evalCond(c, ctx, true);
  return { sync, plain, auto, ran, judged, logged };
}

const head = (name: string, test?: string) => ({ version: 1 as const, name, ...(test ? { test } : {}), budget: { turns: 20, minutes: 9 }, always: [] as string[], steps: [] as Step[], autos: [] as Workflow['autos'] });
const step = (id: string, kind: string, extra: Partial<Step> = {}): Step => ({ id, kind: kind as never, attrs: {}, cards: [], links: [], ...extra });
const asCond = (src: string) => parseCond(src).cond as Cond;

function workflows(): Array<[string, Workflow]> {
  const gates = ['you approve', 'tests pass', '`npm run lint` passes', 'llm says "ok"', 'reviewer approves "safe"', 'agent says done', 'diff > 10 lines', 'touches src/**', 'attempts > 2', 'same error twice', 'drift', 'tests pass and llm says "x"', 'touches [bad'];
  const cards = [['guard', 'migrations/**'], ['guard', 'src/[bad'], ['guard', 'a/b.ts'], ['now', 'look again'], ['stop', 'ask me'], ['nope', 'unknown card']] as const;
  return [
    ['gates', { ...head('gates'), steps: gates.map((g, i) => step(`g${i}`, 'gate', { cond: asCond(g) })) }],
    ['gates-with-test', { ...head('gates-test', 'make check'), steps: [step('a', 'gate', { cond: asCond('tests pass') })] }],
    ['cards', { ...head('cards'), steps: cards.map(([k, t], i) => step(`p${i}`, 'phase', { title: `p${i}`, prompt: 'work', cards: [{ kind: k as never, text: t }] })) }],
    ['autos', {
      ...head('autos'),
      autos: [
        { id: 'a1', cond: asCond('drift or same error twice'), card: { kind: 'now' as never, text: 'read the output' } },
        { id: 'a2', cond: asCond('attempts > 4 and llm says "stuck"'), card: { kind: 'stop' as never, text: 'ask the user' } },
        { id: 'a3', cond: asCond('touches db/** and diff > 5 lines'), card: { kind: 'guard' as never, text: 'db/**' } },
        { id: 'a4', cond: asCond('touches [oops'), card: { kind: 'now' as never, text: 'x' } },
      ],
    }],
    ['nested', { ...head('nested'), steps: [step('r', 'repeat', { cond: asCond('tests pass or attempts > 3'), attrs: { max: '4' }, kids: [step('k', 'phase', { title: 'k', prompt: 'p', cards: [{ kind: 'guard' as never, text: 'x/**' }] })] }), step('i', 'if', { cond: asCond('not (drift or you approve)'), kids: [step('s', 'say', { prompt: 'hi' })], else: [step('t', 'say', { prompt: 'no' })] })] }],
  ];
}

/** A run on a fake engine: the texts the agent was sent (the cards' turn lines are in them), the events, and where it stopped. */
async function drive(w: Workflow, turns: string[]) {
  const engine = new FakeEngine(turns.map((text) => ({ text, cost: 0.01 })));
  let t = 0;
  const run = new Run({ workflow: w, engine, now: () => (t += 1000), commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
  for (let i = 0; i < 30 && run.status === 'running'; i++) await run.step();
  const snap = run.snapshot();
  return { status: run.status, texts: engine.receivedTexts, events: snap.events.map((e) => [e.type, e.data]), counter: snap.programCounter };
}

async function record() {
  const h = tempHome();
  homes.push(h);
  const mods = await startMods({ dir: h.home, env: {} });
  try {
    const cmds = ['', 'npm test', 'npm run lint', 'x'];
    const bySource = SOURCES.map((src) => {
      const r = parseCond(src);
      return { src, r, printed: r.cond ? printCond(r.cond) : undefined, again: r.cond ? parseCond(printCond(r.cond)) : undefined, judge: r.cond ? judgeOf(r.cond) : undefined, atoms: r.cond ? condAtoms(r.cond) : undefined };
    });
    const evals: Record<string, unknown> = {};
    for (const src of SOURCES) {
      const c = parseCond(src).cond;
      if (!c) continue;
      evals[src] = Object.fromEntries(await Promise.all(FIXTURES.map(async ([name, fx]) => [name, await evaluate(c, fx)] as const)));
    }
    const atoms = [...CONDS.values()];
    const wfs = workflows();
    const served = servedKinds(mods);
    return JSON.parse(JSON.stringify({
      condOrder: [...CONDS.keys()],
      cardOrder: [...CARDS.keys()],
      shapes: atoms.map((a) => ({ t: a.t, judge: a.judge, auto: a.auto, modelCall: a.modelCall, needsTestCmd: a.needsTestCmd, hasEvalSync: !!a.evalSync, hasEvaluate: !!a.evaluate, hasGlobs: !!a.globs, hasCommands: !!a.commands, hasSameAsRun: !!a.sameAsRun })),
      cardShapes: [...CARDS.values()].map((c) => ({ kind: c.kind, delivery: c.delivery, hasTurnLine: !!c.turnLine, hasPolicy: !!c.policy, hasValidate: !!c.validate })),
      bySource, evals,
      sameAsRun: atoms.map((a) => [a.t, cmds.map((cmd) => (a.sameAsRun ? a.sameAsRun(asCond(a.t === 'cmd' ? '`npm run lint` passes' : a.t === 'tests' ? 'tests pass' : a.t) as never, cmd) : null))]),
      globs: atoms.map((a) => [a.t, a.globs ? a.globs(asCond(a.t === 'touches' ? 'touches a/**' : a.t) as never) : null]),
      workflows: wfs.map(([name, w]) => {
        const text = printWorkflow(w);
        const back = parseWorkflow(text);
        return { name, text, diagnostics: back.diagnostics, validate: validate(w), validateParsed: back.workflow ? validate(back.workflow) : undefined, printedAgain: back.workflow ? printWorkflow(back.workflow) : undefined, program: compileProgram(w), commands: commandsOf(w, () => undefined) };
      }),
      runs: {
        guards: await drive(wfs[2]![1], ['a\nREINS: done', 'b\nREINS: done', 'c\nREINS: done', 'd', 'e', 'f']),
        autoNow: await drive({ ...head('auto-now'), steps: [step('p', 'phase', { title: 'p', prompt: 'work' }), step('q', 'phase', { title: 'q', prompt: 'more' })], autos: [{ id: 'a1', cond: asCond('agent says done'), card: { kind: 'now' as never, text: 'hold on a moment' } }] }, ['one\nREINS: done', 'two', 'three']),
        autoStop: await drive({ ...head('auto-stop'), steps: [step('p', 'phase', { title: 'p', prompt: 'work' }), step('q', 'phase', { title: 'q', prompt: 'more' })], autos: [{ id: 'a1', cond: asCond('agent says done'), card: { kind: 'stop' as never, text: 'check with me' } }] }, ['one\nREINS: done', 'two', 'three']),
        gateTests: await drive({ ...head('gate-tests'), steps: [step('p', 'phase', { title: 'p', prompt: 'work' }), step('g', 'gate', { cond: asCond('tests pass') }), step('r', 'run', { attrs: { cmd: 'npm test' } }), step('g2', 'gate', { cond: asCond('`npm test` passes') })] }, ['one', 'two']),
      },
      tagCatalogue: tagCatalogue().filter((t) => t.place === 'card'),
      conds: served.conds,
      cards: served.cards,
      problems: served.problems,
    }));
  } finally {
    mods.dispose();
  }
}

describe('M3 Task 8 (W): the conditions and cards behave exactly as when core registered them', () => {
  it('parse, print, eval, validation, trust commands, turn lines, tags and served editor data match the record made at HEAD', async () => {
    const actual = await record();
    if (process.env.PIN_WRITE === '1') {
      fs.writeFileSync(EXPECTED, JSON.stringify(actual, null, 1) + '\n');
      return;
    }
    expect(actual).toEqual(JSON.parse(fs.readFileSync(EXPECTED, 'utf8')));
  }, 60_000);

  it('the recording is not empty (a missing file or an empty pack would pass an empty comparison)', () => {
    const e = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
    expect(e.condOrder).toEqual(['approve', 'tests', 'cmd', 'llm', 'review', 'done', 'diff', 'touches', 'attempts', 'same', 'drift']);
    expect(e.cardOrder).toEqual(['guard', 'now', 'stop']);
    expect(e.bySource.filter((s: { r: { cond?: unknown } }) => s.r.cond).length).toBeGreaterThan(25);
    expect(e.bySource.filter((s: { r: { diag?: unknown } }) => s.r.diag).length).toBeGreaterThan(15);
    expect(e.conds.map((c: { t: string }) => c.t)).toEqual(e.condOrder);
    expect(e.cards.map((c: { kind: string }) => c.kind)).toEqual(['guard']);
    expect(e.workflows.length).toBe(5);
    expect(e.workflows[0].validate.length).toBeGreaterThan(3);
    expect(JSON.stringify(e.evals)).toContain('"sync":true');
    expect(e.sameAsRun.filter((r: [string, unknown[]]) => r[1][0] !== null).map((r: [string]) => r[0])).toEqual(['tests', 'cmd']);
  });
});
