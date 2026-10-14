import { describe, it, expect } from 'vitest';
import type { LogRow } from '@reins/server/store.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { drawable, hidden, renderRow, rowTypes } from '../src/rows.js';
import { engineEvents } from '../src/rows/engine.js';
import { initial, reduce } from '../src/state.js';
import { createElement } from 'react';
import { QuestionCard } from '../src/QuestionCard.js';

const row = (type: string, data: unknown = {}): LogRow => ({ sessionId: 's', seq: 1, ts: 1, type, data });
const sess = reduce(initial(), row('note'), 0).sessions.s!;
const ctx = { sess, act: { answer: async () => {}, resume: () => {} } };
const text = (n: unknown) => renderToStaticMarkup(n as never).replace(/<[^>]+>/g, '');

describe('row registry', () => {
  it('keeps generic JSON out of the summary and agent text out of live regions', () => {
    const html = renderToStaticMarkup(renderRow(row('new_event', { secret: 123 }), ctx));
    expect(html).toMatch(/<summary>new event<\/summary>/);
    expect(html).toContain('<pre>');
    expect(renderToStaticMarkup(renderRow(row('engine', { type: 'text', text: 'hello' }), ctx))).not.toContain('aria-live');
  });

  it('tools mount output lazily, show timing, and spin only in the running knot', () => {
    const r = row('engine', { type: 'tool_call', tool: 'Read', input: { path: 'file' } });
    const html = (c: typeof ctx & { running?: boolean }) => renderToStaticMarkup(renderRow(r, c));
    expect(html(ctx)).not.toContain('<pre');
    expect(html(ctx)).not.toContain('sx-spin');
    expect(html({ ...ctx, running: true })).toContain('sx-spin');
    expect(html({ ...ctx, sess: { ...sess, calls: { 1: { result: 'ok', ms: 400 } } } })).toContain('✓ 0.4 s');
    expect(html({ ...ctx, sess: { ...sess, calls: { 1: { refused: 'read-only', ms: 400 } } } })).toContain('✗ blocked');
  });

  it('output collapses behind its last nonempty line', () => {
    const html = renderToStaticMarkup(renderRow(row('command_output', { chunk: 'first\nlast\n' }), ctx));
    expect(html).toMatch(/<details[^>]*output/);
    expect(html).toContain('<summary>output · last</summary>');
  });
  it('collects one renderer per file in rows/', () => {
    for (const t of ['message', 'engine', 'question', 'receipt', 'run_started', 'say', 'step_started']) expect(rowTypes()).toContain(t);
  });

  it('draws a step start as a divider and hides command_result', () => {
    expect(JSON.stringify(renderRow(row('step_started', { step: 'plan', parents: [] }), ctx))).toMatch(/sx-stepdiv.*"step ","plan"/);
    // the say line, the notes and the chips already tell these; a generic details row would repeat them as JSON
    for (const type of ['model_switched', 'budget_reached']) expect(hidden.has(type), type).toBe(true);
    expect(hidden.has('command_result')).toBe(true);
    expect(renderRow(row('command_result', { step: 'run-1', exitCode: 1 }), ctx)).toBeNull();
  });

  it('draws a type with no file through the generic renderer, naming the type', () => {
    const el = renderRow(row('some_new_run_event', { a: 1 }), ctx) as { props: { children: unknown } };
    expect(el).not.toBeNull();
    expect(JSON.stringify(el.props)).toContain('some new run event');
  });

  it('draws nothing for hidden types', () => {
    for (const t of ['status', 'settings', 'session_created', 'answer', 'question_closed']) {
      expect(hidden.has(t)).toBe(true);
      expect(renderRow(row(t), ctx)).toBeNull();
    }
  });

  it('never lists a hidden type as a renderer file', () => {
    for (const t of hidden) expect(rowTypes()).not.toContain(t);
  });

  it('keeps hook and cost engine events hidden, and draws an unknown engine event generically', () => {
    expect(renderRow(row('engine', { type: 'hook', event: 'x', decision: 'allow' }), ctx)).toBeNull();
    expect(renderRow(row('engine', { type: 'cost', usd: 1 }), ctx)).toBeNull();
    expect(engineEvents.has('text')).toBe(true);
    expect(renderRow(row('engine', { type: 'brand_new' }), ctx)).not.toBeNull();
  });
});
describe('thinking row', () => {
  const t = (tokens: number, seq: number) => ({ ...row('engine', { type: 'thinking', tokens }), seq });
  const heads = new Set([2]);

  it('is a registered engine event; only a burst head draws', () => {
    expect(engineEvents.has('thinking')).toBe(true);
    expect(renderRow(t(50, 1), ctx)).toBeNull();
    expect(renderRow(t(50, 1), { ...ctx, thinking: { heads } })).toBeNull();
    expect(drawable(t(50, 1))).toBe(true);
  });

  it('says thinking… while it is the live head and thought after, with a grouped count', () => {
    expect(text(renderRow(t(1650, 2), { ...ctx, thinking: { heads, now: 2 } }))).toBe('⌁thinking… ~1,650 tokens');
    expect(text(renderRow(t(1509, 2), { ...ctx, thinking: { heads } }))).toBe('thought ~1,509 tokens');
    expect(text(renderRow(t(1509, 2), { ...ctx, thinking: { heads, now: 9 } }))).toBe('thought ~1,509 tokens');
  });
});
describe('drawable and card words', () => {
  it('drawable is false for every hidden type and the silent engine events, true for engine text', () => {
    for (const t of hidden) expect(drawable(row(t))).toBe(false);
    for (const t of ['tool_result', 'hook', 'cost']) expect(drawable(row('engine', { type: t }))).toBe(false);
    expect(drawable(row('engine', { type: 'text', text: 'x' }))).toBe(true);
    expect(drawable(row('note', { text: 'x' }))).toBe(true);
  });

  it('a compacted engine event says how many tokens of conversation remain, never "before → after"', () => {
    const c = (data: object) => row('engine', { type: 'compacted', trigger: 'manual', ...data });
    const r = c({ before: 33_781, after: 3_873 });
    const html = renderToStaticMarkup(renderRow(r, ctx) as never);
    expect(drawable(r)).toBe(true);
    expect(text(renderRow(r, ctx))).toBe('Compressed: 4k tokens of conversation remain; the next reply measures the full context.');
    expect(html).toContain('title="The provider&#x27;s figures: 33,781 tokens before, 3,873 after; before includes the system prompt, after does not."');
    expect(text(renderRow(c({ trigger: 'auto', before: 33_781, after: 3_873 }), ctx))).toBe(
      'Compressed: 4k tokens of conversation remain; the next reply measures the full context. (by the provider)');
    expect(text(renderRow(c({ after: 3_873 }), ctx))).toContain('Compressed: 4k tokens');
    expect(renderToStaticMarkup(renderRow(c({ after: 3_873 }), ctx) as never)).toContain(
      'title="The provider&#x27;s figure: 3,873 tokens after; it does not include the system prompt."');
    expect(text(renderRow(c({}), ctx))).toBe('Compressed.');
    expect(text(renderRow(c({ trigger: 'auto' }), ctx))).toBe('Compressed. (by the provider)');
  });

  it('a usage engine event draws nothing', () => {
    const r = row('engine', { type: 'usage', model: 'm', used: 1 });
    expect(drawable(r)).toBe(false);
    expect(renderRow(r, ctx)).toBeNull();
  });

  it('renderRow returns null exactly when drawable is false', () => {
    const rows = [row('status'), row('command_result'), row('engine', { type: 'tool_result' }), row('engine', { type: 'hook' }), row('engine', { type: 'cost' }),
      row('engine', { type: 'text', text: 'x' }), row('note', { text: 'x' }), row('some_new_run_event', {}), row('engine', { type: 'brand_new' })];
    for (const r of rows) expect(renderRow(r, ctx) === null).toBe(!drawable(r));
  });

  it('a queued card says what happened to it, and only its text without a state', () => {
    const q = row('card_queued', { card: 'x', kind: 'steer' });
    expect(text(renderRow(q, { ...ctx, card: new Map([[q.seq, { state: 'mid-turn' as const }]]) }))).toBe('steer card x · card delivered (mid-turn)');
    expect(text(renderRow(q, { ...ctx, card: new Map([[q.seq, { state: 'mid-turn' as const, landed: 'build' }]]) }))).toBe('steer card x · card delivered (mid-turn) · in build');
    expect(text(renderRow(q, ctx))).toBe('steer card x');
    expect(text(renderRow(q, { ...ctx, card: new Map([[q.seq, { state: 'bogus' as never }]]) }))).toBe('steer card x');
  });
});

