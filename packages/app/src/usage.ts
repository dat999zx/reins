import type { LogRow } from '@reins/server/store.js';

export interface Usage { model: string; used: number; window?: number; stale: boolean; compressed?: true } // compressed: `used` is the provider's figure after a compaction, a lower bound

/**
 * The newest `usage` engine row. ponytail: the stale rule copies the server's contextSize (settings.ts), which treats a compaction as
 * unknown; the app shows its after-figure as a lower bound instead. The app imports server code as types only, so change both together.
 */
export function usageOf(rows: LogRow[]): Usage | undefined {
  let stale = false;
  let after: number | undefined;
  let compacted = false; // a compaction met before any usage
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.type === 'turn_failed') { stale = true; continue; }
    if (r.type !== 'engine') continue;
    const d = (r.data ?? {}) as { type?: string; model?: unknown; used?: unknown; window?: unknown; after?: unknown };
    if (d.type === 'compacted' && !compacted) {
      if (typeof d.after !== 'number' || !Number.isInteger(d.after) || d.after < 0) return undefined;
      compacted = true; after = d.after; stale = true;
      continue;
    }
    if (d.type !== 'usage') { stale = true; continue; }
    if (typeof d.used !== 'number' || typeof d.model !== 'string') return undefined;
    return { model: d.model, used: after ?? d.used, ...(typeof d.window === 'number' ? { window: d.window } : {}), stale, ...(compacted ? { compressed: true as const } : {}) };
  }
  return undefined;
}

export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (Math.round(n / 1000) < 1000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}

const num = (n: number) => n.toLocaleString('en-US');

/** `fallback` is the catalog's window for the model; the usage row's own window (the stream's) wins. */
export function contextWords(u?: Usage, fallback?: number): { text: string; title: string } {
  if (!u) return { text: `Context 0 / ${fallback === undefined ? '?' : tokens(fallback)}`, title: 'Measured after the first reply.' };
  const window = u.window ?? fallback;
  const text = `Context ${u.stale ? '≥' : ''}${tokens(u.used)} / ${window === undefined ? '?' : tokens(window)}`;
  if (u.compressed) return { text, title: "At least this: the provider's figure after compressing. The next reply measures it again." };
  if (u.stale) return { text, title: 'At least this: measured before the latest activity.' };
  return { text, title: `${u.model}: ${num(u.used)}${window === undefined ? '' : ` of ${num(window)}`} tokens after the last reply.` };
}

/** The provider's list, then the current model when the list does not have it. */
export function modelOptions(models: Array<{ id: string; label: string }>, current?: string): Array<{ id: string; label: string }> {
  const out = [...models];
  if (current && !models.some((m) => m.id === current)) out.push({ id: current, label: current });
  return out;
}

/** The model a session runs on: its own, else the last reply's (a session from before every session had one), else its provider's default. */
export function shownModel(sess: { engine?: string; model?: string | null }, usage: Usage | undefined, providers: Array<{ id: string; defaultModel: string }>): string | undefined {
  return sess.model ?? usage?.model ?? providers.find((p) => p.id === sess.engine)?.defaultModel;
}

/**
 * The server keeps the engine's session id from the first reply that has no error event, and Compress needs it.
 * ponytail: the app has no such field, so this reads the log: some turn_ended whose rows since the previous turn_ended / turn_failed hold no error.
 */
export function hasReplied(rows: LogRow[]): boolean {
  let errored = false;
  for (const r of rows) {
    if (r.type === 'turn_failed') errored = false;
    else if (r.type === 'turn_ended') { if (!errored) return true; errored = false; }
    else if (r.type === 'engine' && (r.data as { type?: string } | null)?.type === 'error') errored = true;
  }
  return false;
}

/** Work is going on for Compress: running, or waiting on anything but a switch card (the server closes that card and compresses). */
export function compressBusy(status: string, openKinds: Array<string | undefined>): boolean {
  if (status === 'running') return true;
  return status === 'waiting' && !(openKinds.length > 0 && openKinds.every((k) => k === 'switch'));
}

/** The disabled Compress button's title, or undefined while it may be used. */
export function compressBlock(s: { busy: boolean; replied: boolean }): string | undefined {
  if (s.busy) return 'Compress when the session is idle.';
  if (!s.replied) return 'Nothing to compress before the first reply.';
  return undefined;
}

/** The disabled picker's title, or undefined while it may be used. */
export function pickerBlock(s: { busy: boolean; detached: number; asking?: boolean }): string | undefined {
  if (s.asking) return 'Answer the switch question first.';
  if (s.busy) return 'Switch the model when the session is idle.';
  if (s.detached > 0) return 'A run is left paused in this session. Resume or stop it before switching the model.';
  return undefined;
}
