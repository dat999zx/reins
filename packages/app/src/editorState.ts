import { get, put } from './api.js';

export type CanvasView = { pos?: Record<string, { x: number; y: number }>; view?: { x: number; y: number; zoom: number } };
export interface EditorState {
  workflow?: string; tab?: 'chat' | 'text' | 'canvas'; stepId?: string;
  canvas?: Record<string /* absolute workflow path */, CanvasView>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ponytail: canvas entries of deleted workflows are never pruned; the server caps the state at 64 KB (~1,500 positions per folder), past that saves fail silently. Prune paths missing from the workflow list on load if it bites
function cleanCanvas(raw: unknown): CanvasView {
  const out: CanvasView = {};
  if (!isObj(raw)) return out;
  if (isObj(raw.pos)) {
    const pos: Record<string, { x: number; y: number }> = {};
    for (const [id, p] of Object.entries(raw.pos)) if (isObj(p) && num(p.x) && num(p.y)) pos[id] = { x: p.x, y: p.y };
    out.pos = pos;
  }
  const v = raw.view;
  if (isObj(v) && num(v.x) && num(v.y) && num(v.zoom) && v.zoom > 0) out.view = { x: v.x, y: v.y, zoom: v.zoom };
  return out;
}

export function prunePos(pos: Record<string, { x: number; y: number }>, ids: Set<string>): Record<string, { x: number; y: number }> {
  return Object.fromEntries(Object.entries(pos).filter(([id]) => ids.has(id)));
}

export function cleanEditorState(raw: unknown): EditorState {
  if (!isObj(raw)) return {};
  const out: EditorState = {};
  if (typeof raw.workflow === 'string') out.workflow = raw.workflow;
  if (raw.tab === 'chat' || raw.tab === 'text' || raw.tab === 'canvas') out.tab = raw.tab;
  if (typeof raw.stepId === 'string') out.stepId = raw.stepId;
  if (isObj(raw.canvas)) {
    out.canvas = {};
    for (const [path, entry] of Object.entries(raw.canvas)) if (isObj(entry)) out.canvas[path] = cleanCanvas(entry);
  }
  return out;
}

export const loadEditorState = (cwd: string): Promise<EditorState> =>
  get<{ state: unknown }>(`/api/editor-state?cwd=${encodeURIComponent(cwd)}`).then((r) => cleanEditorState(r.state), () => ({}));

// Absolute path, not the name: project and user scope can hold the same name.
export const restoreFile = (workflow: string | undefined, list: Array<{ path: string }>): string | undefined =>
  workflow === undefined ? undefined : list.find((w) => w.path === workflow)?.path;

export const restoreStep = (stepId: string | undefined, steps: Array<{ id: string }>): string | undefined =>
  stepId !== undefined && steps.some((s) => s.id === stepId) ? stepId : undefined;

type Put = (cwd: string, state: EditorState) => Promise<unknown>;
const realPut: Put = (cwd, state) => put('/api/editor-state', { cwd, state });

export function makeSaver(cwd: string, send: Put = realPut, delayMs = 500) {
  let on = false;
  let state: EditorState = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    timer = undefined;
    // ponytail: a failed save is dropped; the next change PUTs the full state again
    send(cwd, state).catch(() => {});
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
