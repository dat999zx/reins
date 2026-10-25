import type { CondType } from '../cond.js';
import { ordered } from '../registry.js';

const ATOMS = ordered<CondType>('condition', (c) => c.t);
/** The atoms in `order` (ties by arrival); the parser tries them in this order. Read it; add and remove with `registerCondition`. */
export const CONDS = ATOMS.map;

// The atoms that came with the default pack (and a Customize copy of one): the loader says so; a test registers its own atoms without it.
const PACK = new Set<CondType>();

/**
 * Adds an atom at `order` (none: after every other). Throws on a known `t`; with `shadow` it covers the known one instead. The disposer is one-shot.
 * `pack`: the atom is one of the default pack's. The parser answers its complaint at once; a mod atom's complaint waits until no other atom takes the text.
 */
export function registerCondition(c: CondType, order?: number, opts?: { shadow?: boolean; pack?: boolean }): () => void {
  const off = ATOMS.add(c, { order, shadow: opts?.shadow });
  if (opts?.pack) PACK.add(c);
  return () => { PACK.delete(c); off(); };
}
/** True for any atom that is not the pack's: the parser holds back its diagnostic until no other atom matches. */
export function isModCond(c: CondType): boolean { return !PACK.has(c); }
