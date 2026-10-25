// Containment of code a mod brought (M2 Task 16c). A node that carries the loader's `mod` mark is stored as a frozen copy whose hooks cannot
// throw into core, whose texts are one visible, capped line, and whose ops are known as a mod's (`modOfOp`). Core's own kinds never pass through here.
import type { Instr } from './compile.js';
import { hasHiddenChars, showText } from './display.js';
import type { ModInfo, NodeType, OpType } from './nodes/index.js';

/** The instruction a failed compile leaves in the program: no kind owns it, and the program check reports it. */
export const FAULT_OP = '!fault';

const HEAD_MAX = 200;
const COUNT_MAX = 40;
const WHY_MAX = 200;
/** The longest line a mod prints in `reins run`. */
export const LINE_MAX = 300;

/** `v` as one visible line of at most `max` characters (and `...` when cut): a hidden character, a line break included, is shown as <U+XXXX>. Not a string: undefined. */
export function tame(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  let cut = v.length > max;
  let s = cut ? v.slice(0, max) : v;
  if (hasHiddenChars(s)) s = showText(s);
  if (s.length > max) { s = s.slice(0, max); cut = true; }
  return cut ? `${s}...` : s;
}

/** What went wrong, as a short visible line. Cannot throw: a getter or a revoked proxy as the error is as good as any. */
export function textOf(e: unknown): string {
  try {
    return tame(String((e as { message?: unknown } | undefined)?.message ?? e), WHY_MAX) ?? '';
  } catch {
    return 'an error that cannot be shown';
  }
}

/** A line for a list a person reads (the trust list) when a hook failed: starts with `!` so it cannot pass for a command. */
export const faultLine = (what: string, e: unknown): string => `! ${what}: ${textOf(e)}`;

const FROM_VM = new WeakSet<object>();
const mark = (e: unknown): unknown => {
  if (e !== null && (typeof e === 'object' || typeof e === 'function')) FROM_VM.add(e);
  return e;
};
/** True for an error that a `vm` member threw to a mod's op: it keeps the path a core op's error takes. Any other throw from a mod op is the mod's own. */
export const isVmError = (e: unknown): boolean => e !== null && (typeof e === 'object' || typeof e === 'function') && FROM_VM.has(e);

const MOD_OPS = new WeakMap<OpType<any>, ModInfo>();
/** The mod an op came from; undefined for a core kind's op. */
export const modOfOp = (op: OpType<any>): ModInfo | undefined => MOD_OPS.get(op);

type Gates = Record<string, (...a: any[]) => unknown[] | void>;
/**
 * `base` as a mod's op sees it. Every function member first asks `live()` (it throws once the instruction is over), then its gate (by dotted path;
 * a gate throws to refuse, or returns the arguments to use), and what it throws or rejects with is marked as a `vm` error. `vals` replace a value member.
 * Nothing can be set, defined or deleted through it.
 */
