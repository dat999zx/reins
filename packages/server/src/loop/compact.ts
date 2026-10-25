// Compaction (spec 4.8, 4.12c): which part of the history is kept as it is (the tail), what the rest is shown as to the model that summarises it
// (the head, with old long tool results cut), and the history that follows. Pure; the engine makes the call and writes the file.
import { flattenRounds } from './pairs.js';
import type { Block, Msg } from './types.js';

/** One estimate for every size in this file: characters / 4, rounded up. Not exact (no tokenizer); the figures it gives are said to be estimates. */
export const CHARS_PER_TOKEN = 4;
/** The tail kept as it is: at most this share of the window, and at most this many tokens. */
export const TAIL_SHARE = 0.2;
export const TAIL_MAX_TOKENS = 25_000;
/** A tool result in the head longer than this many characters is cut to one line. */
export const STUB_OVER = 500;

const argsChars = (a: unknown): number => {
  try {
    return (typeof a === 'string' ? a : JSON.stringify(a))?.length ?? 0;
  } catch {
    return 0;
  }
};
const blockChars = (b: Block): number => (b.type === 'tool_call' ? b.name.length + argsChars(b.args) : b.type === 'tool_result' ? b.content.length : b.text.length);
const msgChars = (m: Msg): number => m.blocks.reduce((n, b) => n + blockChars(b), 0);

/** Estimated tokens of a list of messages (history only: the system prompt and tool list are not counted). */
export const tokensOf = (msgs: Msg[]): number => Math.ceil(msgs.reduce((n, m) => n + msgChars(m), 0) / CHARS_PER_TOKEN);

/** Tokens the tail may take: min(20 % of the window, 25,000). A window that is not known leaves only the 25,000. */
export const tailBudget = (windowTokens?: number): number =>
  Math.min(windowTokens !== undefined && Number.isFinite(windowTokens) && windowTokens > 0 ? Math.floor(windowTokens * TAIL_SHARE) : Infinity, TAIL_MAX_TOKENS);

/** A user message that no tool call is answered in: where a tail may start. */
const plain = (m: Msg): boolean => m.role === 'user' && !m.blocks.some((b) => b.type === 'tool_result');

/**
 * Where the kept tail starts (an index into `history`, which is paired: spec 4.12b), or undefined when there is nothing before it to summarise.
 * The tail is as much of the end as fits the budget; when that starts inside a tool round the start moves BACK to the user message that began
 * it, so a round is never split and the tail may run over the budget by one round. The tail always holds the last user message and all that
 * follows it (the very last round), however big that is.
 */
export function chooseCut(history: Msg[], windowTokens?: number): number | undefined {
  const room = tailBudget(windowTokens) * CHARS_PER_TOKEN;
  let at = history.length;
  let used = 0;
  while (at > 0 && used + msgChars(history[at - 1]!) <= room) used += msgChars(history[--at]!);
  let cut = Math.min(at, history.length - 1);
  while (cut > 0 && !plain(history[cut]!)) cut--;
  return cut > 0 ? cut : undefined;
}

/** What replaces a long result. */
export const stubText = (chars: number): string => `[tool result cut by compaction, was ${chars} characters]`;

/** The messages before `keepFrom` with every tool result over STUB_OVER characters cut to one line (ids and pairing kept); the rest as they are. */
export function stubOldResults(msgs: Msg[], keepFrom: number): Msg[] {
  return msgs.map((m, i) => {
    if (i >= keepFrom || !m.blocks.some((b) => b.type === 'tool_result' && b.content.length > STUB_OVER)) return m;
    return { ...m, blocks: m.blocks.map((b): Block => (b.type === 'tool_result' && b.content.length > STUB_OVER ? { ...b, content: stubText(b.content.length) } : b)) };
  });
}

/** What the model that summarises is told. Plain words; it is data, not code. */
export const SUMMARY_SYSTEM =
  'You write the summary of an earlier part of a conversation between a user and a coding agent. The summary replaces that part, and the agent '
  + 'will carry on from it, so it must be enough to continue the work without the original. Write plain notes, no greeting and no questions. '
  + 'Cover: what the user asked for; what was done; the files that were read, changed or made; the decisions taken and why; and what is left to do. '
  + 'Keep exact names, paths, commands and error messages that matter. Do not call any tool. Do not carry on the work yourself.';

/** The head as the text of one user message: each message labelled, tool calls and results as plain text. No tool blocks, so it is valid on any wire. */
export function transcript(head: Msg[]): string {
  const lines: string[] = [];
  for (const m of head) {
    const flat = flattenRounds([m])[0];
    if (!flat) continue;
    const who = m.blocks.some((b) => b.type === 'tool_result') ? 'Tool results' : m.role === 'user' ? 'User' : 'Assistant';
    lines.push(`${who}: ${flat.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n')}`);
  }
  return `${lines.join('\n\n')}\n\nWrite the summary of the conversation above.`;
}

/** The start of the summary message the next request carries. */
export const SUMMARY_PREFIX = 'Summary of the earlier conversation: ';

/**
 * The history after a compaction: the tail with the summary as the first text of its first message. The tail starts at a user message, so
 * the summary joins it and no two user messages follow each other; a tail that does not (never made by `chooseCut`) gets a user message of its own.
 */
export function withSummary(summary: string, tail: Msg[]): Msg[] {
  const note: Block = { type: 'text', text: SUMMARY_PREFIX + summary };
  const [first, ...rest] = tail;
  if (first?.role === 'user') return [{ ...first, blocks: [note, ...first.blocks] }, ...rest];
  return [{ role: 'user', blocks: [note] }, ...tail];
}
