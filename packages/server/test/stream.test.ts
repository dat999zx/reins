// Replays every recorded claude stream from Phase 0 through the parser (plan 15b 2.3).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { EngineEvent } from '@reins/core';
import { createStreamParser, type StreamOut } from '../src/claude/stream.js';

const FIX = path.resolve(__dirname, '../../../spike/fixtures');
const fixtures = fs.readdirSync(FIX).filter((f) => f.startsWith('claude-') && f.endsWith('.jsonl'));

function replay(name: string) {
  const lines = fs.readFileSync(path.join(FIX, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const parse = createStreamParser();
  const outs: StreamOut[] = lines.map((m) => parse(m));
  const seq: string[] = [];
  for (const o of outs) {
    for (const e of o.events) {
      if (e.type === 'thinking') continue; // the count is tested on its own below; these sequences are about tools, text and results
      if (e.type === 'tool_call' || e.type === 'tool_result') seq.push(`${e.type}:${e.tool}`);
      else seq.push(e.type);
    }
    if (o.result) seq.push(o.result.isError ? 'result:error' : 'result');
  }
  return { lines, outs, seq, events: outs.flatMap((o) => o.events), results: outs.flatMap((o) => (o.result ? [o.result] : [])) };
}

describe('stream parser on every recorded fixture', () => {
  it('finds the fixtures', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(13);
  });

  for (const f of fixtures) {
    it(`${f}: one session id, a refusal per hook denial, a result per result line`, () => {
      const r = replay(f);
      const init = r.lines.find((m) => m.type === 'system' && m.subtype === 'init');
      const ids = r.outs.flatMap((o) => (o.sessionId ? [o.sessionId] : []));
      // Only the first system/init names the session; later ones (every turn, after an interrupt) are ignored.
      expect(ids).toEqual([init.session_id]);
      const hookDenials = r.lines.filter((m) => m.type === 'user' && JSON.stringify(m.message?.content ?? '').includes('hook error:')).length;
      expect(r.events.filter((e) => e.type === 'refusal')).toHaveLength(hookDenials);
      expect(r.results).toHaveLength(r.lines.filter((m) => m.type === 'result').length);
      const toolUses = r.lines.flatMap((m) => (m.type === 'assistant' ? m.message.content : [])).filter((b: any) => b.type === 'tool_use').length;
      expect(r.events.filter((e) => e.type === 'tool_call')).toHaveLength(toolUses);
    });
  }

  it('hook-deny: the guard refusal carries the reason Reins wrote, without the CLI prefix', () => {
    const r = replay('claude-2.1.281-hook-deny.jsonl');
    expect(r.seq).toEqual(['tool_call:Read', 'tool_result:Read', 'tool_call:Edit', 'refusal', 'text', 'result']);
    const refusal = r.events.find((e) => e.type === 'refusal') as { reason: string };
    expect(refusal.reason).toBe('Blocked by Reins: migrations/** is guarded.');
    const call = r.events.find((e) => e.type === 'tool_call' && e.tool === 'Edit') as { input: any };
    expect(call.input.file_path).toBe('D:\\coding\\reins-scratch\\migrations\\0001.sql');
    expect(r.results[0]!.totalCostUsd).toBeCloseTo(0.0928422);
  });

  it('turns: three turns, final text from the result, cumulative cost', () => {
    const r = replay('claude-2.1.281-turns.jsonl');
    expect(r.seq).toEqual(['text', 'result', 'text', 'result', 'text', 'result']);
    expect(r.results.map((x) => x.text)).toEqual(['ONE', 'TWO', 'THREE']);
    expect(r.results.map((x) => x.totalCostUsd)).toEqual([0.0640898, 0.0802364, 0.0871622]);
  });

  it('interrupt-ctl: the interrupted turn ends in an error result, and the session goes on', () => {
    const r = replay('claude-2.1.281-interrupt-ctl.jsonl');
    expect(r.seq).toEqual(['tool_call:PowerShell', 'tool_result:PowerShell', 'result:error', 'text', 'result']);
    expect(r.results[0]!.text).toBe('');
    expect(r.results[1]!.text).toBe('AFTER');
  });

  it('approval-deny: a denied approval is a tool result, not a hook refusal', () => {
    const r = replay('claude-2.1.281-approval-deny.jsonl');
    expect(r.seq).toEqual(['tool_call:Read', 'tool_result:Read', 'tool_call:Edit', 'tool_result:Edit', 'text', 'result']);
  });

  it('card: parallel tool calls keep their names on the results', () => {
    const r = replay('claude-2.1.281-card.jsonl');
    expect(r.seq.slice(0, 5)).toEqual(['text', 'tool_call:Glob', 'tool_call:Glob', 'tool_result:Glob', 'tool_result:Glob']);
  });

  it('sigint: a stream cut off mid-turn has no result', () => {
    const r = replay('claude-2.1.281-sigint.jsonl');
    expect(r.seq).toEqual(['tool_call:PowerShell']);
  });
});

describe('usage', () => {
  const init = (model: string) => ({ type: 'system', subtype: 'init', session_id: 's', model });
  const a = (model: string, u: Record<string, unknown>, parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { model, content: [], usage: u } });
  const res = (extra: Record<string, unknown> = {}) => ({ type: 'result', result: 'x', total_cost_usd: 0.1, is_error: false, ...extra });
  const run = (ms: unknown[], o?: Parameters<typeof createStreamParser>[0]) => {
    const parse = createStreamParser(o);
    return ms.map((m) => parse(m)).find((x) => x.result)!.result!;
  };
  const four = { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 };

  it('turns.jsonl: the parent context after turn 0, with the window from modelUsage', () => {
    expect(replay('claude-2.1.281-turns.jsonl').results[0]!.usage).toEqual({ model: 'claude-sonnet-5', used: 30550, window: 1000000 });
  });

  it('every fixture result that is not an error carries a usage with a model and tokens', () => {
    for (const f of fixtures.filter((x) => !x.endsWith('-compact.jsonl'))) {
      const r = replay(f);
      for (const x of r.results.filter((y) => !y.isError)) {
        expect(x.usage, f).toBeDefined();
        expect(x.usage!.model, f).not.toBe('');
        expect(x.usage!.used, f).toBeGreaterThan(0);
      }
    }
  });

  it('interrupt-ctl: the interrupted (error) result has no usage; the next one has', () => {
    const r = replay('claude-2.1.281-interrupt-ctl.jsonl');
    expect(r.results[0]!.usage).toBeUndefined();
    expect(r.results[1]!.usage).toBeDefined();
  });

  it('window falls back to the table; modelUsage wins; no table, no window key', () => {
    expect(run([init('m'), a('m', four), res()], { windows: { m: 500 } }).usage).toEqual({ model: 'm', used: 10, window: 500 });
    expect(run([init('m'), a('m', four), res()]).usage).toEqual({ model: 'm', used: 10 });
    expect('window' in run([init('m'), a('m', four), res()]).usage!).toBe(false);
    expect(run([init('m'), a('m', four), res({ modelUsage: { m: { contextWindow: 900 } } })], { windows: { m: 500 } }).usage).toEqual({ model: 'm', used: 10, window: 900 });
  });

  it('a sidechain line never counts: the parent line does', () => {
    const r = run([init('m'), a('m', four), a('sub', { ...four, input_tokens: 999_999 }, 'toolu_1'), res()]);
    expect(r.usage).toEqual({ model: 'm', used: 10 });
  });

  it('a tool-heavy turn counts its last parent message', () => {
    const g = (n: number) => ({ ...four, input_tokens: n });
    expect(run([init('m'), a('m', g(10)), a('m', g(20)), a('m', g(30)), res()]).usage!.used).toBe(30 + 2 + 3 + 4);
  });

  it('malformed token fields give no usage; a malformed window gives usage without one', () => {
    for (const bad of ['7', -1, 1.5, NaN, undefined]) {
      expect(run([init('m'), a('m', { ...four, cache_read_input_tokens: bad }), res()]).usage).toBeUndefined();
    }
    const noField: Record<string, unknown> = { ...four };
    delete noField.output_tokens;
    expect(run([init('m'), a('m', noField), res()]).usage).toBeUndefined();
    for (const w of [0, -5, 1.5, '1e6']) {
      expect(run([init('m'), a('m', four), res({ modelUsage: { m: { contextWindow: w } } })]).usage).toEqual({ model: 'm', used: 10 });
    }
  });

  it('a failed turn has no usage', () => {
    expect(run([init('m'), a('m', four), res({ is_error: true })]).usage).toBeUndefined();
  });

  it('the model is the last parent message model, else the init model', () => {
    expect(run([init('i'), a('m', four), res()]).usage!.model).toBe('m');
    expect(run([init('i'), { type: 'assistant', parent_tool_use_id: null, message: { content: [], usage: four } }, res()]).usage!.model).toBe('i');
  });

  it('a result resets what was kept: a result with no assistant line has no usage', () => {
    const parse = createStreamParser();
    parse(init('m'));
    parse(a('m', four));
    expect(parse(res()).result!.usage).toBeDefined();
    expect(parse(res()).result!.usage).toBeUndefined();
  });
});

