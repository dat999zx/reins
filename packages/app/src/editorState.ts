import { get, put } from './api.js';
import { clampZoom, type Cam, type Pt } from './surface.js';

export type { Pt };
export type Layout = { script?: Pt };
export type CanvasView = Layout & { cam?: Cam };
export type Tab = 'chat' | 'blocks' | 'text';
const TABS: readonly Tab[] = ['chat', 'blocks', 'text'];
export interface EditorState {
  workflow?: string; tab?: Tab; stepId?: string;
  canvas?: Record<string /* absolute workflow path */, CanvasView>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ponytail: canvas entries of deleted workflows are never pruned; each entry is a camera and a point, so the 64 KB server cap is far away. Prune paths missing from the workflow list on load if it bites
function cleanCanvas(raw: unknown): CanvasView {
  const out: CanvasView = {};
  if (!isObj(raw)) return out;
  const { cam, script } = raw;
  if (isObj(cam) && num(cam.x) && num(cam.y) && num(cam.zoom) && cam.zoom > 0) out.cam = { x: cam.x, y: cam.y, zoom: clampZoom(cam.zoom) };
  if (isObj(script) && num(script.x) && num(script.y)) out.script = { x: script.x, y: script.y };
  return out;
}

export function cleanEditorState(raw: unknown): EditorState {
  if (!isObj(raw)) return {};
  const out: EditorState = {};
  if (typeof raw.workflow === 'string') out.workflow = raw.workflow;
  const tab = raw.tab === 'canvas' || raw.tab === 'map' ? 'blocks' : raw.tab;
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
