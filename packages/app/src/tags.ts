import type { Tag, TagEntry } from '@reins/server/tags.js';

export interface Chip { tag: string; arg?: string }
export interface Picker { start: number; end: number; matches: TagEntry[] }

export const filterTags = (catalogue: TagEntry[], query: string) =>
  catalogue.filter((t) => t.name.startsWith(query.toLowerCase()));

export function pickerFor(text: string, caret: number, catalogue: TagEntry[]): Picker | null {
  const m = /(?:^|\s)#([a-z-]*)$/i.exec(text.slice(0, caret));
  if (!m) return null;
  const matches = filterTags(catalogue, m[1]!);
  return matches.length ? { start: caret - m[1]!.length - 1, end: caret, matches } : null;
}

export function takeTag(text: string, at: { start: number; end: number }): { text: string; caret: number } {
  const from = text[at.start - 1] === ' ' ? at.start - 1 : at.start;
  return { text: text.slice(0, from) + text.slice(at.end), caret: from };
}

export const chipsToTags = (chips: Chip[]): Tag[] =>
  chips.map((c) => {
    const arg = c.arg?.trim();
    return arg ? { tag: c.tag, arg } : { tag: c.tag };
  });

export const missingArg = (chips: Chip[], catalogue: TagEntry[]) =>
  chips.find((c) => catalogue.find((t) => t.name === c.tag)?.argRequired && !c.arg?.trim())?.tag ?? null;
