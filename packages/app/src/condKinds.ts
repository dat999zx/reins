import type { Cond, CondView } from '@reins/core';

export type CondParam = NonNullable<CondView['param']>;
export type ServedCond = CondView & { t: string };

// The conditions the editor offers come from the server (`GET /api/kinds`, read in App.tsx); the app holds no list of its own. Empty until the first reply.
// No prototype: a condition named `constructor` or `__proto__` in a workflow is not found, rather than finding Object's.
export const COND_VIEWS: Record<string, ServedCond> = Object.create(null);

// ponytail: the core printers do not escape, so a value that would not read back is refused here; escape in core print to lift it
const OK: Record<CondParam['key'], (v: string) => boolean> = {
  n: (v) => /^\d{1,9}$/.test(v),
  q: (v) => !/["\\]/.test(v),
  cmd: (v) => v !== '' && !v.includes('`'),
  glob: (v) => v !== '' && !/[\s)]/.test(v),
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const LOOKS = ['code', 'str', 'num', 'pill'] as const satisfies readonly CondParam['look'][];
// The keys are the ones OK knows how to check (core's COND_PARAM_KEYS, which the server holds a mod's view to).
const okParam = (p: unknown) => p === undefined || (isObj(p) && typeof p.key === 'string' && Object.hasOwn(OK, p.key) && (LOOKS as readonly unknown[]).includes(p.look) && (p.optional === undefined || p.optional === true));
// An entry that is not a condition view (no label, a fresh atom of another `t`, a param the box cannot set) is left out: the server checks, the app does not trust.
const okCond = (v: unknown): v is ServedCond => isObj(v) && typeof v.t === 'string' && typeof v.label === 'string' && isObj(v.fresh) && v.fresh.t === v.t && okParam(v.param);

/** Fills the conditions from the server's list, in its order. Importers hold this object, so it is filled in place. */
export function setConds(list: unknown): void {
  for (const t of Object.keys(COND_VIEWS)) delete COND_VIEWS[t];
  if (Array.isArray(list)) for (const c of list) if (okCond(c)) COND_VIEWS[c.t] = c;
}

/** A new atom of kind `t`, or undefined when the app has no such condition. A copy each call. */
export const freshCond = (t: string): Cond | undefined => (COND_VIEWS[t] ? (structuredClone(COND_VIEWS[t].fresh) as unknown as Cond) : undefined);

/** A condition to try a drop with: the first one the server offers (a new copy), or undefined before its reply. */
export const standInCond = (): Cond | undefined => freshCond(Object.keys(COND_VIEWS)[0] ?? '');

// A new atom with the value set, or undefined when the value would not print back.
export function applyParam(c: Cond, v: string): Cond | undefined {
  const p = COND_VIEWS[c.t]?.param;
  if (!p) return undefined;
  if (p.optional && v === '') {
    const { [p.key]: _gone, ...rest } = c as Cond & Record<string, unknown>;
    return rest as Cond;
  }
  if (!OK[p.key](v)) return undefined;
  return { ...c, [p.key]: p.key === 'n' ? Number(v) : v } as Cond;
}
