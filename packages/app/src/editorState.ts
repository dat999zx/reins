import type { Cond, LinkKind, Step } from '@reins/core';
import { get, put } from './api.js';
import { CARD_KINDS, KINDS } from './canvasKinds.js';
import { COND_KINDS } from './condKinds.js';
import { clampZoom, type Cam, type Pt } from './surface.js';

export type { Pt };
export type Loose = { key: string; at: Pt; step: Step }; // one subtree parked on the surface; never in the file
export type Layout = { script?: Pt; loose?: Loose[] };
export type CanvasView = Layout & { cam?: Cam };
export type Tab = 'chat' | 'blocks' | 'text';
const TABS: readonly Tab[] = ['chat', 'blocks', 'text'];
export interface EditorState {
  workflow?: string; tab?: Tab; stepId?: string;
  canvas?: Record<string /* absolute workflow path */, CanvasView>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const LOOSE_KEEP = 100; // LOOSE_MAX in arrange.ts; that module imports this one
const LINKS: readonly string[] = ['next', 'on-pass', 'on-fail', 'retry', 'verify-against', 'hand-off'] satisfies LinkKind[];
const str = (v: unknown): v is string => typeof v === 'string';

function cleanCond(c: unknown): c is Cond {
  if (!isObj(c) || !str(c.t)) return false;
  if (c.t === 'and' || c.t === 'or') return cleanCond(c.a) && cleanCond(c.b);
  return c.t === 'not' ? cleanCond(c.a) : c.t in COND_KINDS;
}

// A stored step that does not read back is undefined; the caller counts it.
export function cleanStep(raw: unknown, depth = 0): Step | undefined {
  if (!isObj(raw) || depth > 20 || !str(raw.id) || raw.id === '' || !str(raw.kind) || !(raw.kind in KINDS)) return undefined;
  const kind = raw.kind as Step['kind'], group = KINDS[kind].group;
  if (!isObj(raw.attrs) || !Object.values(raw.attrs).every(str)) return undefined;
  if ((raw.title !== undefined && !str(raw.title)) || (raw.prompt !== undefined && !str(raw.prompt))) return undefined;
  if (!Array.isArray(raw.cards) || !Array.isArray(raw.links)) return undefined;
  const cards = raw.cards.map((c) => (isObj(c) && str(c.kind) && CARD_KINDS.includes(c.kind as never) && str(c.text) ? { kind: c.kind as Step['cards'][number]['kind'], text: c.text } : undefined));
  const links = raw.links.map((l) => (isObj(l) && str(l.kind) && LINKS.includes(l.kind) && str(l.to) && (l.max === undefined || (typeof l.max === 'number' && Number.isInteger(l.max) && l.max > 0))
    ? { kind: l.kind as LinkKind, to: l.to, ...(l.max === undefined ? {} : { max: l.max as number }) } : undefined));
  if (cards.includes(undefined) || links.includes(undefined)) return undefined;
  if (raw.cond !== undefined && !cleanCond(raw.cond)) return undefined;
  const out: Step = { id: raw.id, kind, attrs: raw.attrs as Record<string, string>, cards: cards as Step['cards'], links: links as Step['links'] };
  if (raw.title !== undefined) out.title = raw.title as string;
  if (raw.prompt !== undefined) out.prompt = raw.prompt as string;
  if (raw.cond !== undefined) out.cond = raw.cond as Cond;
  for (const b of ['kids', 'else'] as const) {
    if (raw[b] === undefined) continue;
    if (!Array.isArray(raw[b]) || !group || (b === 'else' && group !== 'kids+else')) return undefined;
    const list = (raw[b] as unknown[]).map((k) => cleanStep(k, depth + 1));
    if (list.includes(undefined)) return undefined;
    out[b] = list as Step[];
  }
  return out;
}

// ponytail: canvas entries of deleted workflows are never pruned; each entry is a camera and a point, so the 64 KB server cap is far away. Prune paths missing from the workflow list on load if it bites
function cleanCanvas(raw: unknown, onDropped?: (n: number) => void): CanvasView {
  const out: CanvasView = {};
  if (!isObj(raw)) return out;
  const { cam, script, loose } = raw;
  if (isObj(cam) && num(cam.x) && num(cam.y) && num(cam.zoom) && cam.zoom > 0) out.cam = { x: cam.x, y: cam.y, zoom: clampZoom(cam.zoom) };
  if (isObj(script) && num(script.x) && num(script.y)) out.script = { x: script.x, y: script.y };
  if (Array.isArray(loose)) {
    const keys = new Set<string>(), list: Loose[] = [];
    let dropped = 0;
    for (const l of loose) {
      const step = isObj(l) ? cleanStep(l.step) : undefined;
      if (isObj(l) && step && str(l.key) && l.key !== '' && !keys.has(l.key) && isObj(l.at) && num(l.at.x) && num(l.at.y) && list.length < LOOSE_KEEP) {
        keys.add(l.key);
        list.push({ key: l.key, at: { x: l.at.x, y: l.at.y }, step });
      } else dropped++;
    }
    if (list.length) out.loose = list;
    if (dropped) onDropped?.(dropped);
  }
  return out;
}

export function cleanEditorState(raw: unknown, onDropped?: (n: number) => void): EditorState {
  if (!isObj(raw)) return {};
  const out: EditorState = {};
  if (typeof raw.workflow === 'string') out.workflow = raw.workflow;
  const tab = raw.tab === 'canvas' || raw.tab === 'map' ? 'blocks' : raw.tab;
  if (TABS.includes(tab as Tab)) out.tab = tab as Tab;
  if (typeof raw.stepId === 'string') out.stepId = raw.stepId;
  if (isObj(raw.canvas)) {
    out.canvas = {};
    for (const [path, entry] of Object.entries(raw.canvas)) if (isObj(entry)) out.canvas[path] = cleanCanvas(entry, onDropped);
  }
  return out;
}

export const loadEditorState = (cwd: string, onDropped?: (n: number) => void): Promise<EditorState> =>
  get<{ state: unknown }>(`/api/editor-state?cwd=${encodeURIComponent(cwd)}`).then((r) => cleanEditorState(r.state, onDropped), () => ({}));

// Absolute path, not the name: project and user scope can hold the same name.
export const restoreFile = (workflow: string | undefined, list: Array<{ path: string }>): string | undefined =>
  workflow === undefined ? undefined : list.find((w) => w.path === workflow)?.path;

export const restoreStep = (stepId: string | undefined, steps: Array<{ id: string }>): string | undefined =>
  stepId !== undefined && steps.some((s) => s.id === stepId) ? stepId : undefined;

type Put = (cwd: string, state: EditorState) => Promise<unknown>;
const realPut: Put = (cwd, state) => put('/api/editor-state', { cwd, state });

export function makeSaver(cwd: string, send: Put = realPut, delayMs = 500, onError?: (e: Error) => void) {
  let on = false;
  let state: EditorState = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    timer = undefined;
    // ponytail: a failed save is reported, not retried; the next change PUTs the full state again
    send(cwd, state).catch((e: Error) => onError?.(e));
  };
  return {
    ready(initial: EditorState) { on = true; state = { ...initial }; },
    set(patch: Partial<EditorState>) {
      if (!on) return;
      state = { ...state, ...patch };
      clearTimeout(timer);
      timer = setTimeout(fire, delayMs);
    },
    flush() {
      if (timer === undefined) return;
      clearTimeout(timer);
      fire();
    },
  };
}
