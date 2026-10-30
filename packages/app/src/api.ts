import type { ParallelView } from './parallel.js';

const KEY = 'reins-token';
let token: string | null = null;

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: any) {
    super(message);
  }
}

export function initToken(): string | null {
  const h = new URLSearchParams(location.hash.slice(1));
  const given = h.get('token');
  if (given) {
    sessionStorage.setItem(KEY, given);
    h.delete('token');
    const rest = h.toString();
    history.replaceState(null, '', location.pathname + location.search + (rest ? `#${rest}` : ''));
  }
  token = sessionStorage.getItem(KEY);
  return token;
}

async function call<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    method,
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json?.error ?? res.statusText, json);
  return json as T;
}

export const get = <T>(path: string) => call<T>('GET', path);
export const post = <T = unknown>(path: string, body: unknown = {}) => call<T>('POST', path, body);
export const put = <T = unknown>(path: string, body: unknown, init?: RequestInit) => call<T>('PUT', path, body, init);
export const del = <T = unknown>(path: string) => call<T>('DELETE', path);
export const sendCard = (id: string, kind: 'steer' | 'now' | 'stop', text = '') => post(`/api/sessions/${id}/card`, { kind, text });
export const parallelRuns = () => get<{ runs: ParallelView[] }>('/api/parallel').then((r) => r.runs);
export const stopAll = (id: string) => post<{ stopped: string[]; idle: string[] }>(`/api/parallel/${id}/stop`);
export const resumeAll = (id: string) => post<{ results: unknown }>(`/api/parallel/${id}/resume`);
export const setCap = (id: string, usd: number | null) => post(`/api/parallel/${id}/cap`, { usd });
export const stream = (after: string) => new EventSource(`/api/stream?token=${encodeURIComponent(token ?? '')}&after=${encodeURIComponent(after)}`);
