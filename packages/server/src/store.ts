import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RunEventRecord, RunSnapshot } from '@reins/core';

export const defaultStorePath = () => path.join(os.homedir(), '.reins', 'reins.db');

export type Store = ReturnType<typeof openStore>;

/**
 * Runs and their append-only event log (plan 6.7, 15b 2.5). The snapshot is kept without its
 * events, which live once, in the events table; loadRun puts them back.
 */
export function openStore(file: string) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    create table if not exists runs (
      id text primary key, workflow_path text not null, cwd text not null,
      created_at integer not null, snapshot text
    );
    create table if not exists events (
      run_id text not null, id text not null, ts integer not null, type text not null, data text,
      primary key (run_id, id)
    );
  `);
  const insRun = db.prepare('insert into runs (id, workflow_path, cwd, created_at) values (?, ?, ?, ?)');
  const insEvent = db.prepare('insert into events (run_id, id, ts, type, data) values (?, ?, ?, ?, ?)');
  const setSnap = db.prepare('update runs set snapshot = ? where id = ?');
  const getRun = db.prepare('select workflow_path, cwd, snapshot from runs where id = ?');
  const getEvents = db.prepare('select id, ts, type, data from events where run_id = ? order by rowid');

  return {
    createRun(r: { id: string; workflowPath: string; cwd: string }) {
      insRun.run(r.id, r.workflowPath, r.cwd, Date.now());
    },
    appendEvent(runId: string, ev: RunEventRecord) {
      insEvent.run(runId, ev.id, ev.timestamp, ev.type, JSON.stringify(ev.data ?? null));
    },
    saveSnapshot(runId: string, snap: RunSnapshot) {
      setSnap.run(JSON.stringify({ ...snap, events: [] }), runId);
    },
    loadRun(runId: string): { workflowPath: string; cwd: string; snapshot: RunSnapshot } | undefined {
      const row = getRun.get(runId) as { workflow_path: string; cwd: string; snapshot: string | null } | undefined;
      if (!row?.snapshot) return undefined;
      const events = (getEvents.all(runId) as Array<{ id: string; ts: number; type: string; data: string }>).map(
        (e): RunEventRecord => ({ id: e.id, timestamp: e.ts, type: e.type as RunEventRecord['type'], data: JSON.parse(e.data) })
      );
      return { workflowPath: row.workflow_path, cwd: row.cwd, snapshot: { ...JSON.parse(row.snapshot), events } };
    },
    close() {
      db.close();
    },
  };
}
