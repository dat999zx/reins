// Spec 4.12b: the history sent to a model has every tool call answered by exactly one result, in the user message right after it, and no result
// without its call. Pure; used on load, before every request, when a turn ends early, and after an `unpaired` 400.
import type { Block, Msg } from './types.js';

export const INTERRUPTED = 'Interrupted; the tool did not finish.';

export type Call = Extract<Block, { type: 'tool_call' }>;
export const callsOf = (blocks: Block[]): Call[] => blocks.filter((b): b is Call => b.type === 'tool_call');
export const resultBlock = (id: string, content: string, isError = false): Block => ({ type: 'tool_result', id, content, ...(isError ? { isError } : {}) });

const nonEmpty = (m: Msg) => m.blocks.length > 0;

/**
 * Returns a new list (the input is not changed); `stubbed` names the calls it answered with the stub.
 * Paired by ROUND: a round is one assistant message and the run of user messages right after it (up to the next assistant message). Ids may
 * repeat from round to round (some providers number their calls from 0 in every reply), so nothing is matched across rounds.
 * - A result counts only when its id is one of the calls of its own round; the first result per id wins, any other is dropped. So a result with no
 *   call, before its call, in an assistant message, for a call of another round, or a second one for the same id, is dropped.
 * - A call whose id is already used in the same assistant message is dropped; a message left empty is dropped.
 * - A round with calls becomes ONE user message: the results in the order of the calls (the stub for a call with none), then every other block
 *   (cards, the user's text) in their order. A round with no calls keeps its user messages as they are, minus any result.
 * Two messages of the same role elsewhere are left to the wires, which merge them.
 */
export function pairUp(msgs: Msg[]): { msgs: Msg[]; stubbed: Call[] } {
  const out: Msg[] = [];
  const stubbed: Call[] = [];
  let calls: Call[] = [];
  let run: Msg[] = [];

  const closeRound = () => {
    if (!calls.length) {
      for (const u of run) {
        const blocks = u.blocks.filter((b) => b.type !== 'tool_result');
        if (blocks.length) out.push(blocks.length === u.blocks.length ? u : { ...u, blocks });
      }
    } else {
      const taken = new Map<string, Block>();
      const rest: Block[] = [];
      for (const u of run) {
        for (const b of u.blocks) {
          if (b.type !== 'tool_result') rest.push(b);
          else if (calls.some((c) => c.id === b.id) && !taken.has(b.id)) taken.set(b.id, b);
        }
      }
      const results = calls.map((c) => {
        const got = taken.get(c.id);
        if (got) return got;
        stubbed.push(c);
        return resultBlock(c.id, INTERRUPTED, true);
      });
      const extras = run.map((u) => u.extra).filter((x) => x !== undefined);
      out.push({ role: 'user', blocks: [...results, ...rest], ...(extras.length ? { extra: Object.assign({}, ...extras) } : {}) });
    }
    calls = [];
    run = [];
  };

  for (const m of msgs) {
    if (m.role === 'user') {
      if (nonEmpty(m)) run.push(m);
      continue;
    }
    // An assistant message: it never holds results, and a call id is used once in it.
    const seen = new Set<string>();
    const blocks = m.blocks.filter((b) => {
      if (b.type === 'tool_result') return false;
      if (b.type !== 'tool_call') return true;
      if (seen.has(b.id)) return false;
      seen.add(b.id);
      return true;
    });
    if (!blocks.length) continue;
    closeRound();
    const kept = blocks.length === m.blocks.length ? m : { ...m, blocks };
    out.push(kept);
    calls = callsOf(kept.blocks);
  }
  closeRound();
  return { msgs: out, stubbed };
}

const TOOL_CALL_CUT = 1000;
const TOOL_RESULT_CUT = 2000;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);
const argsText = (a: unknown): string => {
  try {
    return typeof a === 'string' ? a : (JSON.stringify(a) ?? '');
  } catch {
    return '';
  }
};

/**
 * Every tool round as plain text: a call becomes `[tool call <name> <args>]` in its assistant message (args cut at 1,000 characters), a result
 * `[tool result <text>]` (cut at 2,000; `error` after the word result when it was one). No tool blocks are left, so no pairing can be wrong. The
 * thinking blocks and every `extra` go too (they belong to blocks that are now text). Pure; the input is not changed.
 */
export function flattenRounds(msgs: Msg[]): Msg[] {
  const out: Msg[] = [];
  for (const m of msgs) {
    const blocks = m.blocks.map((b): Block => {
      if (b.type === 'tool_call') return { type: 'text', text: `[tool call ${b.name} ${cut(argsText(b.args), TOOL_CALL_CUT)}]` };
      if (b.type === 'tool_result') return { type: 'text', text: `[tool result${b.isError ? ' error' : ''} ${cut(b.content, TOOL_RESULT_CUT)}]` };
      return b.type === 'thinking' ? { type: 'text', text: '' } : b;
    }).filter((b) => b.type !== 'text' || b.text !== '');
    if (blocks.length) out.push({ role: m.role, blocks });
  }
  return out;
}
