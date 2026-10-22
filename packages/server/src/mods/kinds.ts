import { dataBlock, hasHiddenChars, turnNames } from '@reins/core';
import { RESERVED_BODY } from '../loop/wire-util.js';
import { Registry } from './registry.js';
import type { LoadedMod, ModHost, ModKind, Problem, Provides } from './types.js';

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
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Text with everything outside printable ASCII written as \uXXXX, so a problem line shows what a name really holds. */
const plain = (s: string) => cap(s, 40).replace(/[^ -~]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
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
  validate(raw, { id, registry, source }) {
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
    else if (raw.default === true && source !== 'bundled') bad('A mod cannot make itself the default provider. Choose the default in Settings.');
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
          if (!HEADER_TOKEN.test(name)) bad(`\`headers\` has the name "${plain(name)}", which is not a valid header name (letters, digits and !#$%&'*+.^_\`|~- only).`);
          else if (typeof value !== 'string') bad(`\`headers.${cap(name)}\` must be text.`);
          else if (value.includes('\r') || value.includes('\n') || value.includes('\0')) bad(`\`headers.${cap(name)}\` must not hold a line break or a NUL character.`);
          else if (LOOKS_LIKE_KEY.test(value.trim())) bad(`\`headers.${cap(name)}\` holds what looks like a key. Keys go in Settings > Providers, never in a mod.`);
        }
      }
    }

    // A `body` is merged into every request. It may not name what Reins writes itself: a body that changed the model would bill a model other than
    // the one that was priced, and one that replaced the messages or the tools would change what is sent. (`mergeBodies` enforces it again.)
    const checkBody = (where: string, body: unknown) => {
      if (body === undefined) return;
      if (!isObj(body)) return bad(`\`${where}\` must be an object.`);
      const named = RESERVED_BODY.filter((k) => Object.hasOwn(body, k));
      if (named.length) bad(`\`${where}\` names ${named.map((k) => `\`${k}\``).join(', ')}, which Reins sets itself. A body cannot change the model, the messages, the tools or the stream settings.`);
    };
    checkBody('body', raw.body);

    // A price is USD per million tokens: a number that is not negative and not NaN or infinite, or the money guard would compare against NaN.
    const money = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    const checkPrice = (where: string, price: unknown, needOutput: boolean) => {
      if (!isObj(price)) return bad(`\`${where}\` must be { "input": ..., "output": ... }, numbers of USD per million tokens.`);
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) {
        const v = price[k];
        if (v === undefined ? k === 'input' || (k === 'output' && needOutput) : !money(v)) {
          bad(v === undefined ? `\`${where}.${k}\` is missing; a price needs ${needOutput ? 'both input and output' : 'input'}.` : `\`${where}.${k}\` must be a number of 0 or more (got ${show(v)}).`);
        }
      }
    };
    if (raw.price !== undefined) checkPrice('price', raw.price, true);
    if (raw.cacheWritePerInput !== undefined && !money(raw.cacheWritePerInput)) bad(`\`cacheWritePerInput\` must be a number of 0 or more (got ${show(raw.cacheWritePerInput)}).`);

    // Names the picker and the cards show must read as they are: no control, line-break, direction or zero-width character (the same check
    // every shown text gets: `hasHiddenChars`). The value is written in \u form so the line says what it really holds.
    const shown = (where: string, v: unknown) => {
      if (typeof v === 'string' && hasHiddenChars(v)) bad(`${where} must not hold a control, line-break or direction-changing character (a zero-width one too); it holds "${plain(v)}".`);
    };
    shown('label', raw.label);
    shown('defaultModel', raw.defaultModel);
    if (Array.isArray(raw.efforts)) {
      for (const e of raw.efforts) {
        if (full()) break;
        if (isObj(e)) { shown('efforts.id', e.id); shown('efforts.label', e.label); checkBody(`efforts.${typeof e.id === 'string' ? cap(e.id) : '?'}.body`, e.body); }
      }
    }

    const ids = new Set<string>();
    if (!Array.isArray(raw.models)) bad('`models` must be a list.');
    else {
      for (const m of raw.models) {
        if (full()) break;
        if (!isObj(m) || !isStr(m.id)) bad('every entry of `models` needs an `id`.');
        else if (ids.has(m.id)) bad(`\`models\` lists \`${cap(m.id)}\` twice.`);
        else {
          ids.add(m.id);
          shown('models.id', m.id);
          shown('models.label', m.label);
          checkBody(`models.${cap(m.id)}.body`, m.body);
          if (m.price !== undefined) checkPrice(`models.${cap(m.id)}.price`, m.price, false);
        }
      }
      if (isStr(raw.defaultModel) && !ids.has(raw.defaultModel)) bad(`\`defaultModel\` \`${cap(raw.defaultModel)}\` is not in \`models\`.`);
    }
    if (!isStr(raw.defaultModel)) bad('`defaultModel` is missing.');
    return out;
  },
});

