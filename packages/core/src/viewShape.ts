import { showText } from './display.js';
import type { Field, KindView, StatusState } from './nodes/fields.js';

// The one check of what a served block view may hold. The server runs it on a mod's manifest (with `mod`: what the mod provides), the app on
// every entry it is served (without), so a view that got through is still harmless in the page. Browser-safe: `import type` lines and display.ts only.
// Each table lists every member of its type (a `Record` over the union), so a new colour or input is a compile error here until it is added.
const COLOURS: Record<KindView['colour'], 1> = { soft: 1, hard: 1, gate: 1, loop: 1, verify: 1, hand: 1, mem: 1, mine: 1 };
const INPUTS: Record<Field['input'], 1> = { text: 1, mono: 1, textarea: 1, number: 1, mode: 1, step: 1, model: 1, effort: 1 };
const CHECKS: Record<NonNullable<Field['check']>, 1> = { count: 1, usd: 1 };
const ICONS: Record<NonNullable<KindView['icon']>, 1> = { round: 1 };
const SLICES: Record<NonNullable<KindView['slice']>, 1> = { opens: 1, own: 1 };
const GROUPS: Record<NonNullable<KindView['group']>, 1> = { kids: 1, 'kids+else': 1 };
const SECTIONS: Record<NonNullable<KindView['card']>['section'], 1> = { Flow: 1, Memory: 1 };
/** The classes a view's feed row may carry. The app keeps the same list (BlockRow.tsx); a test pins them equal. */
export const ROW_CLASSES: readonly string[] = ['sx-sub', 'faint'];
/** The event types core logs: a mod's row never covers one of these. (Not a `Record<keyof RunEvents, 1>`: other files merge their own names into that interface; a test pins this list to its source.) */
export const CORE_EVENTS: Record<string, 1> = {
  run_started: 1, run_paused: 1, run_resumed: 1, run_stopped: 1, run_finished: 1, turn_started: 1, turn_ended: 1, step_started: 1, command_result: 1,
  tool_call: 1, refusal: 1, card_queued: 1, card_delivered: 1, gate_approved: 1,
  link_jump: 1, link_budget_exceeded: 1, budget_warning: 1, engine_cost: 1, budget_reached: 1,
  subagent_started: 1, subagent_result: 1, hook: 1, judge: 1, track_started: 1, track_ended: 1,
};
export const isCoreEvent = (type: string): boolean => Object.hasOwn(CORE_EVENTS, type);
/** True when `view` may carry a row for `type`: any event core does not log, or a core event the view lists in its own `coreRows` (the server lets only a pack block list one). */
export const mayRow = (type: string, view: { coreRows?: unknown }): boolean => !isCoreEvent(type) || (Array.isArray(view.coreRows) && view.coreRows.includes(type));
/**
 * What a user mod that takes the place of a built-in may say of the two things only the pack may say: `stops` and `coreRows`. No more than the built-in's own
 * view says (`was`); less is fine. A Customize copy is a byte copy, so it passes. The one rule for the loader (when it reads the manifest) and the server
 * (when it serves the view).
 */
export function copyViewProblem(v: { stops?: unknown; coreRows?: unknown }, was: { stops?: unknown; coreRows?: unknown } | undefined): string | undefined {
  if (v.stops !== undefined && was?.stops !== true) return '`view.stops` is not in the built-in this mod replaces; a copy may say only what the built-in says.';
  if (v.coreRows !== undefined && !(Array.isArray(v.coreRows) && v.coreRows.every((t) => Array.isArray(was?.coreRows) && was.coreRows.includes(t)))) return '`view.coreRows` lists an event the built-in this mod replaces does not list; a copy may say only what the built-in says.';
  return undefined;
}

export const MAX_VIEW_LIST = 50;
export const MAX_ROW_TEXT = 200;
export const MAX_ROW_DETAILS = 400;
const VIEW_KEYS = ['kind', 'order', 'colour', 'icon', 'slice', 'group', 'fails', 'manyNext', 'stops', 'coreRows', 'against', 'cards', 'fields', 'line', 'card', 'sub', 'fresh', 'rows', 'status', 'hidden'];
const STATES: Record<StatusState, 1> = { active: 1, done: 1, waiting: 1, stuck: 1, failed: 1 };
const RULE_KEYS = ['when', 'step', 'state', 'why', 'attempts', 'cursor', 'gate', 'opens', 'label'];
const MAX_WORDS = 8;
const MAX_IS = 8;
/** An event or data name: letters, digits, dash and underscore; never one every JavaScript object has. */
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const goodName = (v: unknown): v is string => typeof v === 'string' && NAME.test(v) && !(v in Object.prototype) && v !== 'prototype';
const FIELD_KEYS = ['key', 'label', 'input', 'error', 'inherits', 'ph', 'required', 'check', 'unset'];

