import type { LogRow } from '@reins/server/store.js';

export interface Usage { model: string; used: number; window?: number; stale: boolean }

/**
 * The newest `usage` engine row. ponytail: the stale rule copies the server's contextSize (settings.ts); the app imports
 * server code as types only, so change both together.
 */
export function usageOf(rows: LogRow[]): Usage | undefined {
  let stale = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.type === 'turn_failed') { stale = true; continue; }
    if (r.type !== 'engine') continue;
    const d = (r.data ?? {}) as { type?: string; model?: unknown; used?: unknown; window?: unknown };
    if (d.type !== 'usage') { stale = true; continue; }
    if (typeof d.used !== 'number' || typeof d.model !== 'string') return undefined;
    return { model: d.model, used: d.used, ...(typeof d.window === 'number' ? { window: d.window } : {}), stale };
  }
  return undefined;
}

export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (Math.round(n / 1000) < 1000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}

const num = (n: number) => n.toLocaleString('en-US');

export function contextWords(u?: Usage): { text: string; title: string } {
  if (!u) return { text: 'Context —', title: 'Known after the next reply.' };
  const text = `Context ${u.stale ? '≥' : ''}${tokens(u.used)} / ${u.window === undefined ? '?' : tokens(u.window)}`;
  if (u.stale) return { text, title: 'At least this: measured before the latest activity.' };
  return { text, title: `${u.model}: ${num(u.used)}${u.window === undefined ? '' : ` of ${num(u.window)}`} tokens after the last reply.` };
}

/** Default first, the provider's list, then the current model when the list does not have it. */
export function modelOptions(models: Array<{ id: string; label: string }>, current?: string): Array<{ id: string; label: string }> {
  const out = [{ id: '', label: 'Default' }, ...models];
  if (current && !models.some((m) => m.id === current)) out.push({ id: current, label: current });
  return out;
}

/** The disabled picker's title, or undefined while it may be used. */
export function pickerBlock(s: { busy: boolean; detached: number }): string | undefined {
  if (s.busy) return 'Switch the model when the session is idle.';
  if (s.detached > 0) return 'A run is left paused in this session. Resume or stop it before switching the model.';
  return undefined;
}
