import { Registry } from './registry.js';
import type { LoadedMod, ModHost, ModKind, Problem } from './types.js';

// The kinds of mod. A new kind is one more `registerKind` call; the loader does not change.
const KINDS = new Registry();

/** Throws on a taken id. Returns a one-shot function that removes the kind again. */
export function registerKind(k: ModKind): () => void {
  return KINDS.register('kind', k.id, k);
}

export const kindOf = (id: string) => KINDS.get<ModKind>('kind', id);
export const kindIds = () => KINDS.ids('kind');

/** Kinds in `after` order: a kind comes after every kind it names. Unknown names are ignored. */
export function kindsInOrder(): ModKind[] {
  const out: ModKind[] = [];
  const seen = new Set<string>();
  const visit = (k: ModKind) => {
    if (seen.has(k.id)) return;
    seen.add(k.id); // set first, so a loop in `after` ends
    for (const a of k.after ?? []) {
      const dep = kindOf(a);
      if (dep) visit(dep);
    }
    out.push(k);
  };
  for (const id of kindIds()) visit(kindOf(id)!);
  return out;
}

// Plain data: the mod is recorded under its kind and id. What a kind does with it comes in later tasks.
const record = (mod: LoadedMod, host: ModHost) => host.registry.register(mod.kind, mod.id, mod);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
/** A text cut to `n` characters. */
export const cap = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}...` : s);

/** A kind's validator reports at most this many problems; a wide manifest must not make a hundred thousand lines. */
export const MAX_PROBLEMS = 20;

/**
 * Any value as short, safe text for a problem line: nothing is coerced, so no toString runs, and it cannot throw
 * (a revoked proxy is just "an object"). It does not hide secrets: the loader cannot know which values are keys.
 * Task 7's redactor covers problem lines.
 */
export function show(v: unknown): string {
  try {
    if (typeof v === 'string') return cap(JSON.stringify(v));
    if (v === null || typeof v === 'number' || typeof v === 'boolean' || v === undefined) return String(v);
    return Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'an object' : `a ${typeof v}`;
  } catch {
    return 'an object';
  }
}
const word = (v: unknown) => (typeof v === 'string' ? cap(v) : show(v));

// A naming filter, not protection: it keeps a data mod from naming most variables that are not keys. It cannot tell one
// credential from another, so the consent summary (spec 7.8), which lists each variable and where it is sent, is the gate.
// The spec's own example, AWS_SECRET_ACCESS_KEY, ends in _KEY, so names holding these words are refused too.
const KEY_ENV = /^(?!.*(SECRET|ACCESS|PASSWORD))[A-Z][A-Z0-9_]*_(API_KEY|KEY|TOKEN)$/;
const LOOKS_LIKE_KEY = /(^|\s)(sk-[\w-]{8,}|[A-Za-z0-9_-]{32,})$/;

function origin(v: string): string | undefined {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

registerKind({
  id: 'protocol',
  validate: () => [],
  activate: record,
});

registerKind({
  id: 'provider',
  after: ['protocol'],
  activate: record,
  validate(raw, { id, registry }) {
    const out: Problem[] = [];
    const bad = (msg: string) => {
      if (out.length < MAX_PROBLEMS) out.push(`\`${id}\`: ${msg}`);
    };
    const full = () => out.length >= MAX_PROBLEMS; // the loops below stop here, so a wide manifest costs nothing more

    const protocols = registry.ids('protocol');
    if (!isStr(raw.protocol)) bad('`protocol` is missing.');
    else if (!protocols.includes(raw.protocol)) {
      bad(`\`protocol\` is \`${word(raw.protocol)}\`, which is not installed. Installed: ${protocols.join(', ') || 'none'}.`);
    }

    const base = typeof raw.baseUrl === 'string' ? origin(raw.baseUrl) : undefined;
    if (base === undefined) bad(`\`baseUrl\` must be an http or https address (got ${show(raw.baseUrl ?? null)}).`);
    if (raw.default !== undefined && typeof raw.default !== 'boolean') bad('`default` must be true or false.');
    if (raw.modelsUrl !== undefined) {
      const m = typeof raw.modelsUrl === 'string' ? origin(raw.modelsUrl) : undefined;
      if (m === undefined) bad(`\`modelsUrl\` must be an http or https address (got ${show(raw.modelsUrl)}).`);
      else if (base !== undefined && m !== base) bad(`\`modelsUrl\` must be on the same address as \`baseUrl\` (${cap(base)}), got ${cap(m)}.`);
    }

    if (raw.auth !== undefined) {
      const auth = raw.auth;
      if (!isObj(auth) || !isStr(auth.style) || !Array.isArray(auth.keyEnv)) bad('`auth` must be { "style": ..., "keyEnv": [...] }.');
      else {
        for (const name of auth.keyEnv) {
          if (full()) break;
          if (typeof name !== 'string' || !KEY_ENV.test(name)) {
            bad(`\`auth.keyEnv\` \`${word(name)}\` is not a key name Reins will read for a mod; names must end in _API_KEY, _KEY or _TOKEN.`);
          }
        }
      }
    }

    if (raw.headers !== undefined) {
      if (!isObj(raw.headers)) bad('`headers` must be an object of text values.');
      else {
        for (const [name, value] of Object.entries(raw.headers)) {
          if (full()) break;
          if (typeof value !== 'string') bad(`\`headers.${cap(name)}\` must be text.`);
          else if (LOOKS_LIKE_KEY.test(value.trim())) bad(`\`headers.${cap(name)}\` holds what looks like a key. Keys go in Settings > Providers, never in a mod.`);
        }
      }
    }

    const ids = new Set<string>();
    if (!Array.isArray(raw.models)) bad('`models` must be a list.');
    else {
      for (const m of raw.models) {
        if (full()) break;
        if (!isObj(m) || !isStr(m.id)) bad('every entry of `models` needs an `id`.');
        else if (ids.has(m.id)) bad(`\`models\` lists \`${cap(m.id)}\` twice.`);
        else ids.add(m.id);
      }
      if (isStr(raw.defaultModel) && !ids.has(raw.defaultModel)) bad(`\`defaultModel\` \`${cap(raw.defaultModel)}\` is not in \`models\`.`);
    }
    if (!isStr(raw.defaultModel)) bad('`defaultModel` is missing.');
    return out;
  },
});
