import { BUILTIN_VIEWS, hasHiddenChars, type KindView } from '@reins/core';
import type { LoadedMod, Mods } from './types.js';

/** A view as served. `trusted: false` is on a mod's view whose code has not been trusted (the face is known from the manifest; the block cannot run yet). */
export type ServedKind = KindView & { trusted?: false };
export interface KindsReply {
  kinds: ServedKind[];
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
 * The list the app builds its kinds from: core's built-in views plus the view of every block mod, from the manifest's JSON (the `block-view`
 * registry), never from code. In `order`, ties in the order they came (built-ins first). A view with a hidden character anywhere in it, or one
 * that names a built-in kind, is left out and said in `problems`. Both the route and the app's test setup call this, so they cannot differ.
 */
export function servedKinds(mods?: Pick<Mods, 'mods' | 'registry'>): KindsReply {
  const problems: string[] = [];
  const kinds: ServedKind[] = [];
  const taken = new Set(BUILTIN_VIEWS.map((v) => v.kind));
  const take = (view: unknown, who: string, fallbackOrder?: number, trusted = true) => {
    let copy: ServedKind;
    try {
      copy = JSON.parse(JSON.stringify(view)) as ServedKind; // plain data only; a function does not come along
    } catch {
      return void problems.push(`${plain(who)}: the view could not be read as JSON, so it is not served.`);
    }
    if (strings(copy).some(hasHiddenChars)) return void problems.push(`${plain(who)}: the view holds a control, line-break or direction-changing character, so it is not served.`);
    delete copy.trusted;
    if (typeof copy.order !== 'number' && fallbackOrder !== undefined) copy.order = fallbackOrder;
    if (!trusted) copy.trusted = false;
    kinds.push(copy);
  };
  for (const v of BUILTIN_VIEWS) take(v, v.kind);
  for (const kind of mods?.registry.ids('block-view') ?? []) {
    if (taken.has(kind)) {
      problems.push(`${plain(kind)}: a mod cannot give a view to a built-in block, so it is not served.`);
      continue;
    }
    const mod = mods!.mods.find((m: LoadedMod) => m.kind === 'block' && (m.manifest as { view?: { kind?: unknown } } | undefined)?.view?.kind === kind);
    take(mods!.registry.get('block-view', kind), kind, (mod?.manifest as { order?: number } | undefined)?.order, mod?.trusted === true);
  }
  return { kinds: kinds.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9)), problems };
}
