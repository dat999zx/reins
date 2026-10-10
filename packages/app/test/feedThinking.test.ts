import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import type { LogRow } from '@reins/server/store.js';
import { Feed } from '../src/FeedView.js';
import { feed } from '../src/feed.js';
import { runView, thinkingHeads, thinkingNow } from '../src/runState.js';
import { initial, mergeOutput, reduceAll } from '../src/state.js';

let seq = 0;
const row = (type: string, data?: unknown, runId = 'r1'): LogRow => ({ sessionId: 's1', seq: ++seq, ts: 1000 + seq * 1000, type, data, ...(runId ? { runId } : {}) });
const eng = (data: object, runId?: string) => row('engine', data, runId);
const think = (tokens: number) => eng({ type: 'thinking', tokens });
const head = () => { seq = 0; return [row('status', { status: 'running' }, ''), row('run_started', { workflow: 'wf', steps: [{ id: 'plan', kind: 'phase', title: 'plan' }] }), row('step_started', { step: 'plan', kind: 'phase', parents: [] })]; };

// The log as the Chat tab draws it: the same calls Chat makes, tags replaced by bars
function html(rows: LogRow[], status = 'running') {
  const s = reduceAll(initial(), [...rows, ...(status === 'running' ? [] : [row('status', { status }, '')])], 0).sessions.s1!;
  const run = runView(s);
  const f = feed(mergeOutput(s.rows), run, new Set(s.open));
  const now = thinkingNow(s.rows);
  const busy = s.status === 'running' || s.status === 'waiting';
  const thinking = { heads: thinkingHeads(s.rows), ...(busy && now ? { now: now.seq } : {}) };
  return renderToStaticMarkup(createElement(Feed, { f, sess: s, run, act: { answer: async () => {}, resume: () => {} }, thinking, open: {}, onToggle: () => {}, onBlock: () => {}, logRef: { current: null }, onScroll: () => {} }))
    .replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
}

describe('the feed while the agent thinks', () => {
  it('the live head is the indicator: one line, the Now line says it too, and no working bead beside it', () => {
    const text = html([...head(), think(50), think(317)]);
    expect(text.match(/⌁\|thinking… ~317 tokens/g)).toHaveLength(1); // one head bead, with the wave (the Now line and the strand head say it too)
    expect(text).not.toContain('~50 tokens');
    expect(text).not.toContain('working…');
    expect(text).toContain('Now: plan · running · thinking… ~317 tokens');
  });

  it('after the thinking the knot says thought, and working… comes back when only a silent row follows', () => {
    const text = html([...head(), think(50), think(317), eng({ type: 'tool_result', tool: 'Read', output: '' })]);
    expect(text).toContain('thought ~317 tokens');
    expect(text).not.toContain('thinking…');
    expect(text).toContain('working…');
  });

  it('agent text after a burst: thought, no working bead, nothing live', () => {
    const text = html([...head(), think(50), eng({ type: 'text', text: 'ONE' })]);
    expect(text).toContain('thought ~50 tokens');
    expect(text).not.toContain('working…');
    expect(text).not.toContain('thinking…');
  });

  it('a session that stopped mid-thought says thought, not thinking', () => {
    const text = html([...head(), think(50), row('run_stopped')], 'idle');
    expect(text).toContain('thought ~50 tokens');
    expect(text).not.toContain('thinking…');
  });

  it('a plain turn shows the live count too', () => {
    seq = 0;
    const text = html([row('status', { status: 'running' }, ''), row('message', { text: 'hi' }, ''), eng({ type: 'thinking', tokens: 120 }, '')]);
    expect(text).toContain('thinking… ~120 tokens');
    expect(text).not.toContain('working…');
  });
});
