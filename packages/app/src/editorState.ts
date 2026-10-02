import { get, put } from './api.js';

export interface EditorState { workflow?: string; tab?: 'chat' | 'text'; stepId?: string }

export function cleanEditorState(raw: unknown): EditorState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: EditorState = {};
  if (typeof r.workflow === 'string') out.workflow = r.workflow;
  if (r.tab === 'chat' || r.tab === 'text') out.tab = r.tab;
  if (typeof r.stepId === 'string') out.stepId = r.stepId;
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
