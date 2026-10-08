import type { LogRow } from '@reins/server/store.js';
import type { SessionStatus } from '@reins/server/session.js';

export interface Call { result?: unknown; refused?: string; ms?: number }
export interface Sess {
  id: string; cwd: string; autoApprove: boolean; status: SessionStatus; rows: LogRow[]; lastSeq: number; lastTs: number; cost: number;
  explicitTitle?: string; firstMessage?: string;
  replaySeq?: number;
  open: string[]; answers: Record<string, string>; closed: Record<string, string>;
  detached: string[]; calls: Record<number, Call>; queue: Array<{ seq: number; tool: string; ts: number }>; refill?: string;
}
export interface State { sessions: Record<string, Sess>; replayed?: boolean }
export interface SessionView { id: string; cwd: string; title?: string; autoApprove: boolean; status: SessionStatus; createdAt?: number; updatedAt?: number }

export const initial = (): State => ({ sessions: {} });

const blank = (id: string): Sess => ({
  id, cwd: '', autoApprove: false, status: 'idle', rows: [], lastSeq: 0, lastTs: 0, cost: 0,
  open: [], answers: {}, closed: {}, detached: [], calls: {}, queue: [],
});
const d = (r: LogRow) => (r.data ?? {}) as Record<string, any>;

export function loadSessions(state: State, views: SessionView[]): State {
  const sessions = { ...state.sessions };
  for (const v of views) {
    if (sessions[v.id]) continue;
    sessions[v.id] = { ...blank(v.id), ...(state.replayed ? { replaySeq: 0 } : {}), cwd: v.cwd, autoApprove: v.autoApprove, status: v.status, ...(v.title ? { explicitTitle: v.title } : {}) };
  }
  return { ...state, sessions };
}

/** Freeze history only after the SSE replay marker, not its first 16ms batch. */
export function finishReplay(state: State): State {
  if (state.replayed) return state;
  return { ...state, replayed: true, sessions: Object.fromEntries(Object.entries(state.sessions).map(([id, s]) => [id, { ...s, replaySeq: s.lastSeq }])) };
}
export const isFresh = (sess: Sess, seq: number, seenSeq = 0): boolean => seq > Math.max(sess.replaySeq ?? Infinity, seenSeq);

function apply(s: Sess, row: LogRow, loadedAt: number): Sess {
  const n: Sess = { ...s, lastSeq: row.seq, lastTs: row.ts };
  n.rows.push(row);
  const x = d(row);
  if (row.runId) {
    if (row.type === 'run_detached') n.detached = [...s.detached.filter((r) => r !== row.runId), row.runId];
    else if (s.detached.includes(row.runId)) n.detached = s.detached.filter((r) => r !== row.runId);
  }
  switch (row.type) {
    case 'session_created':
      n.cwd = x.cwd ?? n.cwd;
      n.autoApprove = x.autoApprove ?? n.autoApprove;
      if (x.title) n.explicitTitle = x.title;
      break;
    case 'status': n.status = x.status; break;
    case 'settings':
      if (typeof x.title === 'string') n.explicitTitle = x.title;
      if (typeof x.autoApprove === 'boolean') n.autoApprove = x.autoApprove;
      break;
    case 'message':
      if (n.firstMessage === undefined && typeof x.text === 'string') n.firstMessage = x.text.slice(0, 60);
      break;
    case 'question': n.open = [...s.open, x.id]; break;
    case 'answer':
      n.open = s.open.filter((q) => q !== x.questionId);
      n.answers = { ...s.answers, [x.questionId]: x.answer };
      break;
    case 'question_closed':
      n.open = s.open.filter((q) => q !== x.questionId);
      n.closed = { ...s.closed, [x.questionId]: x.why ?? '' };
      break;
    case 'turn_ended':
      if (typeof x.cost === 'number') n.cost = s.cost + x.cost;
      n.queue = [];
      break;
    case 'turn_failed': n.queue = []; break;
    case 'cards_unsent':
      if (row.ts >= loadedAt && Array.isArray(x.cards)) n.refill = x.cards.join('\n\n');
      break;
    case 'engine':
      if (x.type === 'tool_call') n.queue = [...s.queue, { seq: row.seq, tool: x.tool, ts: row.ts }];
      else if (x.type === 'tool_result' || x.type === 'refusal') {
        const at = x.type === 'refusal' ? 0 : s.queue.findIndex((c) => c.tool === x.tool);
        const call = s.queue[at];
        if (call) {
          n.queue = s.queue.filter((_, i) => i !== at);
          n.calls = { ...s.calls, [call.seq]: { ...(x.type === 'refusal' ? { refused: x.reason } : { result: x.output }), ms: row.ts - call.ts } };
        }
      }
      break;
  }
  return n;
}

export const reduce = (state: State, row: LogRow, loadedAt: number): State => reduceAll(state, [row], loadedAt);

/** One batch of rows: each touched session's `rows` is copied once, then appended to, so a long replay is linear. */
export function reduceAll(state: State, rows: LogRow[], loadedAt: number): State {
  const sessions = { ...state.sessions };
  const copied = new Set<string>();
  for (const row of rows) {
    let s = sessions[row.sessionId] ?? { ...blank(row.sessionId), ...(state.replayed ? { replaySeq: 0 } : {}) };
    if (row.seq <= s.lastSeq) continue;
    if (!copied.has(s.id)) { s = { ...s, rows: [...s.rows] }; copied.add(s.id); }
    sessions[s.id] = apply(s, row, loadedAt);
  }
  return copied.size ? { ...state, sessions } : state;
}

export function takeRefill(state: State, id: string, input: string): { state: State; text: string } {
  const s = state.sessions[id];
  if (!s?.refill || input !== '') return { state, text: input };
  const { refill, ...rest } = s;
  return { state: { ...state, sessions: { ...state.sessions, [id]: rest } }, text: refill };
}

export const title = (s: Sess) => s.explicitTitle || s.firstMessage || 'New chat';
export const openQuestions = (s: Sess) => s.rows.filter((r) => r.type === 'question' && s.open.includes(d(r).id));
export const afterOf = (st: State) => Object.values(st.sessions).filter((s) => s.lastSeq > 0).map((s) => `${s.id}:${s.lastSeq}`).join(',');

export function mergeOutput(rows: LogRow[]): LogRow[] {
  const out: LogRow[] = [];
  for (const r of rows) {
    const prev = out.at(-1);
    if (r.type === 'command_output' && prev?.type === 'command_output' && prev.runId === r.runId) {
      out[out.length - 1] = { ...prev, data: { chunk: String(d(prev).chunk ?? '') + String(d(r).chunk ?? '') } };
    } else out.push(r);
  }
  return out;
}

export const folderName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;

export function railGroups(st: State) {
  const all = Object.values(st.sessions);
  const byNew = (a: Sess, b: Sess) => b.lastTs - a.lastTs;
  const waiting = all.filter((s) => s.status === 'waiting').sort(byNew);
  const map = new Map<string, Sess[]>();
  for (const s of all.filter((s) => s.status !== 'waiting')) map.set(s.cwd, [...(map.get(s.cwd) ?? []), s]);
  const groups = [...map].map(([cwd, list]) => ({ cwd, name: folderName(cwd), sessions: list.sort(byNew) }))
    .sort((a, b) => b.sessions[0]!.lastTs - a.sessions[0]!.lastTs);
  return { waiting, groups };
}