/** What the mod providing the view may use (its `provides`). Without it the view is core's or one the server already checked. */
export interface ViewScope { mod?: { attrs: readonly string[]; events: readonly string[]; /** A block of the default pack, or a copy of one: its `fresh` may hold a condition. */ pack?: true }; served?: true }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown, n = MAX_ROW_TEXT): v is string => typeof v === 'string' && v !== '' && v.length <= n;
const inSet = (set: object, v: unknown): boolean => typeof v === 'string' && Object.hasOwn(set, v);
const name = (v: unknown) => `\`${showText(typeof v === 'string' ? v.slice(0, 40) : String(typeof v))}\``;
const oneOf = (set: object) => Object.keys(set).join(', ');
const extraKey = (e: Record<string, unknown>, allowed: string[]) => Object.keys(e).find((k) => !allowed.includes(k));

const when = (w: unknown, at: string): string | undefined => {
  if (!isObj(w) || extraKey(w, ['key', 'is']) !== undefined || !goodName(w.key)) return `${at} must be { "key": a data name, "is": a list of values }.`;
  if (!Array.isArray(w.is) || w.is.length < 1 || w.is.length > MAX_IS) return `${at} needs an \`is\` list of 1 to ${MAX_IS} values.`;
  if (!w.is.every((x) => (typeof x === 'string' && x.length <= 40) || (typeof x === 'number' && Number.isFinite(x)) || typeof x === 'boolean')) return `${at} has an \`is\` value that is not short text, a number or true or false.`;
  return undefined;
};

/** An event a view names in `status` or `hidden`: a plain name, one the mod provides, and never one core logs (for a mod). */
function eventProblem(type: unknown, at: string, mod: ViewScope['mod']): string | undefined {
  if (!goodName(type)) return `${at} names an event with a bad name (letters, digits, dash and underscore, starting with a letter).`;
  if (mod && isCoreEvent(type)) return `${at} is an event core logs, and a mod's view cannot cover it.`;
  if (mod && !mod.events.includes(type)) return `${at} is not in \`provides.events\`.`;
  return undefined;
}

function ruleProblem(r: unknown, at: string): string | undefined {
  if (!isObj(r)) return `${at} must be an object.`;
  const bad = extraKey(r, RULE_KEYS);
  if (bad !== undefined) return `${at} has ${name(bad)}, which is not part of a status rule (${RULE_KEYS.join(', ')}).`;
  if (r.when !== undefined) { const p = when(r.when, `${at}.when`); if (p) return p; }
  if (r.step !== undefined && r.step !== 'track') return `${at}.step must be "track", or left out.`;
  if (r.state !== undefined && !inSet(STATES, r.state)) return `${at}.state is ${name(r.state)}. It must be one of ${oneOf(STATES)}.`;
  for (const k of ['cursor', 'gate', 'opens'] as const) if (r[k] !== undefined && r[k] !== true) return `${at}.${k} must be true, or left out.`;
  if (r.attempts !== undefined && !goodName(r.attempts)) return `${at}.attempts must be a data name.`;
  const y = r.why;
  if (y !== undefined && typeof y !== 'string') {
    if (!isObj(y) || extraKey(y, ['key', 'words', 'add']) !== undefined || !goodName(y.key) || (y.add !== undefined && !goodName(y.add))) return `${at}.why must be text or { "key": a data name, "words": ..., "add": a data name }.`;
    if (!isObj(y.words) || Object.keys(y.words).length < 1 || Object.keys(y.words).length > MAX_WORDS) return `${at}.why.words must be an object of 1 to ${MAX_WORDS} words.`;
    for (const [k, w] of Object.entries(y.words)) if (!goodName(k) || !isText(w, 40)) return `${at}.why.words has an entry that is not a name and short text.`;
  } else if (y !== undefined && !isText(y)) return `${at}.why must be text of 1 to ${MAX_ROW_TEXT} characters.`;
  if (r.label !== undefined) {
    const l = r.label;
    if (!isObj(l) || extraKey(l, ['model', 'name', 'when']) !== undefined || !goodName(l.model) || !goodName(l.name)) return `${at}.label must be { "model": a data name, "name": a data name }.`;
    if (l.when !== undefined) { const p = when(l.when, `${at}.label.when`); if (p) return p; }
  }
  return undefined;
}