export function fence<T extends object>(base: T, live: () => void, gates: Gates = {}, vals: Record<string, () => unknown> = {}, path = ''): T {
  return new Proxy(base, {
    get(target, key) {
      const v = Reflect.get(target, key, target);
      if (typeof key !== 'string') return v;
      const at = path + key;
      if (Object.hasOwn(vals, at)) return vals[at]!();
      if (typeof v === 'function') {
        return (...a: unknown[]) => {
          live();
          const args = gates[at]?.(...a) ?? a;
          try {
            const r = v.apply(target, args);
            return typeof r?.then === 'function' ? r.then(undefined, (e: unknown) => { throw mark(e); }) : r;
          } catch (e) {
            throw mark(e);
          }
        };
      }
      if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return fence(v, live, gates, vals, `${at}.`);
      return v;
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
  });
}

const whole = (n: unknown): n is number => Number.isInteger(n);

/**
 * The node a mod brought, as core stores it: every member read once (a getter answers once), the hooks cannot throw into core, a hook gets a copy
 * of the step or instruction (it cannot change the workflow or the program), and what it prints or counts is one visible, capped line.
 * A throwing parse or validate hook becomes an error diagnostic; a throwing heading print becomes the kind name; a throwing compile leaves a
 * `FAULT_OP` instruction; a throwing `commands` becomes a `!` line in the trust list; a throwing `starts` or `next` names a place that is no
 * place, so the program check refuses the workflow. `exec` is left to the run, which races it with Stop.
 */
export function guardNode(src: NodeType): NodeType {
  const n = { ...src };
  const mod = n.mod;
  if (!mod || typeof mod.id !== 'string' || !Array.isArray(mod.events) || mod.events.some((e) => typeof e !== 'string')) throw new Error('a node from a mod needs the loader\'s mod mark');
  const info: ModInfo = Object.freeze({ id: mod.id, events: Object.freeze([...mod.events]), ...(mod.pack === true ? { pack: true as const } : {}), ...(mod.pack === true || mod.builtin === true ? { builtin: true as const } : {}) });
  // What a block of the default pack prints in a heading or makes an id from is the user's own data (a phase's title, the id made from it, which links in saved files name):
  // it is not cut. The same text from any other mod is one capped line. Only the loader sets `builtin`: for the pack's own blocks, and for a Customize copy of one (the same block, tweaked).
  // This flag is about what the block PRINTS. Its ops stay fenced and trusted as a mod's (`modOfOp` keeps `info`), and count/print lines keep their caps.
  const fit = (v: unknown, max: number): string | undefined => (info.builtin ? (typeof v === 'string' ? v : undefined) : tame(v, max));
  const where = (what: string) => `block ${info.id}, ${what}`;
  const out: NodeType = { ...n, mod: info, attrs: Array.isArray(n.attrs) ? Object.freeze([...n.attrs]) as string[] : [] };

  const h = n.heading;
  if (h) {
    const { parse, print, owns } = h;
    out.heading = Object.freeze({
      parse: (arg, step, ctx) => {
        try {
          return parse.call(h, arg, step, ctx);
        } catch (e) {
          ctx.push({ severity: 'error', message: faultLine(where('its heading'), e), pos: { line: ctx.line, col: ctx.col } });
          return false;
        }
      },
      print: (step) => {
        try {
          const r = print.call(h, structuredClone(step));
          return { text: fit(r.text, HEAD_MAX) ?? n.kind, condInHeading: r.condInHeading === true };
        } catch {
          return { text: n.kind, condInHeading: false };
        }
      },
      ...(Array.isArray(owns) ? { owns: Object.freeze([...owns]) as string[] } : {}),
    });
  }

  const v = n.validate;
  if (v) {
    const checks: NonNullable<NodeType['validate']> = {};
    for (const k of ['early', 'late', 'links', 'program'] as const) {
      const f = v[k] as ((step: unknown, ctx: { push(d: unknown): void; pos: unknown }) => void) | undefined;
      if (typeof f !== 'function') continue;
      (checks as Record<string, unknown>)[k] = (step: unknown, ctx: { push(d: unknown): void; pos: unknown }) => {
        try {
          f.call(v, structuredClone(step), ctx);
        } catch (e) {
          ctx.push({ severity: 'error', message: faultLine(where(`its ${k} check`), e), pos: ctx.pos });
        }
      };
    }
    out.validate = Object.freeze(checks);
  }

  const compile = n.compile;
  out.compile = (step, ctx) => {
    try {
      compile.call(n, structuredClone(step), ctx);
    } catch (e) {
      ctx.push({ op: FAULT_OP, step: step.id, why: textOf(e) } as unknown as Instr);
    }
  };

  const { defaultId, defaultPrompt } = n;
  if (defaultId) out.defaultId = (s) => { try { return fit(defaultId.call(n, structuredClone(s)), 80); } catch { return undefined; } };
  if (defaultPrompt) out.defaultPrompt = (s) => { try { const r = defaultPrompt.call(n, structuredClone(s)); return typeof r === 'string' ? r : undefined; } catch { return undefined; } };
  if (n.tag) { try { out.tag = structuredClone(n.tag); } catch { delete out.tag; } }

  for (const [field, max] of [['count', COUNT_MAX], ['print', LINE_MAX]] as const) {
    const rec = n[field];
    if (!rec || typeof rec !== 'object') { delete out[field]; continue; }
    out[field] = Object.freeze(Object.fromEntries(Object.entries(rec).map(([event, f]) => [event, (d: unknown) => {
      try {
        const s = tame((f as (d: unknown) => unknown).call(rec, structuredClone(d)), max);
        return field === 'count' && s === '__proto__' ? undefined : s;
      } catch {
        return undefined;
      }
    }])));
  }

  if (n.ops && typeof n.ops === 'object') {
    const ops: Record<string, OpType<any>> = {};
    for (const [name, o] of Object.entries(n.ops)) {
      const { exec, next, starts, commands, allowMore, ranCommand, inLoop } = o;
      // A copy of the instruction goes in; `bad` is what a throw becomes (a function: of the error).
      const at = (f: (i: Instr) => unknown, bad: unknown) => (i: Instr) => { try { return f(structuredClone(i)); } catch (e) { return typeof bad === 'function' ? bad(e) : bad; } };
      const g: OpType<any> = Object.freeze({
        exec: (i: Instr, vm: never) => exec.call(o, i, vm),
        ...(next ? { next: (i: Instr, pos: number) => { try { const r = next.call(o, structuredClone(i), pos); return Array.isArray(r) ? r.map((x) => (typeof x === 'number' ? x : undefined)) : []; } catch { return [NaN]; } } } : {}),
        ...(starts ? { starts: at((i) => { const r = starts.call(o, i); return Array.isArray(r) ? [...r] : []; }, [NaN]) } : {}),
        ...(commands ? { commands: at((i) => { const r = commands.call(o, i); return Array.isArray(r) ? r.filter((c): c is string => typeof c === 'string') : []; }, (e: unknown) => [faultLine(where(`the commands of ${name}`), e)]) } : {}),
        ...(allowMore ? { allowMore: at((i) => { const r = allowMore.call(o, i); return whole(r) && r >= 0 ? r : undefined; }, undefined) } : {}),
        ...(ranCommand === true ? { ranCommand: true as const } : {}),
        // The patch is a copy of plain data; a throw (or a patch that is not an object) takes nothing.
        ...(inLoop ? { inLoop: (i: Instr, loop: unknown) => { try { const r = inLoop.call(o, structuredClone(i), structuredClone(loop) as never); return r !== null && typeof r === 'object' && !Array.isArray(r) ? structuredClone(r) : undefined; } catch { return undefined; } } } : {}),
      });
      MOD_OPS.set(g, info);
      ops[name] = g;
    }
    out.ops = Object.freeze(ops);
  }
  return Object.freeze(out);
}
