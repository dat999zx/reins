import { BUILTIN_VIEWS } from '@reins/core';
import budget from './budget.js';
import gate from './gate.js';
import judge from './judge.js';
import resume from './resume.js';
import switchCard from './switch.js';
import tool from './tool.js';
import trust from './trust.js';
import usd from './usd.js';
import type { QuestionCard } from './types.js';

export type { QuestionAction, QuestionCard, QuestionField } from './types.js';

const deepFreeze = <T>(v: T): T => {
  if (typeof v === 'object' && v !== null) for (const x of Object.values(v)) deepFreeze(x);
  return Object.freeze(v);
};

/**
 * The eight question cards. Core's: a fixed, frozen list, written here and nowhere else. There is no register call, no registry a mod can reach
 * and no mod kind for a question, so a mod cannot add one, cover one or switch one off. `GET /api/kinds` serves them.
 */
export const QUESTIONS: readonly QuestionCard[] = deepFreeze([budget, gate, judge, resume, switchCard, tool, trust, usd]);

const NAMES = new Set(QUESTIONS.map((q) => q.kind));

/**
 * The words for a `provides` entry that names a question card, or undefined. A block kind of the same name is the block (`gate`), not the
 * question, so a `kinds` entry that is a built-in block is left to the rules for blocks.
 */
export function questionRefusal(key: string, name: unknown): string | undefined {
  if (typeof name !== 'string' || !NAMES.has(name)) return undefined;
  if (key !== 'kinds' && key !== 'conditions' && key !== 'cards') return undefined;
  if (key === 'kinds' && BUILTIN_VIEWS.some((v) => v.kind === name)) return undefined;
  return `\`provides.${key}\` names \`${name}\`, which is a question card. Question cards belong to Reins: a mod cannot add, replace or change one.`;
}
