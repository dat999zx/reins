// Shared by server.test.ts and exit.test.ts: a real server over real HTTP, with fake-claude as the engine.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { EngineProbe } from '@reins/core';
import { claudeEngine } from '../src/claude/engine.js';
import type { Question } from '../src/drive.js';
import { startServer, type Server } from '../src/server.js';
import { openStore, type LogRow, type Store } from '../src/store.js';
import { FAKE_CLAUDE, fakeSetup, until, type FakeTurn } from './helpers.js';

const undo: Array<() => unknown> = [];
/** Call from `afterEach`: closes streams, servers and stores, then removes the temp folders. */
export async function cleanup() {
  for (const f of undo.splice(0).reverse()) await f();
}

// On Windows a just-exited child can hold its folder for a moment; a leftover temp folder is harmless, a failed test is not.
function rmTemp(d: string) {
  try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the OS temp cleaner */ }
}

export function tmpDir(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-http-')));
  undo.push(() => rmTemp(d));
  return d;
}

export const PROBE: EngineProbe = {
  installed: true, version: '2.1.281', loggedIn: true,
  capabilities: { midTurnSteer: 'hook', preToolDeny: true, resume: true }, problems: [],
};

export interface Res { status: number; headers: http.IncomingHttpHeaders; json: any; text: string }
export interface ReqOptions { body?: unknown; raw?: string; headers?: Record<string, string>; auth?: boolean }

export function request(srv: { port: number; token: string }, method: 'GET' | 'POST' | 'PUT', url: string, o: ReqOptions = {}): Promise<Res> {
  const payload = o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: srv.port, path: url, method, agent: false,
      headers: {
        ...(o.auth === false ? {} : { authorization: `Bearer ${srv.token}` }),
        ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
        ...(o.headers ?? {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (text += d));
      res.on('end', () => {
        let json: unknown;
        try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** An SSE client: `rows` are the `data:` lines, `comments` the `:` lines. `after` is the raw query value. */
export function openStream(srv: { port: number; token: string }, o: { after?: string } = {}) {
  const rows: LogRow[] = [];
  const comments: string[] = [];
  const events: Array<{ event: string; rows: number }> = [];
  let buf = '';
  const query = `token=${srv.token}${o.after !== undefined ? `&after=${encodeURIComponent(o.after)}` : ''}`;
  const req = http.request({ host: '127.0.0.1', port: srv.port, path: `/api/stream?${query}`, agent: false });
  req.on('error', () => {});
  const ready = new Promise<http.IncomingMessage>((resolve) => {
    req.on('response', (res) => {
      res.setEncoding('utf8');
      res.on('error', () => {});
      res.on('data', (d: string) => {
        buf += d;
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith('data: ')) rows.push(JSON.parse(block.slice(6)));
          else if (block.startsWith(':')) comments.push(block);
          else if (block.startsWith('event: ')) events.push({ event: block.split('\n')[0]!.slice(7), rows: rows.length });
        }
      });
      resolve(res);
    });
  });
  req.end();
  const close = () => req.destroy();
  undo.push(close);
  return { ready, rows, comments, events, close };
}

export const rowsOf = (store: Store, id: string, type?: string): LogRow[] => store.readLog(id).filter((r) => !type || r.type === type);

export function openQuestions(rows: LogRow[]): Question[] {
  return rows.filter((r) => r.type === 'question').map((r) => r.data as Question)
    .filter((q) => !rows.some((x) => (x.type === 'answer' || x.type === 'question_closed') && (x.data as { questionId: string }).questionId === q.id));
}

/** Waits for a question of `kind` (any kind if omitted) that is still open, and returns it. */
export async function askedQuestion(store: Store, id: string, kind?: Question['kind'], ms = 10_000): Promise<Question> {
  await until(() => openQuestions(store.readLog(id)).some((q) => !kind || q.kind === kind), ms);
  return openQuestions(store.readLog(id)).find((q) => !kind || q.kind === kind)!;
}

type Fake = ReturnType<typeof fakeSetup>;
export interface BootOptions {
  delayMs?: number;
  heartbeatMs?: number;
  probe?: () => Promise<EngineProbe>;
  store?: Store;                                  // a restart test passes a file store, and the fake it already has
  dir?: string;
  fake?: Fake;
}

/** A server on a free port. Sessions run in `cwd` (the fake's temp folder), so the fake log sits beside them. */
export async function boot(turns: FakeTurn[] = [], o: BootOptions = {}) {
  const fake = o.fake ?? fakeSetup(turns, o.delayMs);
  const dir = o.dir ?? tmpDir();
  const store = o.store ?? openStore(':memory:');
  if (!o.fake) undo.push(() => rmTemp(fake.dir));
  undo.push(() => { try { store.close(); } catch { /* closed by the test */ } });
  let probes = 0;
  const srv: Server = await startServer({
    store, dir,
    probe: o.probe ?? (async () => { probes++; return PROBE; }),
    ...(o.heartbeatMs ? { heartbeatMs: o.heartbeatMs } : {}),
    makeEngine: ({ model, effort, onApprove, onLive }) =>
      claudeEngine({ bin: FAKE_CLAUDE, ...(model ? { model } : {}), ...(effort ? { effort } : {}), onApprove, onLive }),
  });
  undo.push(() => srv.close());
  const api = (method: 'GET' | 'POST' | 'PUT', url: string, r: ReqOptions = {}) => request(srv, method, url, r);
  const cwd = fake.dir;
  return {
    srv, store, dir, cwd, fake, api, probes: () => probes,
    async session(extra: Record<string, unknown> = {}): Promise<string> {
      const r = await api('POST', '/api/sessions', { body: { cwd, engine: 'claude', ...extra } });
      if (r.status !== 200) throw new Error(`POST /api/sessions: ${r.status} ${r.text}`);
      return r.json.id as string;
    },
    say: (id: string, text: string, tags?: unknown) => api('POST', `/api/sessions/${id}/message`, { body: { text, ...(tags ? { tags } : {}) } }),
    card: (id: string, text: string, kind: string) => api('POST', `/api/sessions/${id}/card`, { body: { text, kind } }),
    answer: (id: string, questionId: string, answer: string) => api('POST', `/api/sessions/${id}/answer`, { body: { questionId, answer } }),
    post: (id: string, action: string, body: unknown = {}) => api('POST', `/api/sessions/${id}/${action}`, { body }),
    rows: (id: string, type?: string) => rowsOf(store, id, type),
    // `n` turns have ended and the session is back to idle: the last row is `status idle`, which is logged after `turn_ended`.
    settled: (id: string, n: number) => until(() => {
      const last = store.readLog(id).at(-1);
      return rowsOf(store, id, 'turn_ended').length >= n && last?.type === 'status' && (last.data as { status?: string }).status === 'idle';
    }),
  };
}
export type World = Awaited<ReturnType<typeof boot>>;
