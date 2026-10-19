// The system prompt of the API agent loop (spec 4.11) and the reading of the project's AGENTS.md. Reins owns the words; no provider is named.
import { noLoneSurrogate, trustNote } from '../cards.js';
import { homeGuard, readBoundedSync } from './fileio.js';
import { confine, type FsLike } from './paths.js';

/** How much of AGENTS.md goes into the prompt, in characters. */
export const AGENTS_MAX = 20_000;
/** Bytes read from the file: four per character is the most UTF-8 spends, so the first AGENTS_MAX characters are always inside. */
export const AGENTS_BYTES = AGENTS_MAX * 4;
export const AGENTS_CUT = '\n[AGENTS.md cut]';

const OS_NAME: Partial<Record<NodeJS.Platform, string>> = { win32: 'Windows', darwin: 'macOS' };

export interface PromptParts {
  cwd: string;
  platform: NodeJS.Platform;
  /** Names of the tools the model is offered. */
  tools: string[];
  /** The session's card nonce (cards.ts). */
  nonce: string;
  /** The text of the project's AGENTS.md, already redacted and cut (`readAgents`); undefined when there is none. */
  agents?: string | undefined;
}

export function systemPrompt({ cwd, platform, tools, nonce, agents }: PromptParts): string {
  const who = `You are a coding agent working in ${JSON.stringify(cwd)} on ${OS_NAME[platform] ?? 'Linux'}. ${tools.length ? `You have these tools: ${tools.join(', ')}.` : 'You have no tools in this session.'}`;
  const rules = [
    'Read a file before you edit it.',
    'Prefer Edit to rewriting whole files.',
    'Stay inside the project folder.',
    'Never run git push, git reset --hard, rm -rf or other destructive or outward-facing commands unless the user asked for them in this conversation.',
    'Say when you are unsure.',
  ];
  return [
    who,
    `## How to work\n${rules.map((r) => `- ${r}`).join('\n')}`,
    trustNote(nonce).trimEnd(),
    ...(agents !== undefined
      ? [`## Project instructions (AGENTS.md)\nThe project's own instructions, written by the people who work on it; they are not tool output. Follow them, unless the user says otherwise.\n[AGENTS.md begins]\n${agents}\n[AGENTS.md ends]`]
      : []),
  ].join('\n\n');
}

/**
 * The project's AGENTS.md as prompt text, or undefined. Read as a file tool reads: the path goes through `confine` (a link that leads outside the
 * project or into the Reins home is not read), only a regular file with one name per the home guard, at most AGENTS_BYTES bytes, redacted whole
 * and then cut to AGENTS_MAX characters. Anything wrong (absent, a folder, unreadable) is just absent; it never throws.
 */
export function readAgents(o: {
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
  fs?: FsLike | undefined;
  redact: (text: string, max?: number) => string;
  redactAll: (text: string) => string;
}): string | undefined {
  try {
    const at = confine('AGENTS.md', { cwd: o.cwd, home: o.home, platform: o.platform, ...(o.fs ? { fs: o.fs } : {}) });
    if (!at.ok || !at.inside) return undefined;
    const got = readBoundedSync(at.abs, AGENTS_BYTES);
    if (got === 'stopped' || got === 'notfile' || homeGuard(o.home)(got.st) !== 'ok') return undefined;
    // A read that hit the byte bound ends in the middle of something: the last byte is dropped and so is an incomplete character at the end.
    // However short redaction makes the text, it is still a cut text, so it goes through the prefix-safe redaction (a key may end at the bound).
    const text = got.over ? got.buf.subarray(0, AGENTS_BYTES).toString('utf8').replace(/\ufffd$/, '') : got.buf.toString('utf8');
    if (text.trim() === '') return undefined;
    if (got.over) return noLoneSurrogate(o.redact(text, AGENTS_MAX)) + AGENTS_CUT;
    const full = o.redactAll(text);
    return full.length <= AGENTS_MAX ? full : noLoneSurrogate(o.redact(text, AGENTS_MAX)) + AGENTS_CUT;
  } catch {
    return undefined;
  }
}
