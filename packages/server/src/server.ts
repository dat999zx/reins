import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { EngineProbe } from '@reins/core';
import { sameToken } from './hooks.js';
import { releaseLock, runningLock, takeLock } from './lock.js';
import { recover } from './recover.js';
import { loadWorkflow } from './run-cli.js';
import { openSession, under, type Ack, type MakeEngine, type Session, type SessionDeps } from './session.js';
import type { LogRow, Store } from './store.js';
import { tagCatalogue, type Tag } from './tags.js';
import { previewWorkflow, readWorkflow, writeWorkflow } from './workflow-files.js';

export interface ServerOptions {
  store: Store;
  makeEngine: MakeEngine;
  dir: string;
  probe: () => Promise<EngineProbe>;
  port?: number;
  lockFile?: string;
  heartbeatMs?: number;
  appDir?: string;
  pickFolder?: (signal: AbortSignal) => Promise<string | null>;
}
export interface Server { port: number; token: string; url: string; close(): Promise<void> }

const MAX_BODY = 1024 * 1024;
type Reply = { status: number; body: unknown };
interface Body {
  text?: unknown; tags?: unknown; kind?: unknown; questionId?: unknown; answer?: unknown; autoApprove?: unknown;
  title?: unknown; path?: unknown; create?: unknown; stepId?: unknown; runId?: unknown; cwd?: unknown; engine?: unknown; model?: unknown; effort?: unknown;
  state?: unknown;
}
const MAX_EDITOR_STATE = 64 * 1024;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const editorKey = (cwd: unknown): string | undefined => {
  if (!str(cwd) || cwd.includes('\0') || !path.isAbsolute(cwd)) return undefined;
  const k = path.resolve(cwd);
  return process.platform === 'win32' ? k.toLowerCase() : k;
};

const ok = (body: unknown = {}): Reply => ({ status: 200, body });
const fail = (status: number, error: string): Reply => ({ status, body: { error } });
const fromAck = (a: Ack): Reply =>
  a.ok ? ok() : { status: a.code, body: { error: a.error, ...(a.text !== undefined ? { text: a.text } : {}), ...(a.diagnostics ? { diagnostics: a.diagnostics } : {}) } };
const str = (v: unknown): v is string => typeof v === 'string';
const isTags = (v: unknown): v is Tag[] =>
  Array.isArray(v) && v.every((t) => typeof t === 'object' && t !== null && str(t.tag) && (t.arg === undefined || str(t.arg)));

const actions: Record<string, (s: Session, b: Body) => Reply | Promise<Reply>> = {
  message: (s, b) => {
    const tags = b.tags ?? [];
    if (!str(b.text) || !b.text.trim()) return fail(400, 'text must be a non-empty string.');
    if (!isTags(tags)) return fail(400, 'tags must be a list of { tag, arg? } with string values.');
    return fromAck(s.message(b.text, tags));
  },
  card: (s, b) => {
    if (b.kind !== 'steer' && b.kind !== 'now' && b.kind !== 'stop') return fail(400, "kind must be 'steer', 'now' or 'stop'.");
    if (!str(b.text) || (!b.text.trim() && b.kind !== 'stop')) return fail(400, 'text must be a non-empty string.');
    return fromAck(s.card(b.text, b.kind));
  },
  answer: (s, b) => (str(b.questionId) && str(b.answer) ? fromAck(s.answer(b.questionId, b.answer)) : fail(400, 'questionId and answer must be strings.')),
  settings: (s, b) => {
    const autoApprove = b.autoApprove;
    const title = b.title;
    if (autoApprove !== undefined && typeof autoApprove !== 'boolean') return fail(400, 'autoApprove must be a boolean.');
    if (title !== undefined && !str(title)) return fail(400, 'title must be a string.');
    s.settings({ ...(autoApprove !== undefined ? { autoApprove } : {}), ...(title !== undefined ? { title } : {}) });
    return ok();
  },
  run: (s, b) => (str(b.path) && b.path ? fromAck(s.runFile(b.path)) : fail(400, 'path must be a non-empty string.')),
  resume: (s, b) => (str(b.runId) && b.runId ? fromAck(s.resume(b.runId)) : fail(400, 'runId must be a non-empty string.')),
  close: async (s) => { await s.close(); return ok(); },
};

