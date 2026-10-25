// M3 fix D, item 6: core names no block. What used to be written in viewShape.ts (`CAP = 'end'`, `EVENT_ROW_KIND` naming `subagent`) and parse.ts (a failed
// `whenever` defaulted to the `drift` atom) is now data: the pack manifests say `stops` and `coreRows`, the server lets only a pack block say them, and a
// failed `whenever` holds an atom no mod registers. Hostile cases first: a view that is not a pack block's gets none of it, whatever its kind is called.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evalCond, mayRow, parseWorkflow, printWorkflow, viewShapeProblem } from '../src/index.js';

const modsDir = fileURLToPath(new URL('../../server/src/mods/', import.meta.url));
const view = (over: Record<string, unknown> = {}) => ({ kind: 'zz', order: 1, colour: 'soft', fields: [], line: ['zz'], ...over });
const MOD = { attrs: [], events: [] };
const PACK = { mod: { ...MOD, pack: true as const } };
const USER = { mod: MOD };

describe('stops', () => {
  it('a mod that is not a pack block cannot stop the workflow, even a block called end', () => {
    for (const kind of ['end', 'zz', 'finish']) expect(viewShapeProblem(view({ kind, stops: true }), USER), kind).toMatch(/view\.stops/);
  });
  it('a pack block may, whatever its kind is called: the name is not in core', () => {
    expect(viewShapeProblem(view({ stops: true }), PACK)).toBeUndefined();
    expect(viewShapeProblem(view({ kind: 'end', stops: true }), PACK)).toBeUndefined();
    expect(viewShapeProblem(view({ stops: false }), PACK)).toMatch(/view\.stops/);
  });
  it('what the app is served has passed the server\'s check, so the app asks only for the shape; there is no `pack` mark to claim', () => {
    expect(viewShapeProblem(view({ kind: 'end', stops: true }), { served: true })).toBeUndefined();
    expect(viewShapeProblem(view({ stops: 1 }), { served: true })).toMatch(/view\.stops/);
    for (const scope of [USER, PACK, { served: true as const }]) expect(viewShapeProblem(view({ pack: true }), scope)).toMatch(/not part of a view/);
  });
  it('the end mod says stops in its own view', () => {
    const end = JSON.parse(fs.readFileSync(`${modsDir}end/mod.json`, 'utf8')) as { view: { stops?: true } };
    expect(end.view.stops).toBe(true);
  });
});

describe('coreRows: a pack block draws the row of an event core logs only for the events its own view lists', () => {
  const rows = (type: string) => ({ rows: { [type]: { text: 'x' } } });
  it('a user mod cannot list one, and cannot cover one without it', () => {
    expect(viewShapeProblem(view({ coreRows: ['subagent_started'], ...rows('subagent_started') }), { mod: { ...MOD, events: [] } })).toMatch(/view\.coreRows/);
    expect(viewShapeProblem(view({ kind: 'subagent', ...rows('subagent_started') }), USER)).toMatch(/event core logs/);
  });
  it('a pack block that does not list the event cannot cover it, whatever its kind is called', () => {
    expect(viewShapeProblem(view({ kind: 'subagent', ...rows('subagent_started') }), PACK)).toMatch(/event core logs/);
    expect(viewShapeProblem(view({ coreRows: ['subagent_result'], ...rows('subagent_started') }), PACK)).toMatch(/event core logs/);
    expect(viewShapeProblem(view({ coreRows: ['subagent_started'], ...rows('turn_ended') }), PACK)).toMatch(/event core logs/);
  });
  it('a pack block that lists it may, and the list holds events core logs and nothing else', () => {
    expect(viewShapeProblem(view({ kind: 'other', coreRows: ['subagent_started'], ...rows('subagent_started') }), PACK)).toBeUndefined();
    expect(viewShapeProblem(view({ coreRows: ['not_a_core_event'] }), PACK)).toMatch(/view\.coreRows/);
    expect(viewShapeProblem(view({ coreRows: 'subagent_started' }), PACK)).toMatch(/view\.coreRows/);
    expect(viewShapeProblem(view({ coreRows: ['__proto__'] }), PACK)).toMatch(/view\.coreRows/);
    const nine = ['run_started', 'run_paused', 'run_resumed', 'run_stopped', 'run_finished', 'turn_started', 'turn_ended', 'step_started', 'command_result'];
    expect(viewShapeProblem(view({ coreRows: nine.slice(0, 8) }), PACK)).toBeUndefined();
    expect(viewShapeProblem(view({ coreRows: nine }), PACK)).toMatch(/view\.coreRows/);
  });
  it('the app is served the same row rule: a core event needs the view\'s own coreRows', () => {
    const v = view({ coreRows: ['subagent_started'], ...rows('subagent_started') });
    expect(viewShapeProblem(v, { served: true })).toBeUndefined();
    expect(viewShapeProblem(view({ ...rows('subagent_started') }), { served: true })).toMatch(/event core logs/);
    expect(viewShapeProblem(view({ ...rows('turn_ended') }), { served: true })).toMatch(/event core logs/);
  });
  it('mayRow: any non-core event; a core event only for a view that lists it', () => {
    expect(mayRow('anything', {})).toBe(true);
    expect(mayRow('subagent_started', { coreRows: ['subagent_started'] })).toBe(true);
    expect(mayRow('subagent_started', { coreRows: ['subagent_result'] })).toBe(false);
    expect(mayRow('subagent_started', {})).toBe(false);
    expect(mayRow('turn_ended', { coreRows: ['subagent_started'] })).toBe(false);
    for (const t of ['constructor', 'toString', '__proto__']) expect(mayRow(t, {}), t).toBe(true);
  });
  it('the subagent mod lists its own two events in its view', () => {
    const sub = JSON.parse(fs.readFileSync(`${modsDir}subagent/mod.json`, 'utf8')) as { view: { coreRows?: string[]; rows: Record<string, unknown> } };
    expect(sub.view.coreRows).toEqual(['subagent_started', 'subagent_result']);
    const own = { attrs: ['model', 'reasoning', 'usd', 'mode'], events: [] };
    expect(viewShapeProblem(sub.view, { mod: { ...own, pack: true } })).toBeUndefined();
    expect(viewShapeProblem(sub.view, { mod: own })).toMatch(/view\.coreRows/);
  });
});

describe('a whenever that does not parse', () => {
  const FM = '---\nreins: 1\nname: t\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n';
  const text = `${FM}## whenever not a real condition\nnow: look\n`;
  it('is an error, and its auto holds no atom any mod could register', () => {
    const p = parseWorkflow(text);
    expect(p.diagnostics.some((d) => d.severity === 'error')).toBe(true);
    expect(p.workflow!.autos).toHaveLength(1);
    expect(p.workflow!.autos[0]!.cond.t).not.toBe('drift');
    expect(p.workflow!.autos[0]!.cond.t).toBe('unparsed');
  });
  it('never fires, and printing it does not rewrite it into another condition', async () => {
    const p = parseWorkflow(text);
    expect(await evalCond(p.workflow!.autos[0]!.cond, {} as never, true)).toBe(false);
    expect(printWorkflow(p.workflow!)).not.toContain('drift');
    expect(printWorkflow(p.workflow!)).not.toContain('undefined');
  });
});
