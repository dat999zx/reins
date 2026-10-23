import { showText } from './display.js';
import type { Field, KindView } from './nodes/fields.js';

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
  tool_call: 1, refusal: 1, card_queued: 1, card_delivered: 1, gate_paused: 1, gate_approved: 1, loop_iteration: 1, loop_budget_exceeded: 1,
  link_jump: 1, link_budget_exceeded: 1, verify_result: 1, recall: 1, store: 1, budget_warning: 1, engine_cost: 1, model_switched: 1, budget_reached: 1,
  subagent_started: 1, subagent_result: 1, hook: 1, judge: 1, track_started: 1, track_ended: 1,
};
export const isCoreEvent = (type: string): boolean => Object.hasOwn(CORE_EVENTS, type);

export const MAX_VIEW_LIST = 50;
export const MAX_ROW_TEXT = 200;
export const MAX_ROW_DETAILS = 400;
/** The kind that ends the workflow: the only view that may say `stops`. */
const CAP = 'end';
const VIEW_KEYS = ['kind', 'order', 'colour', 'icon', 'slice', 'group', 'fails', 'manyNext', 'stops', 'against', 'cards', 'fields', 'line', 'card', 'sub', 'fresh', 'rows'];
const FIELD_KEYS = ['key', 'label', 'input', 'error', 'inherits', 'ph', 'required', 'check', 'unset'];

/** What the mod providing the view may use (its `provides`). Without it the view is core's or one the server already checked. */
export interface ViewScope { mod?: { attrs: readonly string[]; events: readonly string[] }; served?: true }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown, n = MAX_ROW_TEXT): v is string => typeof v === 'string' && v !== '' && v.length <= n;
const inSet = (set: object, v: unknown): boolean => typeof v === 'string' && Object.hasOwn(set, v);
const name = (v: unknown) => `\`${showText(typeof v === 'string' ? v.slice(0, 40) : String(typeof v))}\``;
const oneOf = (set: object) => Object.keys(set).join(', ');
const extraKey = (e: Record<string, unknown>, allowed: string[]) => Object.keys(e).find((k) => !allowed.includes(k));

/** What is wrong with the first thing in a view, in words, or undefined when its whole shape is fine. */
export function viewShapeProblem(v: unknown, scope: ViewScope = {}): string | undefined {
  if (!isObj(v)) return '`view` must be an object.';
  const { mod } = scope;
  const extra = extraKey(v, scope.served ? [...VIEW_KEYS, 'trusted'] : VIEW_KEYS);
  if (extra !== undefined) return `\`view\` has ${name(extra)}, which is not part of a view (${VIEW_KEYS.join(', ')}).`;
  if (scope.served && v.trusted !== undefined && v.trusted !== false) return '`view.trusted` is only ever false.';
  if (!isText(v.kind, 40)) return '`view.kind` must be a name.';
  if (v.order !== undefined && (typeof v.order !== 'number' || !Number.isFinite(v.order))) return '`view.order` must be a number.';
  for (const [k, set] of [['colour', COLOURS], ['icon', ICONS], ['slice', SLICES], ['group', GROUPS]] as const) {
    if (v[k] !== undefined && !inSet(set, v[k])) return `\`view.${k}\` is ${name(v[k])}. It must be one of ${oneOf(set)}.`;
  }
  for (const k of ['fails', 'manyNext', 'against', 'cards'] as const) if (v[k] !== undefined && v[k] !== true) return `\`view.${k}\` must be true, or left out.`;
  if (v.stops !== undefined && (v.stops !== true || mod || v.kind !== CAP)) return `\`view.stops\` is only for core's \`${CAP}\` block; a mod's block cannot end the workflow.`;

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
    const bad = extraKey(f, mod ? ['title', 'prompt', 'attrs'] : ['title', 'prompt', 'attrs', 'cond']);
    if (bad !== undefined) return `\`view.fresh\` has ${name(bad)}; a new block may start with a ${mod ? 'title, a prompt and attributes' : 'title, a prompt, attributes and a condition'} only.`;
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
      if (mod && isCoreEvent(type)) return `${at} is an event core logs, and a mod's row cannot cover it.`;
      if (mod && !mod.events.includes(type)) return `${at} is not in \`provides.events\`.`;
    }
  }
  return undefined;
}
