import type { EngineEvent } from '@reins/core';

export interface StreamOut {
  events: EngineEvent[];
  /** Set on the `result` line that ends a turn. `totalCostUsd` is cumulative for the session. */
  result?: { text: string; totalCostUsd: number; isError: boolean };
  /** Set once, from the first `system/init`. */
  sessionId?: string;
}

/**
 * Turns claude `stream-json` lines into EngineEvents (plan 15b 2.3). Shapes come from the
 * recorded streams in spike/fixtures; everything else (hook lifecycle, thinking, rate limits,
 * control responses, later `system/init`s) is ignored.
 */
export function createStreamParser() {
  const toolNames = new Map<string, string>();
  let sawInit = false;

  return (m: any): StreamOut => {
    const out: StreamOut = { events: [] };
    if (m?.type === 'system' && m.subtype === 'init') {
      if (!sawInit && typeof m.session_id === 'string') out.sessionId = m.session_id;
      sawInit = true;
    } else if (m?.type === 'assistant') {
      for (const b of blocks(m)) {
        if (b.type === 'text' && b.text) out.events.push({ type: 'text', text: b.text });
        if (b.type === 'tool_use') {
          toolNames.set(b.id, b.name);
          out.events.push({ type: 'tool_call', tool: b.name, input: b.input });
        }
      }
    } else if (m?.type === 'user') {
      for (const b of blocks(m)) {
        if (b.type !== 'tool_result') continue;
        const text = contentText(b.content);
        // A PreToolUse deny arrives as `PreToolUse:Edit hook error: <our reason>`.
        const hook = b.is_error ? /^\w+:\w+ hook error: ([\s\S]*)$/.exec(text) : null;
        if (hook) out.events.push({ type: 'refusal', reason: hook[1]! });
        else out.events.push({ type: 'tool_result', tool: toolNames.get(b.tool_use_id) ?? 'unknown', output: b.content });
      }
    } else if (m?.type === 'result') {
      out.result = {
        text: typeof m.result === 'string' ? m.result : '',
        totalCostUsd: Number(m.total_cost_usd ?? 0),
        isError: m.is_error === true,
      };
    }
    return out;
  };
}

function blocks(m: any): any[] {
  const c = m.message?.content;
  return Array.isArray(c) ? c : [];
}

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x: any) => (typeof x?.text === 'string' ? x.text : '')).join('');
  return '';
}