function readBody(req: http.IncomingMessage): Promise<{ text: string } | { tooBig: true } | { aborted: true }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // Over the cap the bytes are read and dropped, so the client gets its 413 instead of a reset.
    req.on('data', (c: Buffer) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => resolve(size > MAX_BODY ? { tooBig: true } : { text: Buffer.concat(chunks).toString('utf8') }));
    // A cut-off request (a truncated POST) is never acted on; the first resolve wins, so a normal 'close' after 'end' changes nothing.
    req.on('close', () => resolve({ aborted: true }));
    req.on('error', () => resolve({ aborted: true }));
  });
}

async function parse(req: http.IncomingMessage): Promise<{ b: Body } | { fail: Reply }> {
  const r = await readBody(req);
  if ('tooBig' in r) return { fail: fail(413, 'The body is larger than 1 MB.') };
  if ('aborted' in r) return { fail: fail(400, 'The request was cut off.') };
  let v: unknown;
  try {
    v = r.text ? JSON.parse(r.text) : {};
  } catch {
    return { fail: fail(400, 'The body is not valid JSON.') };
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { fail: fail(400, 'The body must be a JSON object.') };
  return { b: v as Body };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
};

function serveStatic(appDir: string, pathname: string, res: http.ServerResponse) {
  try {
    const p = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    if (p.includes('\0')) return send(res, fail(404, 'Not found.'));
    const file = path.resolve(appDir, '.' + p);
    if (!under(file, path.resolve(appDir)) || !fs.statSync(file).isFile()) return send(res, fail(404, 'Not found.'));
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    send(res, fail(404, 'Not found.'));
  }
}

function send(res: http.ServerResponse, r: Reply) {
  res.writeHead(r.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(r.body));
}

export async function startServer(o: ServerOptions): Promise<Server> {
  const token = randomBytes(32).toString('hex');
  const sessions = new Map<string, Session>();
  const subs = new Set<(row: LogRow) => void>();
  const deps: SessionDeps = { store: o.store, makeEngine: o.makeEngine, dir: o.dir, onRow: (row) => { for (const f of subs) f(row); } };
  let engines: Array<{ id: string } & EngineProbe> = [];
  let host = '';
  let origin = '';

  const probeNow = async (): Promise<Array<{ id: string } & EngineProbe>> => {
    try {
      return [{ id: 'claude', ...(await o.probe()) }];
    } catch (e) {
      return [{ id: 'claude', installed: false, loggedIn: false, capabilities: { midTurnSteer: 'none', preToolDeny: false, resume: false }, problems: [e instanceof Error ? e.message : String(e)] }];
    }
  };

  const view = (s: Session) => {
    const r = s.info();
    return {
      id: r.id, cwd: r.cwd, engine: r.engine, model: r.model, effort: r.effort, title: r.title,
      autoApprove: r.autoApprove, createdAt: r.createdAt, updatedAt: r.updatedAt, status: s.status(),
    };
  };

  function create(b: Body): Reply {
    if (!str(b.cwd) || !path.isAbsolute(b.cwd)) return fail(400, 'cwd must be an absolute path.');
    if (b.cwd.includes('\0') || !fs.statSync(b.cwd, { throwIfNoEntry: false })?.isDirectory()) return fail(400, 'cwd is not a folder.');
    if (b.engine !== 'claude') return fail(400, "engine must be 'claude'.");
    for (const k of ['model', 'effort', 'title'] as const) if (b[k] !== undefined && !str(b[k])) return fail(400, `${k} must be a string.`);
    const row = o.store.createSession({
      id: randomBytes(6).toString('hex'), cwd: b.cwd, engine: 'claude',
      ...(str(b.model) ? { model: b.model } : {}), ...(str(b.effort) ? { effort: b.effort } : {}), ...(str(b.title) ? { title: b.title } : {}),
    });
    const s = openSession(deps, row, true);
    sessions.set(row.id, s);
    return ok(view(s));
  }

  function workflows(cwd: string | null): Reply {
    if (!cwd || !path.isAbsolute(cwd)) return fail(400, 'cwd must be an absolute path.');
    const list = (folder: string, scope: 'project' | 'user') =>
      !fs.existsSync(folder) ? [] : fs.readdirSync(folder).filter((f) => f.endsWith('.reins.md')).sort().map((f) => {
        const file = path.join(folder, f);
        return { path: file, name: f.slice(0, -'.reins.md'.length), scope, diagnostics: loadWorkflow(file).diagnostics };
      });
    return ok({ workflows: [...list(path.join(cwd, '.reins', 'workflows'), 'project'), ...list(path.join(o.dir, 'workflows'), 'user')] });
  }

  let picking = false;
  async function pick(res: http.ServerResponse): Promise<Reply> {
    if (!o.pickFolder) return fail(501, 'This machine has no folder picker.');
    if (picking) return fail(409, 'A folder dialog is already open.');
    picking = true;
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      const p = await o.pickFolder(ac.signal);
      return p && path.isAbsolute(p) && fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ? ok({ path: p }) : ok({ cancelled: true });
    } catch (e) {
      return fail(501, e instanceof Error ? e.message : 'No folder picker is available.');
    } finally {
      picking = false;
    }
  }

  async function dispatch(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<Reply> {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/state') return ok({ sessions: [...sessions.values()].map(view), engines });
    if (req.method === 'POST' && p === '/api/state/probe') { engines = await probeNow(); return ok({ engines }); }
    if (req.method === 'GET' && p === '/api/tags') return ok({ tags: tagCatalogue() });
    if (req.method === 'GET' && p === '/api/workflows') return workflows(url.searchParams.get('cwd'));
    if (req.method === 'GET' && p === '/api/editor-state') {
      const key = editorKey(url.searchParams.get('cwd'));
      if (!key) return fail(400, 'cwd must be an absolute path.');
      const raw = o.store.getEditorState(key);
      let state: unknown = null;
      try { if (raw !== undefined) state = JSON.parse(raw); } catch { /* a corrupt row reads as no state */ }
      return ok({ state: isObject(state) ? state : null });
    }
    if (req.method === 'PUT' && p === '/api/editor-state') {
      const r = await parse(req);
      if ('fail' in r) return r.fail;
      const key = editorKey(r.b.cwd);
      if (!key) return fail(400, 'cwd must be an absolute path.');
      if (!isObject(r.b.state)) return fail(400, 'state must be a JSON object.');
      const json = JSON.stringify(r.b.state);
      if (Buffer.byteLength(json) > MAX_EDITOR_STATE) return fail(413, 'The editor state is larger than 64 KB.');
      o.store.putEditorState(key, json);
      return ok();
    }
    if (req.method === 'POST' && p === '/api/pick-folder') return pick(res);
    if (req.method === 'POST' && p === '/api/sessions') {
      const r = await parse(req);
      return 'fail' in r ? r.fail : create(r.b);
    }
    const m = /^\/api\/sessions\/([^/]+)\/([a-z]+)$/.exec(p);
    if (m) {
      const s = sessions.get(m[1]!);
      if (!s) return fail(404, 'No such session.');
      if (req.method === 'GET' && m[2] === 'log') {
        const after = url.searchParams.get('after') ?? '0';
        if (!/^\d+$/.test(after)) return fail(400, 'after must be a sequence number.');
        return ok({ rows: o.store.readLog(s.id,Number(after)) });
      }
      const cwd = s.info().cwd;
      if (req.method === 'GET' && m[2] === 'workflow') {
        const p = url.searchParams.get('path');
        return p ? readWorkflow(cwd, o.dir, p) : fail(400, 'path must be a non-empty string.');
      }
      if (req.method === 'PUT' && m[2] === 'workflow') {
        const r = await parse(req);
        if ('fail' in r) return r.fail;
        const { path: p, text, create } = r.b;
        if (!str(p) || !p || !str(text)) return fail(400, 'path and text must be strings.');
        if (create !== undefined && typeof create !== 'boolean') return fail(400, 'create must be a boolean.');
        return writeWorkflow(cwd, o.dir, p, text, create === true);
      }
      if (req.method === 'POST' && m[2] === 'preview') {
        const r = await parse(req);
        if ('fail' in r) return r.fail;
        const { path: p, text, stepId } = r.b;
        if (!str(p) || !p || !str(text)) return fail(400, 'path and text must be strings.');
        if (stepId !== undefined && !str(stepId)) return fail(400, 'stepId must be a string.');
        return previewWorkflow(cwd, o.dir, p, text, stepId);
      }
      if (req.method === 'POST' && Object.hasOwn(actions, m[2]!)) {
        const r = await parse(req);
        return 'fail' in r ? r.fail : actions[m[2]!]!(s, r.b);
      }
    }
    return fail(404, 'Not found.');
  }

  function stream(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const after = new Map<string, number>();
    for (const part of (url.searchParams.get('after') ?? '').split(',')) {
      const i = part.lastIndexOf(':');
      const n = Number(part.slice(i + 1));
      if (i > 0 && Number.isInteger(n) && n >= 0) after.set(part.slice(0, i), n);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.flushHeaders();
    const write = (row: LogRow) => { res.write(`data: ${JSON.stringify(row)}\n\n`); };
    // Replay and subscribe in one tick, so no row can fall between the two.
    for (const id of sessions.keys()) for (const row of o.store.readLog(id, after.get(id) ?? 0)) write(row);
    subs.add(write);
    const beat = setInterval(() => res.write(': heartbeat\n\n'), o.heartbeatMs ?? 15_000);
    req.on('close', () => { clearInterval(beat); subs.delete(write); });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      if (req.headers.host !== host) return send(res, fail(403, 'Bad Host header.'));
      if (req.headers.origin !== undefined && req.headers.origin !== origin) return send(res, fail(403, 'Bad Origin header.'));
      let url: URL;
      try {
        url = new URL(req.url ?? '/', origin);
      } catch {
        return send(res, fail(400, 'Bad URL.'));
      }
      if (!url.pathname.startsWith('/api/')) {
        return o.appDir && req.method === 'GET' ? serveStatic(o.appDir, url.pathname, res) : send(res, fail(404, 'Not found.'));
      }
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const given = bearer ?? (url.pathname === '/api/stream' ? url.searchParams.get('token') : null);
      if (given === null || given === undefined || !sameToken(given, token)) return send(res, fail(401, 'A valid token is required.'));
      if (req.method === 'GET' && url.pathname === '/api/stream') return stream(req, res, url);
      send(res, await dispatch(req, res, url));
    } catch {
      // A fixed message: the text of an error can carry paths. ponytail: nothing is logged; add a logger when there is one.
      if (res.headersSent) res.end();
      else send(res, fail(500, 'Internal error.'));
    }
  }

  // Before listen: with a fixed --port the second instance would die on EADDRINUSE instead of naming the first.
  const already = o.lockFile ? runningLock(o.lockFile) : undefined;
  if (already) throw Object.assign(new Error(`Reins is already serving on port ${already.port}.`), { running: already });

  const server = http.createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  host = `127.0.0.1:${port}`;
  origin = `http://${host}`;

  let locked = false;
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= (async () => {
    subs.clear();
    const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await stopped;
    await Promise.all([...sessions.values()].map((s) => s.shutdown()));
    if (locked && o.lockFile) releaseLock(o.lockFile, process.pid);
  })());

  if (o.lockFile) {
    const got = takeLock(o.lockFile, { pid: process.pid, port, token });
    if (!got.ok) {
      await close();
      throw Object.assign(new Error(`Reins is already serving on port ${got.running.port}.`), { running: got.running });
    }
    locked = true;
  }
  try {
    recover(o.store);
    for (const row of o.store.listSessions()) sessions.set(row.id, openSession(deps, row));
    engines = await probeNow();
  } catch (e) {
    await close();
    throw e;
  }
  return { port, token, url: `${origin}/#token=${token}`, close };
}
