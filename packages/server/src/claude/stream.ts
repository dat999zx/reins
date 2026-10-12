import type { EngineEvent } from '@reins/core';

export interface StreamOut {
  events: EngineEvent[];
  /** Set on the `result` line that ends a turn. `totalCostUsd` is cumulative for the session. */
  result?: { text: string; totalCostUsd: number; isError: boolean; usage?: { model: string; used: number; window?: number } };
  /** Set once, from the first `system/init`. */
  sessionId?: string;
}

/**
 * Turns claude `stream-json` lines into EngineEvents (plan 15b 2.3). Shapes come from the
 * recorded streams in spike/fixtures; everything else (hook lifecycle, rate limits, control
 * responses, later `system/init`s) is ignored. Thinking text is empty in 2.1.281 (only a
 * signature), so `system/thinking_tokens` estimates are used for a count, never the text.
 */
export function createStreamParser(o: { windows?: Record<string, number> } = {}) {
  const toolNames = new Map<string, string>();
  let sawInit = false;
  // ponytail: a row at a burst start and each further 1,000 tokens: the last burst of a turn shows its start figure; emit at the burst end too if that reads wrong.
  // tokens of this turn's finished bursts, the open burst's latest estimate, whether one is open, the last total emitted
  let done = 0, cur = 0, open = false, shown = 0;
  const closeBurst = () => { if (open) { done += cur; cur = 0; open = false; } };
  // the model named by the last init, and the model and usage of the last parent (not sidechain) assistant line of this turn
  let initModel: string | undefined, model: string | undefined, usage: any;

  return (m: any): StreamOut => {
    const out: StreamOut = { events: [] };
    if (m?.type === 'system' && m.subtype === 'init') {
      if (!sawInit && typeof m.session_id === 'string') out.sessionId = m.session_id;
      sawInit = true;
      if (typeof m.model === 'string') initModel = m.model;
    } else if (m?.type === 'system' && m.subtype === 'compact_boundary') {
      // ponytail: after a compact_boundary the turn's earlier usage is dropped; post_tokens is the CLI's figure (it leaves out the system prompt), so it is reported, never used as the measured context.
      const c = m.compact_metadata;
      out.events.push({
        type: 'compacted',
        trigger: typeof c?.trigger === 'string' ? c.trigger : 'unknown',
        ...(count(c?.pre_tokens) ? { before: c.pre_tokens } : {}),
        ...(count(c?.post_tokens) ? { after: c.post_tokens } : {}),
      });
      usage = undefined;
    } else if (m?.type === 'system' && m.subtype === 'thinking_tokens' && Number.isFinite(m.estimated_tokens)) {
      const e = Number(m.estimated_tokens);
      const start = !open || e < cur;
      if (start) closeBurst();
      open = true;
      cur = e;
      if (start || done + cur >= shown + 1000) out.events.push({ type: 'thinking', tokens: shown = done + cur });
    } else if (m?.type === 'assistant') {
      // ponytail: context used = the last parent assistant message's input + cache + output tokens (F3, inferred); one usage per successful turn.
      if (m.parent_tool_use_id == null && m.message?.usage && typeof m.message.usage === 'object') {
        usage = m.message.usage;
        if (typeof m.message.model === 'string') model = m.message.model;
      }
      for (const b of blocks(m)) {
        if (b.type === 'text' || b.type === 'tool_use') closeBurst();
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
      done = cur = shown = 0;
      open = false;
      const isError = m.is_error === true;
      out.result = {
        text: typeof m.result === 'string' ? m.result : '',
        totalCostUsd: Number(m.total_cost_usd ?? 0),
        isError,
      };
      const u = isError ? undefined : usageOf(model ?? initModel, usage, m.modelUsage, o.windows);
      if (u) out.result.usage = u;
      model = usage = undefined;
    }
    return out;
  };
}

const count = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

function usageOf(model: string | undefined, u: any, modelUsage: any, windows?: Record<string, number>) {
  if (!model || !u) return undefined;
  const parts = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens, u.output_tokens];
  if (!parts.every(count)) return undefined;
  const used = (parts as number[]).reduce((a, b) => a + b, 0);
  const w = [modelUsage?.[model]?.contextWindow, windows?.[model]].find((x) => count(x) && x > 0);
  return { model, used, ...(w ? { window: w as number } : {}) };
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
