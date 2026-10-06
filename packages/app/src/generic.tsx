import type { ReactNode } from 'react';

export const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');
export const words = (t: string) => t.replace(/[_-]/g, ' ');
export const short = (v: unknown, n = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

export function generic(type: string, data: unknown): ReactNode {
  const s = data && typeof data === 'object' && Object.keys(data).length === 0 ? '' : short(data);
  return (
    <div className="row muted">
      <span>{words(type)}</span> {s}
    </div>
  );
}
