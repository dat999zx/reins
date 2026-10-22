// M2 task 21: the receipt gains one row per track. The events are the real ones of the toy split run on the fake engine.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { validate } from '../src/validate.js';
import { Run } from '../src/run.js';
import { receipt } from '../src/receipt.js';
import { register } from '../src/nodes/index.js';
import type { ScriptedTurn } from '../src/fake-engine.js';
import { m2harness } from './m2-harness.js';
import { split } from './fixtures/split.js';

const disposers: Array<() => void> = [];
beforeAll(() => { disposers.push(register(split)); });
afterAll(() => { for (const d of disposers.splice(0).reverse()) d(); });

const reply = (text: string, cost: number, total = cost): ScriptedTurn => ({ text: `${text}\nREINS: done`, cost, total });

/** Two tracks; track a runs a subagent after its first turn. Every reply costs something so the rows have figures. */
const BODY = '## phase pre\n> p\n\n## split\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a1\n\n## subagent research\nmodel: m1\n> Look.\n\n## end\n\n## phase b\n> b1\n\n## phase b2\n> b2\n\n## end';

async function record(body: string, scripts: Record<string, ScriptedTurn[]>) {
  const h = m2harness('R');
  for (const [id, turns] of Object.entries(scripts)) h.script(id, ...turns);
  const parsed = parseWorkflow(`---\nreins: 1\nname: t\nbudget: { turns: 40, minutes: 60 }\nalways: []\n---\n\n${body}\n`);
  expect(parsed.diagnostics).toEqual([]);
  expect(validate(parsed.workflow!).filter((d) => d.severity === 'error')).toEqual([]);
  const run = new Run({ workflow: parsed.workflow!, engine: h.engine, openSubagent: h.openSubagent, now: h.now });
  for (let k = 0; k < 60 && run.status === 'running'; k++) await run.step();
  expect(run.status).toBe('done');
  await run.close();
  return run.getEvents();
}

const SCRIPTS = {
  'R-main-1': [reply('p', 0.01), reply('m', 0.02), reply('joined', 0.04)],
  'R-sub-a': [reply('a1', 0.1)],
  'R-sub-b': [reply('b1', 0.2), reply('b2', 0.4)],
  'R-sub-subagent-1': [reply('look', 0.8)],
};

describe('receipt tracks rows', () => {
  it('has one row per track with its title, turns (its subagent\'s included), cost and whether it ended', async () => {
    const events = await record(BODY, SCRIPTS);
    const r = receipt(events);
    const started = events.filter((e) => e.type === 'track_started');
    expect(started.map((e) => e.data.track)).toEqual(['a', 'b']);
    expect(r.tracks).toEqual([
      { key: 'a', title: started[0]!.data.title, usd: 0.9, turns: 2, ended: true },
      { key: 'b', title: started[1]!.data.title, usd: 0.6, turns: 2, ended: true },
    ]);
  });

  it('the rows and the main line add up to the engine_cost total; a subagent is in its branch row and in subagents, never counted twice', async () => {
    const events = await record(BODY, SCRIPTS);
    const r = receipt(events);
    const cost = (tag: (t: unknown) => boolean) => events.filter((e) => e.type === 'engine_cost' && tag(e.data.track)).reduce((a, e) => a + Number(e.data.usd || 0), 0);
    const rows = r.tracks!.reduce((a, t) => a + t.usd, 0);
    expect(rows).toBeCloseTo(cost((t) => t !== undefined), 9);
    expect(rows + cost((t) => t === undefined)).toBeCloseTo(r.totalCostUsd, 4);
    expect(r.totalCostUsd).toBeCloseTo(1.53, 4);
    expect(r.tracks!.reduce((a, t) => a + t.turns, 0) + events.filter((e) => e.type === 'turn_ended' && e.data.track === undefined).length).toBe(r.totalTurns);
    expect(r.subagents).toEqual([expect.objectContaining({ step: 'subagent-1', usd: 0.8, turns: 1 })]);
  });

  it('a track still going is not ended', async () => {
    const events = await record(BODY, SCRIPTS);
    const cut = events.findIndex((e) => e.type === 'track_ended' && e.data.track === 'b');
    const r = receipt(events.slice(0, cut));
    expect(r.tracks!.map((t) => [t.key, t.ended])).toEqual([['a', true], ['b', false]]);
  });

  it('a run with no tracks has no tracks row and the same keys as before', async () => {
    const events = await record('## phase pre\n> p\n\n## end', { 'R-main-1': [reply('p', 0.01)] });
    const r = receipt(events);
    expect('tracks' in r).toBe(false);
    expect(Object.keys(r)).toEqual(['workflow', 'status', 'totalTurns', 'totalTimeMs', 'totalCostUsd', 'gatesHeld', 'guardRefusals', 'readOnlyRefusals',
      'totalRefusals', 'loopAttempts', 'autoCardsFired', 'liveCardsDelivered', 'verifyResults', 'knowlRecalls', 'knowlStores', 'knowlSkipped']);
  });

  it('a track key that is a name on Object.prototype is a row like any other', () => {
    const ev = (type: string, data: object, n: number) => ({ id: `e${n}`, timestamp: n, type, data }) as never;
    const r = receipt([ev('track_started', { track: '__proto__', title: 'T' }, 1), ev('engine_cost', { usd: 0.5, track: '__proto__' }, 2), ev('turn_ended', { step: 's', track: '__proto__' }, 3)]);
    expect(r.tracks).toEqual([{ key: '__proto__', title: 'T', usd: 0.5, turns: 1, ended: false }]);
  });

  it('a reply with no known cost marks its track row unknown, whether it is the turn or the call that says so', () => {
    const ev = (type: string, data: object, n: number) => ({ id: `e${n}`, timestamp: n, type, data }) as never;
    const base = [ev('track_started', { track: 'a', title: 'A' }, 1), ev('track_started', { track: 'b', title: 'B' }, 2)];
    const r = receipt([...base, ev('turn_ended', { step: 's', unknown: true, track: 'a' }, 3), ev('engine_cost', { unknown: true, step: 's', track: 'b' }, 4)]);
    expect(r.tracks).toEqual([
      { key: 'a', title: 'A', usd: 0, turns: 1, ended: false, unknown: true },
      { key: 'b', title: 'B', usd: 0, turns: 0, ended: false, unknown: true },
    ]);
  });});
