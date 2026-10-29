import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RunEventRecord, RunSnapshot } from '@reins/core';
import { renamedProviders } from './mods/retired.js';
import type { Redactor } from './secrets.js';

export const defaultStorePath = () => path.join(os.homedir(), '.reins', 'reins.db');

export type Store = ReturnType<typeof openStore>;

export interface SessionRow {
  id: string; cwd: string; engine: string; model?: string; effort?: string; title?: string;
  autoApprove: boolean; engineSessionId?: string; createdAt: number; updatedAt: number;
}
export interface LogRow { sessionId: string; seq: number; ts: number; runId?: string; type: string; data: unknown }
export interface ParallelTask { name: string; sessionId: string }
export interface ParallelRow { id: string; title: string; capUsd?: number; createdAt: number; tasks: ParallelTask[] }

const toParallel = (r: any): ParallelRow => {
  let tasks: ParallelTask[] = [];
  try { const v = JSON.parse(r.tasks); if (Array.isArray(v)) tasks = v; } catch { /* a value that does not parse reads as no tasks */ }
  return { id: r.id, title: r.title, ...(r.cap_usd != null ? { capUsd: r.cap_usd } : {}), createdAt: r.created_at, tasks };
};

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

const sessionColumns = { autoApprove: 'auto_approve', title: 'title', engine: 'engine', engineSessionId: 'engine_session_id', model: 'model', effort: 'effort' } as const;

export const KEY_IN_IDENTITY = 'That value contains a saved key, so it was not saved.';
/** A write whose identity field (an id, a folder, a path) holds a known key. A route answers it with a plain 400, never a 500. */
export class KeyInIdentity extends Error {
  constructor() {
    super(KEY_IN_IDENTITY);
    this.name = 'KeyInIdentity';
  }
}

/**
 * The same store with a known secret kept out of everything it writes and everything it returns (spec 8.3).
 * Two kinds of field:
 * - Content (log text, event payloads, snapshots, titles, model and effort, setting values, editor text, the log and event `type`):
 *   redacted on the way in and on the way out.
 * - Identity (ids, run ids, engine session ids, cwd, workflow paths, trust paths and hashes, setting names, editor-state cwd, the
 *   keys of the per-model totals): never rewritten, because two different values would become the same placeholder and the store
 *   looks rows up by them. A write whose identity field holds a known secret is REFUSED (throws); a lookup argument is passed
 *   through unchanged, so it finds exactly what it names (nothing, for a secret-bearing value). A row that was written before
 *   the key was known and has a secret in an identity field is hidden from reads, not returned with a placeholder.
 * `appendLog` returns the row built from the redacted data, so the live stream carries what the database holds. Reads are
 * redacted with the secrets known NOW, so a key registered after a row was written does not leave through the REST log or the
 * SSE replay.
 * Known limit: the bytes already on disk (the database, its write-ahead log, free pages) from before a key was registered are not
 * scrubbed; only what is read back and what is written from now on is clean.
 */