describe('byModel (cost per model, C)', () => {
  const res = (modelUsage?: unknown) => ({ type: 'result', result: 'x', total_cost_usd: 0.1, is_error: false, ...(modelUsage === undefined ? {} : { modelUsage }) });
  const by = (modelUsage?: unknown) => createStreamParser()(res(modelUsage)).result!.byModel;

  it('turns.jsonl: each result carries its model figure, equal to the total of a one-model session', () => {
    const r = replay('claude-2.1.281-turns.jsonl');
    expect(r.results.map((x) => x.byModel)).toEqual([{ 'claude-sonnet-5': 0.0640898 }, { 'claude-sonnet-5': 0.0802364 }, { 'claude-sonnet-5': 0.0871622 }]);
  });

  it('the compact fixture: three results, figures 0.0068948, 0.00962756, 0.01168894', () => {
    const r = replay('claude-2.1.293-compact.jsonl');
    expect(r.results.map((x) => Object.values(x.byModel!)[0])).toEqual([0.0068948, 0.00962756, 0.01168894]);
  });

  it('two-models.jsonl (real CLI, M8): both models, and the parts sum to the total', () => {
    const r = replay('claude-2.1.293-two-models.jsonl');
    const last = r.results.at(-1)!;
    expect(last.byModel).toEqual({ 'claude-haiku-5-5': 0.01128855, 'claude-sonnet-5-5': 0.154664 });
    expect(last.totalCostUsd).toBeCloseTo(0.16595255, 9);
    expect(Object.values(last.byModel!).reduce((a, b) => a + b, 0)).toBeCloseTo(last.totalCostUsd, 9);
  });

  it('a figure that is not a finite number >= 0 drops the whole split; none at all is none', () => {
    expect(by({ a: { costUSD: 0.5 } })).toEqual({ a: 0.5 });
    expect(by({ a: { costUSD: 0.5 }, b: { costUSD: 0 } })).toEqual({ a: 0.5, b: 0 });
    for (const bad of ['1', -1, NaN, null, undefined]) expect(by({ a: { costUSD: 0.5 }, b: { costUSD: bad } })).toBeUndefined();
    // JSON has no Infinity, but 1e999 parses to it: it must not reach a running total
    const huge = JSON.parse('{"a":{"costUSD":0.5},"b":{"costUSD":1e999}}');
    expect(by(huge)).toBeUndefined();
    expect(by({})).toBeUndefined();
    expect(by(undefined)).toBeUndefined();
    expect(by('x')).toBeUndefined();
  });
});

