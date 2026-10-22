import { showText } from '../../core/src/display.js';
import { dollars } from './unknown.js';

// The one filler for the strings of a view: `{path}`, `{a|b|c}` (the first that has text), `{path:fmt}` (also `{a|b:fmt}`).
// A path is dot-separated own data properties; anything else (a name only the prototype has, `__proto__`, a getter, an object, a function,
// a missing key, an index out of range) fills as empty. Formats are the two the row files use: usd (`$0.0123`, as turn_ended) and count
// (`1,234`, as the engine rows). A template that does not parse is shown as it is. Every filled value passes `showText`.
const FORMATS: Record<string, (n: number) => string> = { usd: (n) => dollars(n, 4), count: (n) => n.toLocaleString('en-US') };

type Hole = { paths: string[]; fmt?: string };

function parse(t: string): Array<string | Hole> | undefined {
  const parts: Array<string | Hole> = [];
  for (let i = 0; ;) {
    const open = t.indexOf('{', i);
    if (open < 0) return [...parts, t.slice(i)];
    const close = t.indexOf('}', open);
    const inner = close < 0 ? '{' : t.slice(open + 1, close);
    if (inner.includes('{')) return undefined;
    const [names = '', fmt, ...more] = inner.split(':');
    const paths = names.split('|');
    if (more.length || paths.some((p) => p.split('.').includes('')) || (fmt !== undefined && !Object.hasOwn(FORMATS, fmt))) return undefined;
    parts.push(t.slice(i, open), { paths, ...(fmt === undefined ? {} : { fmt }) });
    i = close + 1;
  }
}

function pick(data: unknown, path: string): unknown {
  let v = data;
  for (const k of path.split('.')) {
    if (k === '__proto__' || typeof v !== 'object' || v === null) return undefined;
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !('value' in d)) return undefined;
    v = d.value;
  }
  return v;
}

function text(v: unknown, fmt?: string): string {
  if (fmt !== undefined) return typeof v === 'number' && Number.isFinite(v) ? FORMATS[fmt]!(v) : '';
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
}

export function fill(template: string, data: unknown, o: { lines?: boolean } = {}): string {
  const parts = parse(template);
  if (!parts) return showText(template, o);
  return parts.map((p) => {
    if (typeof p === 'string') return p;
    for (const path of p.paths) {
      const s = text(pick(data, path), p.fmt);
      if (s !== '') return showText(s, o);
    }
    return '';
  }).join('');
}
