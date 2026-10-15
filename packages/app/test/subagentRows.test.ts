import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import type { LogRow } from '@reins/server/store.js';
import { Feed } from '../src/FeedView.js';
import { feed } from '../src/feed.js';
import { runView, thinkingHeads } from '../src/runState.js';
import { initial, mergeOutput, reduce, reduceAll } from '../src/state.js';
import { hasReplied, usageOf } from '../src/usage.js';

let seq = 0;
const row = (type: string, data?: unknown, runId = 'r1'): LogRow => ({ sessionId: 's1', seq: ++seq, ts: 1000 + seq * 1000, type, data, ...(runId ? { runId } : {}) });
const eng = (data: object, runId?: string) => row('engine', data, runId);
const sub = (data: object) => eng({ ...data, step: 'subagent-1' });

/** A parent reply, then a run whose subagent thinks, reads a file and answers, then a phase. */
function log(withStep = true) {
  seq = 0;
  const s = (d: object) => (withStep ? sub(d) : eng(d));
  return [
    row('status', { status: 'running' }, ''),
    eng({ type: 'usage', model: 'm', used: 1000 }, ''),
    row('run_started', { workflow: 'wf', steps: [{ id: 'subagent-1', kind: 'subagent', title: 'research' }, { id: 'phase-2', kind: 'phase', title: 'use' }] }),
    row('step_started', { step: 'subagent-1', kind: 'subagent', parents: [] }),
    row('subagent_started', { step: 'subagent-1', title: 'research' }),
    s({ type: 'thinking', tokens: 50, text: 'because' }),
    s({ type: 'tool_call', tool: 'Read', input: { path: 'a' } }),
    s({ type: 'tool_result', tool: 'Read', output: 'body' }),
    s({ type: 'text', text: 'found it' }),
    row('turn_ended', { step: 'subagent-1', cost: 0.06 }),
    row('step_started', { step: 'phase-2', kind: 'phase', parents: [] }),
  ];
}

describe("a subagent's rows in the feed", () => {
  it("land in its knot: its tools count there, nothing else does; the text, reasoning and tool draw when the knot is open", () => {
    const s = reduceAll(initial(), log(), 0).sessions.s1!;
    const run = runView(s);
    const f = feed(mergeOutput(s.rows), run, new Set());
    const knots = f.pieces.flatMap((p) => (p.type === 'run' ? p.items.flatMap((i) => ('knot' in i ? [i.knot] : [])) : []));
    const k = knots.find((x) => x.step === 'subagent-1')!;
    expect(k.beads.filter((r) => r.type === 'engine').map((r) => (r.data as { type: string }).type)).toEqual(['thinking', 'tool_call', 'text']);   // the silent tool_result is not a bead
    expect(k.tools).toEqual({ count: 1, one: 'Read' });
    expect(knots.find((x) => x.step === 'phase-2')!.tools.count).toBe(0);
    const open = Object.fromEntries(knots.map((x) => [x.key, true]));
    const html = renderToStaticMarkup(createElement(Feed, { f, sess: s, run, act: { answer: async () => {}, resume: () => {} }, thinking: { heads: thinkingHeads(s.rows) }, open, onToggle: () => {}, onBlock: () => {}, logRef: { current: null }, onScroll: () => {} }));
    expect(html).toContain('<div class="msg agent txt"><div class="md"><p>found it</p></div></div>');
    expect(html).toContain('Reasoning ~50 tokens');
    expect(html).toContain('because');
    expect(html).toContain('<b>Read</b>');
  });

  it("do not move the parent's context figure or the run's last reply", () => {
    const s = reduceAll(initial(), log(), 0).sessions.s1!;
    expect(usageOf(s.rows)).toMatchObject({ used: 1000, stale: false });
    expect(runView(s).last).toBeUndefined();
    expect(hasReplied(log().concat(row('engine', { type: 'error', message: 'x', step: 'subagent-1' }), row('turn_ended', {}, '')))).toBe(true);
  });

  it('an old log without a step reads as it did: the figure is stale after any later engine row', () => {
    const s = reduceAll(initial(), log(false), 0).sessions.s1!;
    expect(usageOf(s.rows)).toMatchObject({ used: 1000, stale: true });
    expect(runView(s).last?.text).toBe('found it');
  });

  it('a Sess built from stored rows alone is the one built row by row, tool result and all', () => {
    const rows = log();
    let live = initial();
    for (const r of rows) live = reduce(live, r, 0);
    const loaded = reduceAll(initial(), rows, 0);
    expect(loaded.sessions.s1).toEqual(live.sessions.s1);
    const call = rows.find((r) => r.type === 'engine' && (r.data as { type: string }).type === 'tool_call')!;
    expect(loaded.sessions.s1!.calls[call.seq]).toMatchObject({ result: 'body' });
  });
});
