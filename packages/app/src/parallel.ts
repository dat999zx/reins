import type { Sess, State } from './state.js';

import { showText } from '../../core/src/display.js';

export type ParallelPhase = 'setup' | 'running' | 'merging' | 'gating' | 'done' | 'failed' | 'interrupted';

/** A row of GET /api/parallel. */
export interface ParallelView {
  id: string; title: string; capUsd?: number; approve?: 'fence'; createdAt: number; tasks: Array<{ name: string; sessionId: string }>;
  phase?: ParallelPhase;
  job?: {
    repo: string; branch: string; head: string; folder: string;
    install?: string; gate?: string; gateRetry?: string; reports?: string;
    tasks: Array<{ name: string; branch: string; dir: string; playbook: string; model?: string; effort?: string }>;
    words: string; merged: string[]; notMerged: Array<{ name: string; why: string }>;
    conflict?: { task: string; files: string[]; why: string }; gateResult: 'pass' | 'fail' | 'not run';
  };
}

/** The spec the server's preview returns and start takes back. */
export interface RunSpec { title: string; capUsd?: number; approve?: 'fence'; install?: string; gate?: string; gateRetry?: string; reports?: string; copy: string[]; tasks: Array<{ name: string; slug: string; playbook: string; model?: string; effort?: string }> }

export type TaskState = 'running' | 'waiting' | 'paused' | 'done';

export const taskState = (s: Sess): TaskState =>
  s.status === 'running' ? 'running' : s.status === 'waiting' ? 'waiting' : s.status === 'idle' && s.detached.length ? 'paused' : 'done';

export const busyPhase = (run: ParallelView): boolean => run.phase === 'setup' || run.phase === 'merging' || run.phase === 'gating';

export const PHASE_BADGE: Record<ParallelPhase, string> = { setup: 'active', running: '', merging: 'active', gating: 'active', done: 'done', failed: 'failed', interrupted: 'stopped' };

// A session missing from the map is not in `sessions`, so it counts as ended (spec P8).
export const canMerge = (run: ParallelView, sessions: Sess[]): boolean =>
  !!run.job && (run.phase === 'running' || run.phase === 'failed' || run.phase === 'interrupted') && run.tasks.length > 0 && sessions.every((s) => taskState(s) === 'done');
export const canClean = (run: ParallelView): boolean => !!run.job && (run.phase === 'done' || run.phase === 'failed' || run.phase === 'interrupted');
export const groupControls = (run: ParallelView, sessions: Sess[], c: Record<TaskState, number>, over: boolean) => ({
  stop: c.running + c.waiting > 0, resume: c.paused + c.waiting > 0, cap: !run.job || c.running + c.waiting + c.paused > 0 || over,
  merge: canMerge(run, sessions), clean: canClean(run),
});
export const countWords = (c: Record<TaskState, number>): string =>
  (['running', 'waiting', 'paused', 'done'] as const).filter((k) => c[k] > 0).map((k) => `${c[k]} ${k}`).join(' · ');

export const mergeWords = (run: ParallelView, sessions: Sess[]): string => {
  const lines = [`Merge into ${run.job?.branch ?? ''}, then run: ${run.job?.gate !== undefined ? showText(run.job.gate) : 'no gate'}?`];
  const never = sessions.filter((s) => taskState(s) === 'done' && !s.rows.some((r) => r.type === 'run_finished' || r.type === 'run_stopped')).length;
  if (never) lines.push(`${never} task(s) never ran and will not be merged.`);
  return lines.join('\n');
};

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
