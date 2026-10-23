import { BUILTIN_VIEWS, CARDS, CONDS, copyViewProblem, hasHiddenChars, viewShapeProblem, type CardView, type CondView, type KindView } from '@reins/core';
import { QUESTIONS, type QuestionCard } from '../questions/index.js';
import type { LoadedMod, Mods, Provides } from './types.js';

/** A view as served. `trusted: false` is on a mod's view whose code has not been trusted (the face is known from the manifest; the block cannot run yet). */
export type ServedKind = KindView & { trusted?: false };
/** A condition the editor offers: its `t` and the data from its view. */
export type ServedCond = CondView & { t: string };
/** A card the block panel offers: its kind and the words from its view. */
export type ServedCard = CardView & { kind: string };
export interface KindsReply {
  kinds: ServedKind[];
  /** The conditions the editor offers, in core's order (the order the parser tries them). */
  conds: ServedCond[];
  /** The cards the block panel offers, in core's order. */
  cards: ServedCard[];
  /** Core's question cards. Always these eight; no mod adds to them. */
  questions: QuestionCard[];
  /** Why a view was left out, in plain words; a name with a hidden character is written in \u form. */
  problems: string[];
}

/** Every string in a JSON value, keys included. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (typeof v === 'object' && v !== null) for (const [k, x] of Object.entries(v)) strings(x, strings(k, out));
  return out;
}
const plain = (s: string) => s.slice(0, 40).replace(/[^ -~]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * The list the app builds its kinds, conditions, cards and question cards from: core's built-in views plus the view of every block mod, from the
 * manifest's JSON (the `block-view` registry), never from code; the editor data of the conditions and cards that are in core now (the manifest's of
 * the mod that registered it, the pack's among them); and core's eight question cards. Kinds are in `order`, ties in the order they came (built-ins first).
 * A view with a hidden character anywhere in it, or one that names a built-in kind, is left out and said in `problems`. Both the route and the app's
 * test setup call this, so they cannot differ.
 */
export function servedKinds(mods?: Pick<Mods, 'mods' | 'registry'>): KindsReply {
  const problems: string[] = [];
  const kinds: ServedKind[] = [];
  const taken = new Set(BUILTIN_VIEWS.map((v) => v.kind));
  /** A plain-JSON copy of `view` (a function does not come along) with no hidden character in any text; else undefined and a problem. */
  const clean = <T>(view: unknown, who: string): T | undefined => {
    let copy: T;
    try {
      copy = JSON.parse(JSON.stringify(view)) as T;
    } catch {
      return void problems.push(`${plain(who)}: the view could not be read as JSON, so it is not served.`);
    }
    if (strings(copy).some(hasHiddenChars)) return void problems.push(`${plain(who)}: the view holds a control, line-break or direction-changing character, so it is not served.`);
    return copy;
  };
  const take = (view: unknown, who: string, fallbackOrder?: number, trusted = true, provides?: Provides, builtin = false, replaced?: LoadedMod) => {
    const copy = clean<ServedKind>(view, who);
    if (!copy) return;
    delete copy.trusted;
    // A copy of a built-in is served with the pack's powers only as far as the built-in has them (the loader holds the manifest to the same rule).
    const over = replaced && copyViewProblem(copy, replaced.builtinView as object | undefined);
    if (over) return void problems.push(`${plain(who)}: ${over.replaceAll('`', '')} It is not served.`);
    // The mod's own check ran on the manifest; this is the same shape check on what is served, so a view that got here some other way is left out too.
    const why = viewShapeProblem(copy, provides && { mod: { attrs: provides.attrs ?? [], events: provides.events ?? [], ...(builtin ? { pack: true as const } : {}) } });
    if (why !== undefined) return void problems.push(`${plain(who)}: ${why.replaceAll('`', '')} It is not served.`);
    if (typeof copy.order !== 'number' && fallbackOrder !== undefined) copy.order = fallbackOrder;
    if (!trusted) copy.trusted = false;    kinds.push(copy);
  };
  for (const v of BUILTIN_VIEWS) take(v, v.kind);
  for (const kind of mods?.registry.ids('block-view') ?? []) {
    if (taken.has(kind)) {
      problems.push(`${plain(kind)}: a mod cannot give a view to a built-in block, so it is not served.`);
      continue;
    }
    const mod = mods!.mods.find((m: LoadedMod) => m.kind === 'block' && (m.manifest as { view?: { kind?: unknown } } | undefined)?.view?.kind === kind);
    // `trusted: false` is for a block with code that has not been trusted; a data block has no code to trust, so it is not marked.
    const manifest = mod?.manifest as { order?: number; provides?: Provides } | undefined;
    take(mods!.registry.get('block-view', kind), kind, manifest?.order, mod === undefined ? false : mod.trusted === true || !mod.hasCode, manifest && (manifest.provides ?? {}), mod?.pack === 'default' || mod?.replaces === 'bundled', mod?.replaces === 'bundled' ? mod : undefined);
  }

  // Only what is in core now is offered: an atom or card of a mod that did not load has no entry here.
  const conds: ServedCond[] = [];
  for (const c of CONDS.values()) {
    const view = mods?.registry.get<CondView>('cond-view', c.t);
    const copy = view && clean<CondView>(view, `condition ${c.t}`);
    if (copy) conds.push({ ...copy, t: c.t });
  }
  const cards: ServedCard[] = [];
  for (const c of CARDS.values()) {
    const view = mods?.registry.get<CardView>('card-view', c.kind);
    const copy = view && clean<CardView>(view, `card ${c.kind}`);
    if (copy) cards.push({ ...copy, kind: c.kind });
  }
  const questions = QUESTIONS.flatMap((q) => clean<QuestionCard>(q, `question ${q.kind}`) ?? []);

  return { kinds: kinds.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9)), conds, cards, questions, problems };
}