describe('compacted', () => {
  const init = { type: 'system', subtype: 'init', session_id: 's', model: 'm' };
  const boundary = (meta: Record<string, unknown>) => ({ type: 'system', subtype: 'compact_boundary', compact_metadata: meta });
  const asst = { type: 'assistant', parent_tool_use_id: null, message: { model: 'm', content: [], usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 } } };
  const res = { type: 'result', result: '', total_cost_usd: 0.1, is_error: false };
  const feed = (...ms: unknown[]) => { const parse = createStreamParser(); const outs = ms.map((m) => parse(m)); return { events: outs.flatMap((o) => o.events), result: outs.find((o) => o.result)!.result! }; };

  it('the recorded /compact turn: one compacted event with the provider figures, no usage; the next turn is measured', () => {
    const r = replay('claude-2.1.293-compact.jsonl');
    expect(r.events.filter((e) => e.type === 'compacted')).toEqual([{ type: 'compacted', trigger: 'manual', before: 34469, after: 4795 }]);
    // the replayed summary lines are not drawn: the whole fixture holds only the two answers' texts
    expect(r.events.map((e) => e.type)).toEqual(['text', 'compacted', 'thinking', 'text']);
    expect(r.results).toHaveLength(3);
    expect(r.results[1]!.usage).toBeUndefined();
    expect(r.results[1]!.isError).toBe(false);
    expect(r.results[2]!.usage).toBeDefined();
  });

  it('a usage seen before the boundary is dropped; one seen after it is kept', () => {
    expect(feed(init, asst, boundary({ trigger: 'auto', pre_tokens: 9, post_tokens: 2 }), res).result.usage).toBeUndefined();
    expect(feed(init, boundary({ trigger: 'auto', pre_tokens: 9, post_tokens: 2 }), asst, res).result.usage).toEqual({ model: 'm', used: 10 });
  });

  it('a figure that is not a count is left out; no trigger is unknown; auto is kept', () => {
    const e = feed(init, boundary({ pre_tokens: '9', post_tokens: -1 }), res).events[0]!;
    expect(e).toEqual({ type: 'compacted', trigger: 'unknown' });
    expect('before' in e || 'after' in e).toBe(false);
    expect(feed(init, boundary({ trigger: 'auto', pre_tokens: 9, post_tokens: 2 }), res).events[0]).toEqual({ type: 'compacted', trigger: 'auto', before: 9, after: 2 });
  });
});