// Block, condition and card mods put a thing in core. They are code mods, and `provides` is the list of what the api will let them register.
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const MAX_NAMES = 50;
const MAX_VIEW = 32 * 1024;
const MAX_VIEW_LIST = 50;

/** A condition or card mod is code: it needs `main`. */
const codeProblems = (raw: Record<string, unknown>, id: string): Problem[] => (typeof raw.main === 'string' ? [] : [`\`${id}\`: a ${String(raw.kind)} mod needs code (\`main\`).`]);

/** The checks the kinds share: a finite `order`, and a `provides` of known keys holding lists of names (`need` must be non-empty). */
function providesProblems(raw: Record<string, unknown>, id: string, keys: string[], need: string): Problem[] {
  const out: Problem[] = [];
  const bad = (msg: string) => out.push(`\`${id}\`: ${msg}`);
  if (typeof raw.order !== 'number' || !Number.isFinite(raw.order)) bad(`\`order\` must be a number (got ${show(raw.order)}).`);
  const p = raw.provides;
  if (!isObj(p)) {
    bad('`provides` must be an object listing what the mod adds.');
    return out;
  }
  for (const k of Object.keys(p)) if (!keys.includes(k)) bad(`\`provides.${cap(k)}\` is not something a ${String(raw.kind)} mod can add. It can add: ${keys.join(', ')}.`);
  for (const k of keys) {
    const v = p[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length > MAX_NAMES || !v.every((x) => typeof x === 'string' && NAME.test(x))) bad(`\`provides.${k}\` must be a list of at most ${MAX_NAMES} names (letters, digits, dash and underscore, starting with a letter).`);
    else if (new Set(v).size !== v.length) bad(`\`provides.${k}\` lists a name twice.`);
  }
  if (!out.length && !(p[need] as string[] | undefined)?.length) bad(`\`provides.${need}\` lists nothing.`);
  return out.slice(0, MAX_PROBLEMS);
}

/** Every string in a JSON value, keys included, to a depth the manifest check already bounded. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) strings(x, strings(k, out));
  return out;
}

/** The view of a block: an object whose `kind` the mod provides, with `fields` and `line`, small, and no shown text with a hidden character. */
function viewProblems(raw: Record<string, unknown>, id: string): Problem[] {
  const bad = (msg: string): Problem[] => [`\`${id}\`: ${msg}`];
  const v = raw.view;
  if (!isObj(v)) return bad('`view` must be an object.');
  if (JSON.stringify(v).length > MAX_VIEW) return bad(`\`view\` is larger than ${MAX_VIEW / 1024} KB.`);
  const kinds = (raw.provides as { kinds?: string[] }).kinds ?? [];
  if (typeof v.kind !== 'string' || !kinds.includes(v.kind)) return bad('`view.kind` must be one of `provides.kinds`.');
  if (!Array.isArray(v.fields) || !Array.isArray(v.line)) return bad('`view` needs `fields` and `line`.');
  if (v.fields.length > MAX_VIEW_LIST || v.line.length > MAX_VIEW_LIST) return bad(`\`view.fields\` and \`view.line\` hold at most ${MAX_VIEW_LIST} entries.`);
  if (v.fresh !== undefined && !isObj(v.fresh)) return bad('`view.fresh` must be an object.');
  if (v.order !== undefined && (typeof v.order !== 'number' || !Number.isFinite(v.order))) return bad('`view.order` must be a number.');
  if (strings(v).some(hasHiddenChars)) return bad('a text in `view` holds a control, line-break or direction-changing character (a zero-width one too).');
  return [];
}

/** The block's view, from the manifest, recorded under its kind. Nothing is run to get it. */
const recordView = (mod: LoadedMod, host: ModHost) => {
  const view = (mod.manifest as { view: { kind: string } }).view;
  return host.registry.register('block-view', view.kind, view);
};