export function redactingStore(store: Store, redactor: Pick<Redactor, 'redactJson' | 'has'>): Store {
  const { redactJson: r, has } = redactor;
  const holds = (...v: unknown[]) => v.some((x) => typeof x === 'string' && has(x));
  const refuse = (...v: unknown[]) => { if (holds(...v)) throw new KeyInIdentity(); };
  const session = (row: SessionRow | undefined) => (row && !holds(row.id, row.cwd, row.engine, row.engineSessionId) ? r(row) : undefined);
  const parallel = (row: ParallelRow) => (!holds(row.id, ...row.tasks.map((t) => t.sessionId)) ? r(row) : undefined);
  return {
    ...store,
    createRun: (run) => { refuse(run.id, run.workflowPath, run.cwd); store.createRun(run); },
    appendEvent: (runId, ev) => { refuse(runId, ev.id); store.appendEvent(runId, { ...ev, type: r(ev.type), data: r(ev.data) }); },
    saveSnapshot: (runId, snap) => { refuse(runId); store.saveSnapshot(runId, r({ ...snap, events: [] })); },
    loadRun: (runId) => {
      const run = store.loadRun(runId);
      return run && !holds(run.workflowPath, run.cwd) ? r(run) : undefined;
    },
    createSession: (s) => {
      refuse(s.id, s.cwd, s.engine);
      return r(store.createSession({
        ...s,
        ...(s.model !== undefined ? { model: r(s.model) } : {}),
        ...(s.effort !== undefined ? { effort: r(s.effort) } : {}),
        ...(s.title !== undefined ? { title: r(s.title) } : {}),
      }));
    },
    getSession: (id) => session(store.getSession(id)),
    listSessions: () => store.listSessions().flatMap((row) => { const s = session(row); return s ? [s] : []; }),
    updateSession: (id, patch) => {
      refuse(patch.engine, patch.engineSessionId);
      store.updateSession(id, {
        ...patch,
        ...(patch.title !== undefined ? { title: r(patch.title) } : {}),
        ...(typeof patch.model === 'string' ? { model: r(patch.model) } : {}),
        ...(typeof patch.effort === 'string' ? { effort: r(patch.effort) } : {}),
      });
    },
    appendLog: (sessionId, row) => { refuse(sessionId, row.runId); return store.appendLog(sessionId, { ...row, type: r(row.type), ...(row.data !== undefined ? { data: r(row.data) } : {}) }); },
    readLog: (sessionId, after) => r(store.readLog(sessionId, after)),
    sessionOfRun: (runId) => r(store.sessionOfRun(runId)),
    isTrusted: (cwd, p, hash) => store.isTrusted(cwd, p, hash),
    trust: (cwd, p, hash) => { refuse(cwd, p, hash); store.trust(cwd, p, hash); },
    hasConsent: (id, origin) => store.hasConsent(id, origin),
    grantConsent: (id, origin) => { refuse(id, origin); store.grantConsent(id, origin); },
    revokeConsent: (id) => store.revokeConsent(id),
    getEditorState: (cwd) => r(store.getEditorState(cwd)),
    putEditorState: (cwd, json) => { refuse(cwd); store.putEditorState(cwd, r(json)); },
    getSetting: (key) => r(store.getSetting(key)),
    putSetting: (key, value) => { refuse(key); store.putSetting(key, r(value)); },
    getEngineTotal: (id) => store.getEngineTotal(id),
    putEngineTotal: (id, total, byModel) => { refuse(id, ...Object.keys(byModel ?? {})); store.putEngineTotal(id, total, byModel); },
    getEngineModels: (id) => r(store.getEngineModels(id)),
    createParallel: (p) => {
      refuse(p.id, ...p.tasks.map((t) => t.sessionId));
      return parallel(store.createParallel({ ...p, title: r(p.title), tasks: p.tasks.map((t) => ({ ...t, name: r(t.name) })) }))!;
    },
    listParallel: () => store.listParallel().flatMap((row) => { const p = parallel(row); return p ? [p] : []; }),
    setParallelCap: (id, usd) => store.setParallelCap(id, usd),
    deleteParallel: (id) => store.deleteParallel(id),
  };
}

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
    create table if not exists consent (
      id text not null, origin text not null, ts integer not null,
      primary key (id, origin)
    );
    create table if not exists editor_state (cwd text primary key, json text not null, ts integer not null);
    create table if not exists settings (key text primary key, json text not null);
    create table if not exists engine_costs (engine_session_id text primary key, total real not null, ts integer not null);
    create index if not exists session_log_run on session_log(run_id);
    create table if not exists parallel_runs (id text primary key, title text not null, cap_usd real, tasks text not null, created_at integer not null);
  `);
  // C: the per-model running totals beside the total (a database made before C has no column).
  if (!(db.prepare('pragma table_info(engine_costs)').all() as Array<{ name: string }>).some((c) => c.name === 'by_model')) {
    db.exec('alter table engine_costs add column by_model text');
  }
  // P: a provider whose id changed keeps its sessions (their CLI session ids resume as before). `sessions.engine` is the only column that holds a
  // provider id. One transaction for all renames; a second open finds nothing to change.
  const rename = db.prepare('update sessions set engine = ? where engine = ?');
  db.exec('begin');
  try {
    for (const [from, to] of Object.entries(renamedProviders)) rename.run(to, from);
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
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
  const getConsent = db.prepare('select 1 as ok from consent where id = ? and origin = ?');
  const putConsent = db.prepare('insert or replace into consent (id, origin, ts) values (?, ?, ?)');
  const delConsent = db.prepare('delete from consent where id = ?');
  const getEditor = db.prepare('select json from editor_state where cwd = ?');
  const putEditor = db.prepare('insert or replace into editor_state (cwd, json, ts) values (?, ?, ?)');
  const getSettingRow = db.prepare('select json from settings where key = ?');
  const putSettingRow = db.prepare('insert or replace into settings (key, json) values (?, ?)');
  const getTotal = db.prepare('select total from engine_costs where engine_session_id = ?');
  const putTotal = db.prepare('insert or replace into engine_costs (engine_session_id, total, ts, by_model) values (?, ?, ?, ?)');
  const getModels = db.prepare('select by_model from engine_costs where engine_session_id = ?');
  const insParallel = db.prepare('insert into parallel_runs (id, title, cap_usd, tasks, created_at) values (?, ?, ?, ?, ?)');
  const getParallel = db.prepare('select * from parallel_runs where id = ?');
  const listParallel = db.prepare('select * from parallel_runs order by created_at desc, rowid desc');
  const setCap = db.prepare('update parallel_runs set cap_usd = ? where id = ?');
  const delParallel = db.prepare('delete from parallel_runs where id = ?');
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
    /** `model: null` clears the model (the provider's default). */
    updateSession(id: string, patch: { autoApprove?: boolean; title?: string; engine?: string; engineSessionId?: string; model?: string | null; effort?: string | null }) {
      const sets: string[] = ['updated_at = ?'];
      const vals: Array<string | number | null> = [Date.now()];
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
    /** Spec 7.8: the user said yes to sending prompts and the key to this ORIGIN for this provider id. Per (id, origin), never per id alone. */
    hasConsent(id: string, origin: string): boolean {
      return getConsent.get(id, origin) !== undefined;
    },
    grantConsent(id: string, origin: string) {
      putConsent.run(id, origin, Date.now());
    },
    /** Every origin of the id: a removed provider leaves nothing behind. */
    revokeConsent(id: string) {
      delConsent.run(id);
    },
    getEditorState(cwd: string): string | undefined {
      return (getEditor.get(cwd) as { json: string } | undefined)?.json;
    },
    putEditorState(cwd: string, json: string) {
      putEditor.run(cwd, json, Date.now());
    },
    getSetting(key: string): unknown {
      const r = getSettingRow.get(key) as { json: string } | undefined;
      if (!r) return undefined;
      try { return JSON.parse(r.json); } catch { return undefined; }
    },
    putSetting(key: string, value: unknown) {
      putSettingRow.run(key, JSON.stringify(value));
    },
    /** The provider's raw running cost total, as Reins last counted it, per provider session id. */
    getEngineTotal(engineSessionId: string): number | undefined {
      return (getTotal.get(engineSessionId) as { total: number } | undefined)?.total;
    },
    /** `byModel` absent clears the stored split, so the next process's split never counts that reply again. */
    putEngineTotal(engineSessionId: string, total: number, byModel?: Record<string, number>) {
      putTotal.run(engineSessionId, total, Date.now(), byModel ? JSON.stringify(byModel) : null);
    },
    /** The provider's per-model running totals as Reins last counted them; undefined = not known. */
    getEngineModels(engineSessionId: string): Record<string, number> | undefined {
      const j = (getModels.get(engineSessionId) as { by_model: string | null } | undefined)?.by_model;
      if (!j) return undefined;
      try {
        const v = JSON.parse(j);
        return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
      } catch { return undefined; }
    },
    /** M5: a parallel run (the tasks' sessions, an optional USD cap). A session is parallel while a row lists it. */
    createParallel(r: Omit<ParallelRow, 'createdAt'>): ParallelRow {
      insParallel.run(r.id, r.title, r.capUsd ?? null, JSON.stringify(r.tasks), Date.now());
      return toParallel(getParallel.get(r.id));
    },
    listParallel(): ParallelRow[] {
      return listParallel.all().map(toParallel);
    },
    setParallelCap(id: string, usd: number | null) {
      setCap.run(usd, id);
    },
    deleteParallel(id: string) {
      delParallel.run(id);
    },
    close() {
      db.close();
    },
  };
}