/** What is wrong with the first thing in a view, in words, or undefined when its whole shape is fine. */
export function viewShapeProblem(v: unknown, scope: ViewScope = {}): string | undefined {
  if (!isObj(v)) return '`view` must be an object.';
  const { mod } = scope;
  const extra = extraKey(v, scope.served ? [...VIEW_KEYS, 'trusted'] : VIEW_KEYS);
  if (extra !== undefined) return `\`view\` has ${name(extra)}, which is not part of a view (${VIEW_KEYS.join(', ')}).`;
  if (scope.served && v.trusted !== undefined && v.trusted !== false) return '`view.trusted` is only ever false.';  // What only a block of the default pack (or its Customize copy) may do: stop the workflow, draw the row of a core event. The server holds a mod's manifest to
  // it (`scope.mod.pack`) when it reads it and again when it serves the view; the app gets only views that passed, so a view with neither scope is not held to it.
  const packed = scope.mod ? scope.mod.pack === true : true;
  if (!isText(v.kind, 40)) return '`view.kind` must be a name.';
  if (v.order !== undefined && (typeof v.order !== 'number' || !Number.isFinite(v.order))) return '`view.order` must be a number.';
  for (const [k, set] of [['colour', COLOURS], ['icon', ICONS], ['slice', SLICES], ['group', GROUPS]] as const) {
    if (v[k] !== undefined && !inSet(set, v[k])) return `\`view.${k}\` is ${name(v[k])}. It must be one of ${oneOf(set)}.`;
  }
  for (const k of ['fails', 'manyNext', 'against', 'cards'] as const) if (v[k] !== undefined && v[k] !== true) return `\`view.${k}\` must be true, or left out.`;
  if (v.stops !== undefined && (v.stops !== true || !packed)) return '`view.stops` is only for a block of the default pack (its `end`); no other block can end the workflow.';
  if (v.coreRows !== undefined) {
    if (!packed) return '`view.coreRows` is only for a block of the default pack; no other view can draw the row of an event core logs.';
    if (!Array.isArray(v.coreRows) || v.coreRows.length > MAX_IS || !v.coreRows.every((t) => goodName(t) && isCoreEvent(t))) return `\`view.coreRows\` must be a list of up to ${MAX_IS} events core logs.`;
  }

  if (!Array.isArray(v.fields) || !Array.isArray(v.line)) return '`view` needs `fields` and `line`.';
  if (v.fields.length > MAX_VIEW_LIST || v.line.length > MAX_VIEW_LIST) return `\`view.fields\` and \`view.line\` hold at most ${MAX_VIEW_LIST} entries.`;
  const keys: unknown[] = [];
  for (const f of v.fields) {
    if (!isObj(f)) return '`view.fields` holds an entry that is not an object.';
    const at = `\`view.fields\` entry ${name(f.key)}`;
    const bad = extraKey(f, FIELD_KEYS);
    if (bad !== undefined) return `${at} has ${name(bad)}, which is not part of a field (${FIELD_KEYS.join(', ')}).`;
    if (!isText(f.key, 40) || !isText(f.label)) return `${at} needs a \`key\` and a \`label\` that are text.`;
    if (!inSet(INPUTS, f.input)) return `${at} has \`input\` ${name(f.input)}. It must be one of ${oneOf(INPUTS)}.`;
    if (mod && f.key !== 'title' && f.key !== 'prompt' && !mod.attrs.includes(f.key)) return `${at} is not in \`provides.attrs\` (nor title or prompt).`;
    for (const k of ['error', 'ph', 'unset'] as const) if (f[k] !== undefined && !isText(f[k])) return `${at} has a \`${k}\` that is not text.`;
    for (const k of ['inherits', 'required'] as const) if (f[k] !== undefined && f[k] !== true) return `${at} has a \`${k}\` that is not true.`;
    if (f.check !== undefined && !inSet(CHECKS, f.check)) return `${at} has \`check\` ${name(f.check)}. It must be one of ${oneOf(CHECKS)}.`;
    keys.push(f.key);
  }
  for (const t of v.line) {
    if (isObj(t)) {
      if (extraKey(t, ['field']) !== undefined || !keys.includes(t.field)) return `\`view.line\` has an entry that names a field this view does not have: ${name(t.field)}.`;
    } else if (!isText(t)) return '`view.line` entries are text or { "field": ... }.';
  }

  if (v.sub !== undefined && (typeof v.sub !== 'string' || v.sub.length > MAX_ROW_TEXT)) return `\`view.sub\` must be text of at most ${MAX_ROW_TEXT} characters.`;
  if (v.card !== undefined) {
    const c = v.card;
    if (!isObj(c) || extraKey(c, ['label', 'section']) !== undefined || !isText(c.label) || !inSet(SECTIONS, c.section)) {
      return `\`view.card\` must be { "label": text, "section": ${oneOf(SECTIONS)} }.`;
    }
  }
  if (v.fresh !== undefined) {
    const f = v.fresh;
    if (!isObj(f)) return '`view.fresh` must be an object.';
    const bad = extraKey(f, mod && !mod.pack ? ['title', 'prompt', 'attrs'] : ['title', 'prompt', 'attrs', 'cond']);
    if (bad !== undefined) return `\`view.fresh\` has ${name(bad)}; a new block may start with a ${mod && !mod.pack ? 'title, a prompt and attributes' : 'title, a prompt, attributes and a condition'} only.`;
    for (const k of ['title', 'prompt'] as const) if (f[k] !== undefined && typeof f[k] !== 'string') return `\`view.fresh.${k}\` must be text.`;
    if (f.cond !== undefined && !isObj(f.cond)) return '`view.fresh.cond` must be an object.';
    if (f.attrs !== undefined) {
      if (!isObj(f.attrs)) return '`view.fresh.attrs` must be an object of text values.';
      for (const [k, x] of Object.entries(f.attrs)) {
        if (typeof x !== 'string') return `\`view.fresh.attrs.${showText(k.slice(0, 40))}\` must be text.`;
        if (mod && !mod.attrs.includes(k)) return `\`view.fresh.attrs\` has ${name(k)}, which is not in \`provides.attrs\`.`;
      }
    }
  }
  if (v.rows !== undefined) {
    if (!isObj(v.rows)) return '`view.rows` must be an object with one entry for each event type.';
    for (const [type, r] of Object.entries(v.rows)) {
      const at = `\`view.rows.${showText(type.slice(0, 40))}\``;
      if (!isObj(r)) return `${at} must be an object.`;
      const bad = extraKey(r, ['text', 'details', 'className']);
      if (bad !== undefined) return `${at} has ${name(bad)}, which is not part of a row (text, details, className).`;
      if (typeof r.text !== 'string' || r.text.length > MAX_ROW_TEXT) return `${at} needs a \`text\` of at most ${MAX_ROW_TEXT} characters.`;
      if (r.details !== undefined && (typeof r.details !== 'string' || r.details.length > MAX_ROW_DETAILS)) return `${at} has a \`details\` that is not text of at most ${MAX_ROW_DETAILS} characters.`;
      if (r.className !== undefined && !ROW_CLASSES.includes(r.className as string)) return `${at} has \`className\` ${name(r.className)}. It must be one of ${ROW_CLASSES.join(', ')}.`;
      if ((mod || scope.served) && !mayRow(type, { coreRows: v.coreRows })) return `${at} is an event core logs, and a mod's row cannot cover it.`;
      if (mod && !isCoreEvent(type) && !mod.events.includes(type)) return `${at} is not in \`provides.events\`.`;
    }
  }
  if (v.status !== undefined) {
    if (!isObj(v.status)) return '`view.status` must be an object with one rule for each event type.';
    if (Object.keys(v.status).length > MAX_VIEW_LIST) return `\`view.status\` holds at most ${MAX_VIEW_LIST} rules.`;
    for (const [type, r] of Object.entries(v.status)) {
      const at = `\`view.status.${showText(type.slice(0, 40))}\``;
      const p = eventProblem(type, at, mod) ?? ruleProblem(r, at);
      if (p) return p;
    }
  }
  if (v.hidden !== undefined) {
    if (!Array.isArray(v.hidden) || v.hidden.length > MAX_VIEW_LIST) return `\`view.hidden\` must be a list of at most ${MAX_VIEW_LIST} event types.`;
    for (const type of v.hidden) {
      const p = eventProblem(type, `\`view.hidden\` entry ${name(type)}`, mod);
      if (p) return p;
    }
    if (new Set(v.hidden).size !== v.hidden.length) return '`view.hidden` lists an event twice.';
  }
  return undefined;
}
