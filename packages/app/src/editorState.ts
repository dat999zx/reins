import { get, put } from './api.js';

export type CanvasView = { view?: { x: number; y: number; zoom: number } };
export type Tab = 'chat' | 'blocks' | 'map' | 'text';
const TABS: readonly Tab[] = ['chat', 'blocks', 'map', 'text'];
export interface EditorState {
  workflow?: string; tab?: Tab; stepId?: string;
  canvas?: Record<string /* absolute workflow path */, CanvasView>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ponytail: canvas entries of deleted workflows are never pruned; each entry is only a viewport, so the 64 KB server cap is far away. Prune paths missing from the workflow list on load if it bites
function cleanCanvas(raw: unknown): CanvasView {
  const out: CanvasView = {};
  if (!isObj(raw)) return out;
  const v = raw.view;
  if (isObj(v) && num(v.x) && num(v.y) && num(v.zoom) && v.zoom > 0) out.view = { x: v.x, y: v.y, zoom: v.zoom };
  return out;
}

export function cleanEditorState(raw: unknown): EditorState {
  if (!isObj(raw)) return {};
  const out: EditorState = {};
  if (typeof raw.workflow === 'string') out.workflow = raw.workflow;
  const tab = raw.tab === 'canvas' ? 'blocks' : raw.tab;
  if (TABS.includes(tab as Tab)) out.tab = tab as Tab;
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
