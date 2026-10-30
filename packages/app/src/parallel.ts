import type { Sess, State } from './state.js';

/** A row of GET /api/parallel. */
export interface ParallelView { id: string; title: string; capUsd?: number; approve?: 'fence'; createdAt: number; tasks: Array<{ name: string; sessionId: string }> }

export type TaskState = 'running' | 'waiting' | 'paused' | 'done';

export const taskState = (s: Sess): TaskState =>
  s.status === 'running' ? 'running' : s.status === 'waiting' ? 'waiting' : s.status === 'idle' && s.detached.length ? 'paused' : 'done';

export const groupedIds = (runs: ParallelView[]): Set<string> => new Set(runs.flatMap((r) => r.tasks.map((t) => t.sessionId)));

export function parallelGroups(st: State, runs: ParallelView[]) {
  return [...runs].sort((a, b) => b.createdAt - a.createdAt).map((run) => {
    const sessions = run.tasks.flatMap((t) => st.sessions[t.sessionId] ?? []);
    const counts: Record<TaskState, number> = { running: 0, waiting: 0, paused: 0, done: 0 };
    for (const s of sessions) counts[taskState(s)]++;
    const cost = sessions.reduce((n, s) => n + s.cost, 0);
    const cap = run.capUsd;
    return { run, sessions, counts, cost, costUnknown: sessions.some((s) => s.costUnknown), ...(cap !== undefined ? { cap } : {}), over: cap !== undefined && cost >= cap - 1e-9 };
  });
}