registerKind({
  id: 'condition',
  startOnly: true,
  validate: (raw, { id }) => [...codeProblems(raw, id), ...providesProblems(raw, id, ['conditions'], 'conditions')],
  activate: record,
});

registerKind({
  id: 'card',
  startOnly: true,
  validate: (raw, { id }) => [...codeProblems(raw, id), ...providesProblems(raw, id, ['cards'], 'cards')],
  activate: record,
});

const BLOCK_KEYS = ['kinds', 'ops', 'attrs', 'events'];
const MAX_TURN = 4 * 1024; // bytes
const MAX_STATUS = 200;

/** A block is code (`main`) or a data block (`turn`, no code): one of the two, never both. */
function shapeProblems(raw: Record<string, unknown>, id: string): Problem[] {
  if (raw.main !== undefined && raw.turn !== undefined) return [`\`${id}\`: a block has code (\`main\`) or a \`turn\`, not both.`];
  if (raw.main === undefined && raw.turn === undefined) return [`\`${id}\`: a block mod needs code (\`main\`). A block with no code needs a \`turn\` instead.`];
  return [];
}

/**
 * A data block has no code, so no `ops`; it adds one kind; its `turn` names only attributes it lists; and nothing in its manifest sets its policy:
 * that is the step's (`policyOf`). A line break is allowed in the prompt, since a template is several lines; no other hidden character is.
 */
function dataProblems(raw: Record<string, unknown>, id: string): Problem[] {
  const bad = (msg: string): Problem[] => [`\`${id}\`: ${msg}`];
  const out = providesProblems(raw, id, BLOCK_KEYS, 'kinds');
  if (out.length) return out;
  const p = raw.provides as Provides;
  if (p.kinds!.length !== 1) return bad('a data block adds one kind: `provides.kinds` lists exactly one.');
  if (p.ops?.length) return bad('a data block has no code, so it adds no ops: `provides.ops` must be empty.');
  const set = ['policy', 'mode', 'allowShell', 'tools'].filter((k) => raw[k] !== undefined);
  if (set.length) return bad(`a data block cannot set ${set.map((k) => `\`${k}\``).join(', ')}: its policy is the step's (\`mode: read-only\` in the workflow), never the manifest.`);
  const turn = raw.turn;
  if (typeof turn !== 'string') return bad('`turn` must be text.');
  if (Buffer.byteLength(turn) > MAX_TURN) return bad('`turn` is larger than 4 KB.');
  if (hasHiddenChars(turn.replaceAll('\n', ''))) return bad('`turn` holds a control, direction-changing or zero-width character; only a line break is allowed.');
  const attrs = p.attrs ?? [];
  const named = turnNames(turn).find((n) => !attrs.includes(n));
  if (named !== undefined) return bad(`\`turn\` names {${plain(named)}}, which is not in \`provides.attrs\`.`);
  const status = raw.statusLine;
  if (status !== undefined && (typeof status !== 'string' || status.length > MAX_STATUS || hasHiddenChars(status))) {
    return bad(`\`statusLine\` must be one line of at most ${MAX_STATUS} characters, with no hidden character.`);
  }
  return [];
}

registerKind({
  id: 'block',
  after: ['condition', 'card'],
  startOnly: true,
  validate(raw, { id }) {
    const shape = shapeProblems(raw, id);
    if (shape.length) return shape;
    const out = raw.turn === undefined ? providesProblems(raw, id, BLOCK_KEYS, 'kinds') : dataProblems(raw, id);
    return out.length ? out : viewProblems(raw, id);
  },
  // The view is known before the code runs and before trust, so the server can show it and the import summary can list it.
  preview: recordView,
  // A data block has no code: its node is built from the manifest here, and registered through the api a code mod's activate gets (so it is checked and guarded the same way).
  data(raw) {
    const p = raw.provides as Provides;
    const node = dataBlock({ kind: p.kinds![0]!, attrs: p.attrs ?? [], turn: raw.turn as string, statusLine: raw.statusLine as string | undefined });
    return (api) => { api.registerBlock(node); };
  },
  activate(mod, host) {
    const undoMod = record(mod, host);
    let undoView: () => void;
    try {
      undoView = recordView(mod, host);
    } catch (e) {
      undoMod();
      throw e;
    }
    return () => { undoView(); undoMod(); };
  },
});
