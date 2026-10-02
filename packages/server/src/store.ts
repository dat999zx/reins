import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RunEventRecord, RunSnapshot } from '@reins/core';

export const defaultStorePath = () => path.join(os.homedir(), '.reins', 'reins.db');

export type Store = ReturnType<typeof openStore>;

export interface SessionRow {
  id: string; cwd: string; engine: string; model?: string; effort?: string; title?: string;
  autoApprove: boolean; engineSessionId?: string; createdAt: number; updatedAt: number;
}
export interface LogRow { sessionId: string; seq: number; ts: number; runId?: string; type: string; data: unknown }

const toSession = (r: any): SessionRow => ({
  id: r.id, cwd: r.cwd, engine: r.engine,
  ...(r.model != null ? { model: r.model } : {}),
  ...(r.effort != null ? { effort: r.effort } : {}),
  ...(r.title != null ? { title: r.title } : {}),
  autoApprove: r.auto_approve === 1,
  ...(r.engine_session_id != null ? { engineSessionId: r.engine_session_id } : {}),
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const toLog = (r: any): LogRow => ({
  sessionId: r.session_id, seq: r.seq, ts: r.ts,
  ...(r.run_id != null ? { runId: r.run_id } : {}),
  type: r.type, data: JSON.parse(r.data),
});

const sessionColumns = { autoApprove: 'auto_approve', title: 'title', engineSessionId: 'engine_session_id' } as const;

/**
 * Runs and their event log, chat sessions and their timeline, and folder trust (plan 6.7, 15b 2.5, 15d 3b.3).
 * The snapshot is kept without its events, which live once, in the events table; loadRun puts them back.
 */
export function openStore(file: string) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('pragma journal_mode=WAL; pragma busy_timeout=5000');
  db.exec(`
    create table if not exists runs (
      id text primary key, workflow_path text not null, cwd text not null,
      created_at integer not null, snapshot text
    );
    create table if not exists events (
      run_id text not null, id text not null, ts integer not null, type text not null, data text,
      primary key (run_id, id)
    );
    create table if not exists sessions (
      id text primary key, cwd text not null, engine text not null, model text, effort text,
      title text, auto_approve integer not null default 0,
      engine_session_id text,
      created_at integer not null, updated_at integer not null
    );
    create table if not exists session_log (
      session_id text not null, seq integer not null, ts integer not null,
      run_id text, type text not null, data text,
      primary key (session_id, seq)
    );
    create table if not exists trust (
      cwd text not null, path text not null, hash text not null, ts integer not null,
      primary key (cwd, path)
    );
    create table if not exists editor_state (cwd text primary key, json text not null, ts integer not null);
    create index if not exists session_log_run on session_log(run_id);
  `);
  const insRun = db.prepare('insert into runs (id, workflow_path, cwd, created_at) values (?, ?, ?, ?)');
  const insEvent = db.prepare('insert into events (run_id, id, ts, type, data) values (?, ?, ?, ?, ?)');
  const setSnap = db.prepare('update runs set snapshot = ? where id = ?');
  const getRun = db.prepare('select workflow_path, cwd, snapshot from runs where id = ?');
  const getEvents = db.prepare('select id, ts, type, data from events where run_id = ? order by rowid');
  const insSession = db.prepare('insert into sessions (id, cwd, engine, model, effort, title, auto_approve, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 0, ?, ?)');
  const getSession = db.prepare('select * from sessions where id = ?');
  const listSessions = db.prepare('select * from sessions order by created_at, rowid');
  const maxSeq = db.prepare('select max(seq) as m from session_log where session_id = ?');
  const insLog = db.prepare('insert into session_log (session_id, seq, ts, run_id, type, data) values (?, ?, ?, ?, ?, ?)');
  const getLog = db.prepare('select * from session_log where session_id = ? and seq > ? order by seq');
  const runOwner = db.prepare('select session_id from session_log where run_id = ? limit 1');
  const getTrust = db.prepare('select 1 as ok from trust where cwd = ? and path = ? and hash = ?');
  const putTrust = db.prepare('insert or replace into trust (cwd, path, hash, ts) values (?, ?, ?, ?)');
  const getEditor = db.prepare('select json from editor_state where cwd = ?');
  const putEditor = db.prepare('insert or replace into editor_state (cwd, json, ts) values (?, ?, ?)');
  const seqs = new Map<string, number>();

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
    createSession(s: { id: string; cwd: string; engine: string; model?: string; effort?: string; title?: string }): SessionRow {
      const now = Date.now();
      insSession.run(s.id, s.cwd, s.engine, s.model ?? null, s.effort ?? null, s.title ?? null, now, now);
      return toSession(getSession.get(s.id));
    },
    getSession(id: string): SessionRow | undefined {
      const r = getSession.get(id);
      return r ? toSession(r) : undefined;
    },
    listSessions(): SessionRow[] {
      return listSessions.all().map(toSession);
    },
    updateSession(id: string, patch: { autoApprove?: boolean; title?: string; engineSessionId?: string }) {
      const sets: string[] = ['updated_at = ?'];
      const vals: Array<string | number> = [Date.now()];
      for (const k of Object.keys(sessionColumns) as Array<keyof typeof sessionColumns>) {
        const v = patch[k];
        if (v === undefined) continue;
        sets.push(`${sessionColumns[k]} = ?`);
        vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
      }
      db.prepare(`update sessions set ${sets.join(', ')} where id = ?`).run(...vals, id);
    },
    appendLog(sessionId: string, row: { type: string; runId?: string; data?: unknown }): LogRow {
      const seq = (seqs.get(sessionId) ?? ((maxSeq.get(sessionId) as any).m ?? 0)) + 1;
      const ts = Date.now();
      insLog.run(sessionId, seq, ts, row.runId ?? null, row.type, JSON.stringify(row.data ?? null));
      seqs.set(sessionId, seq);
      return { sessionId, seq, ts, ...(row.runId ? { runId: row.runId } : {}), type: row.type, data: row.data ?? null };
    },
    readLog(sessionId: string, after = 0): LogRow[] {
      return getLog.all(sessionId, after).map(toLog);
    },
    sessionOfRun(runId: string): string | undefined {
      return (runOwner.get(runId) as any)?.session_id;
    },
    isTrusted(cwd: string, p: string, hash: string): boolean {
      return getTrust.get(cwd, p, hash) !== undefined;
    },
    trust(cwd: string, p: string, hash: string) {
      putTrust.run(cwd, p, hash, Date.now());
    },
    getEditorState(cwd: string): string | undefined {
      return (getEditor.get(cwd) as { json: string } | undefined)?.json;
    },
    putEditorState(cwd: string, json: string) {
      putEditor.run(cwd, json, Date.now());
    },
    close() {
      db.close();
    },
  };
}
