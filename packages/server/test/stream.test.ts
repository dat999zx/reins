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
