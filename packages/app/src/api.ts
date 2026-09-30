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

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json?.error ?? res.statusText, json);
  return json as T;
}

export const get = <T>(path: string) => call<T>('GET', path);
export const post = <T = unknown>(path: string, body: unknown = {}) => call<T>('POST', path, body);
export const put = <T = unknown>(path: string, body: unknown) => call<T>('PUT', path, body);
export const stream = (after: string) => new EventSource(`/api/stream?token=${encodeURIComponent(token ?? '')}&after=${encodeURIComponent(after)}`);
