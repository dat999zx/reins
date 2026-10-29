import fs from 'node:fs';
import path from 'node:path';
import type { LogRow, ParallelRow, Store } from './store.js';

/** The rail's own sum (app/src/state.ts): turn_ended costs; a turn without a number, or an unknown cost, makes the total "at least". */
export function spentOf(rows: LogRow[]): { usd: number; unknown: boolean } {
  let usd = 0;
  let unknown = false;
  for (const row of rows) {
    const x = (row.data ?? {}) as { cost?: unknown; unknown?: unknown };
    if (row.type === 'turn_ended') {
      if (typeof x.cost === 'number') usd += x.cost;
      if (x.unknown === true || typeof x.cost !== 'number') unknown = true;
    } else if (row.type === 'engine_cost' && x.unknown === true) unknown = true;
  }
  return { usd, unknown };
}

// ponytail: scan of the list; index by session id at hundreds of runs.
export function runOfSession(store: Store, sessionId: string): ParallelRow | undefined {
  return store.listParallel().find((r) => r.tasks.some((t) => t.sessionId === sessionId));
}

/** The refusal words when the session's run has spent its cap, else undefined. */
export function capWords(store: Store, sessionId: string): string | undefined {
  const run = runOfSession(store, sessionId);
  if (!run || run.capUsd === undefined) return undefined;
  const spent = run.tasks.reduce((n, t) => n + spentOf(store.readLog(t.sessionId)).usd, 0);
  if (spent < run.capUsd - 1e-9) return undefined;
  return `The parallel run "${run.title}" has spent $${spent.toFixed(2)} of its $${run.capUsd.toFixed(2)} cap, so no new model call starts. Raise the cap in the rail, then Resume.`;
}

export function parallelSeam(store: Store): { fenced(sessionId: string): boolean; capWords(sessionId: string): string | undefined } {
  return {
    fenced: (id) => runOfSession(store, id) !== undefined,
    capWords: (id) => capWords(store, id),
  };
}

const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

export type ParallelBody = { title: string; repo: string; capUsd?: number; tasks: Array<{ name: string; dir: string }> };

export function checkBody(b: unknown): { value: ParallelBody } | { error: string } {
  const o = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
  if (typeof o.title !== 'string' || !o.title.trim()) return { error: 'title must be a non-empty string.' };
  if (typeof o.repo !== 'string' || !path.isAbsolute(o.repo)) return { error: 'repo must be an absolute path.' };
  if (o.capUsd !== undefined && (typeof o.capUsd !== 'number' || !Number.isFinite(o.capUsd) || o.capUsd <= 0)) return { error: 'capUsd must be a number above 0.' };
  if (!Array.isArray(o.tasks) || o.tasks.length === 0) return { error: 'tasks must be a non-empty array.' };
  const repo = norm(o.repo);
  const names = new Set<string>();
  const dirs = new Set<string>();
  const tasks: Array<{ name: string; dir: string }> = [];
  for (const t of o.tasks as unknown[]) {
    const { name, dir } = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim()) return { error: 'each task needs a non-empty name.' };
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return { error: `task ${name}: dir must be an absolute path.` };
    if (names.has(name)) return { error: `task name ${name} is used twice.` };
    const d = norm(dir);
    if (dirs.has(d)) return { error: `task ${name}: dir is used by another task.` };
    if (d === repo || repo.startsWith(d + path.sep)) return { error: `task ${name}: dir must not be the repo or contain it.` };
    names.add(name);
    dirs.add(d);
    tasks.push({ name, dir });
  }
  return { value: { title: o.title, repo: o.repo, ...(o.capUsd !== undefined ? { capUsd: o.capUsd } : {}), tasks } };
}

export const folderGone = (dir: string): boolean => !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory();

/** `null` clears the cap; a finite number above 0 sets it; anything else is an error string. */
export function usdOf(b: unknown): number | null | string {
  if (b === null) return null;
  return typeof b === 'number' && Number.isFinite(b) && b > 0 ? b : 'usd must be null or a number above 0.';
}