describe('subagent rows and the titled card', () => {
  it('draws the start and the result of a subagent as rows of their own files, and neither is hidden', () => {
    for (const t of ['subagent_started', 'subagent_result', 'budget_warning']) {
      expect(rowTypes(), t).toContain(t);
      expect(hidden.has(t), t).toBe(false);
      expect(drawable(row(t, {})), t).toBe(true);
    }
    expect(text(renderRow(row('subagent_started', { title: 'research', label: 'Haiku 5.5' }), ctx))).toBe('Subagent research started on Haiku 5.5.');
    expect(text(renderRow(row('subagent_started', { title: 'research', resumed: true }), ctx))).toBe('Subagent research resumed on the default model.');
    expect(text(renderRow(row('subagent_started', { title: 'research', model: 'claude-haiku-5-5' }), ctx))).toBe('Subagent research started on claude-haiku-5-5.');
    expect(text(renderRow(row('subagent_started', { title: 'research', label: 'Haiku 5.5', model: 'claude-haiku-5-5' }), ctx))).toBe('Subagent research started on Haiku 5.5.');
    const html = renderToStaticMarkup(renderRow(row('subagent_result', { title: 'research', text: 'found it', cost: 0.0640898 }), ctx) as never);
    expect(html).toContain('<summary>Subagent research handed back its result ($0.0641).</summary>');
    expect(html).toContain('<pre>found it</pre>');
    expect(html).toMatch(/^<details/);
  });

  it('a budget warning draws exactly its text', () => {
    const t = 'Subagent research went over its $0.50 budget; its result was kept.';
    const r = row('budget_warning', { text: t });
    expect(drawable(r)).toBe(true);
    expect(text(renderRow(r, ctx))).toBe(t);
  });

  it('a tool card titled with its subagent names it in the card, the region and the answered line; one with no title is as before', () => {
    const q = { id: 'q1', kind: 'tool', prompt: '? Allow Bash: ls  [y / n <reason>]', title: 'Subagent research (`subagent-1`)' };
    const draw = (data: object, s = sess) => renderToStaticMarkup(createElement(QuestionCard, { row: row('question', data), sess: s, answer: async () => {} }));
    const open = draw(q);
    expect(open).toContain('<div class="qtitle">Subagent research (`subagent-1`)</div>');
    expect(open).toContain('aria-label="tool question: Subagent research (`subagent-1`)"');
    expect(text(createElement(QuestionCard, { row: row('question', q), sess: { ...sess, answers: { q1: 'y' } }, answer: async () => {} })))
      .toBe('Subagent research (`subagent-1`) · tool · answered: y');
    expect(draw(q, { ...sess, closed: { q1: 'the run stopped' } })).toContain('Subagent research (`subagent-1`) · tool · closed: the run stopped');
    const plain = draw({ id: 'q2', kind: 'tool', prompt: 'p' });
    expect(plain).not.toContain('qtitle');
    expect(plain).toContain('aria-label="tool question"');
    expect(text(createElement(QuestionCard, { row: row('question', { id: 'q2', kind: 'tool', prompt: 'p' }), sess: { ...sess, answers: { q2: 'n' } }, answer: async () => {} })))
      .toBe('tool · answered: n');
  });
});