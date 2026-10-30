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

// A session missing from the map is not in `sessions`, so it counts as ended (spec P8).
export const mergeBlock = (run: ParallelView, sessions: Sess[]): string | undefined => {
  if (run.phase === 'setup') return 'Setup is running.';
  if (run.phase === 'merging' || run.phase === 'gating') return 'A merge is running.';
  if (run.phase === 'done') return 'Already merged.';
  if (run.tasks.length === 0) return 'Setup did not finish.';
  const n = sessions.filter((s) => taskState(s) !== 'done').length;
  return n ? `Waiting for ${n} task(s) to end. One stopped mid-turn waits on a resume card: press Stop all again, or Resume all.` : undefined;
};

export const cleanBlock = (run: ParallelView): string | undefined =>
  run.phase === 'setup' ? 'Setup is running.' : run.phase === 'running' ? 'Merge first.' : busyPhase(run) ? 'A merge is running.' : undefined;

export const mergeWords = (run: ParallelView, sessions: Sess[]): string => {
  const lines = [`Merge into ${run.job?.branch ?? ''}, then run: ${run.job?.gate !== undefined ? showText(run.job.gate) : 'no gate'}?`];
  const never = sessions.filter((s) => taskState(s) === 'done' && !s.rows.some((r) => r.type === 'run_finished' || r.type === 'run_stopped')).length;
  if (never) lines.push(`${never} task(s) never ran and will not be merged.`);
  if (run.phase === 'interrupted' && run.job?.words) lines.push(showText(run.job.words, { lines: true }));
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
