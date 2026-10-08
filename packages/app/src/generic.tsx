import type { ReactNode } from 'react';

export const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');
export const words = (t: string) => t.replace(/[_-]/g, ' ');
export const short = (v: unknown, n = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

export function generic(type: string, data: unknown): ReactNode {
  const empty = data == null || (typeof data === 'object' && Object.keys(data).length === 0);
  return empty ? <div className="row muted">{words(type)}</div>
    : <details className="row muted"><summary>{words(type)}</summary><pre>{typeof data === 'string' ? data : JSON.stringify(data, null, 2)}</pre></details>;
}