describe('thinking tokens', () => {
  const tokens = (events: EngineEvent[]) => events.flatMap((e) => (e.type === 'thinking' ? [e.tokens] : []));
  const line = (e: number) => ({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: e, estimated_tokens_delta: e });
  const feed = (...ms: unknown[]) => { const parse = createStreamParser(); return ms.flatMap((m) => parse(m).events); };
  const block = (b: unknown) => ({ type: 'assistant', message: { content: [b] } });

  it('the derived fixture: one event per burst start, all before the text, none for the empty blocks', () => {
    const r = replay('claude-2.1.281-turns-thinking.jsonl');
    expect(tokens(r.events)).toEqual([50, 317, 575, 844, 1121, 1509]);
    expect(r.events.map((e) => e.type)).toEqual(['thinking', 'thinking', 'thinking', 'thinking', 'thinking', 'thinking', 'text']);
    expect(r.results).toHaveLength(1);
  });

  it('card-marker-hook: a tool call, one thinking 50, then the text', () => {
    const r = replay('claude-2.1.281-card-marker-hook.jsonl');
    const types = r.events.map((e) => e.type);
    const i = types.indexOf('thinking');
    expect(types.slice(i - 2, i + 2)).toEqual(['tool_call', 'tool_result', 'thinking', 'text']);
    expect(tokens(r.events)).toEqual([50]);
  });

  it('one long burst emits its start and each further 1,000 tokens', () => {
    const lines = Array.from({ length: 21 }, (_, i) => line(50 + i * 100));
    expect(tokens(feed(...lines))).toEqual([50, 1050, 2050]);
  });

  it('a result line resets the count: the next turn starts at its own first estimate', () => {
    const parse = createStreamParser();
    const first = [line(50), line(900), line(40)].flatMap((m) => parse(m).events);
    parse({ type: 'result', result: 'x', total_cost_usd: 0 });
    expect(tokens(first)).toEqual([50, 940]);
    expect(tokens([line(60), line(70)].flatMap((m) => parse(m).events))).toEqual([60]);
  });

  it('a text or tool block closes the burst; an empty thinking block does not', () => {
    const empty = block({ type: 'thinking', thinking: '', signature: 's' });
    expect(tokens(feed(line(50), line(200), empty, line(260)))).toEqual([50]);
    expect(tokens(feed(line(50), line(200), block({ type: 'text', text: 'hi' }), line(260)))).toEqual([50, 460]);
    expect(tokens(feed(line(50), line(200), block({ type: 'tool_use', id: 't', name: 'Read', input: {} }), line(30)))).toEqual([50, 230]);
  });
});
