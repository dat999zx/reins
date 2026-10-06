import { arrowPath, labelAt, type LinkArrow } from './arrows.js';
import type { Pt, Rect } from './surface.js';

const WIRES: Record<string, string> = { next: '#a3a19b', 'on-fail': '#e05d5a' };
const OTHER = '#6f6e6b', BAD = '#e05d5a', WARN = '#cf9433';
const colour = (a: LinkArrow) => (a.mark === 'error' ? BAD : a.mark === 'warning' ? WARN : WIRES[a.kind] ?? OTHER);
const head = (c: string) => `sx-ah${c.slice(1)}`;

// `rects` are measured inside the script (its own origin), so a hat drag only moves `at`.
// `band` is the link being drawn, in world coordinates.
export function LinkLayer({ arrows, rects, lanes, at, selected, band }: { arrows: LinkArrow[]; rects: Map<string, Rect>; lanes: Map<string, number>; at: Pt; selected?: string; band?: { a: Pt; b: Pt } }) {
  const colours = [...new Set(arrows.map(colour))];
  return (
    <svg className="sx-links" width="1" height="1">
      <defs>
        {colours.map((c) => (
          <marker key={c} id={head(c)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill={c} /></marker>
        ))}
      </defs>
      <g transform={`translate(${at.x} ${at.y})`}>
        {arrows.map((a) => {
          const f = rects.get(a.from), t = rects.get(a.to), key = `${a.from}/${a.index}`;
          if (!f || !t) return null;
          const d = arrowPath(f, t, lanes.get(key) ?? 0), c = colour(a);
          return (
            <g key={key} className={selected === key ? 'sx-lsel' : undefined} data-link={key} data-lk={a.kind} role="button" tabIndex={0} aria-label={`${a.kind} link from ${a.from} to ${a.to}`}>
              <path d={d} fill="none" stroke={c} strokeWidth={1.5} strokeDasharray={a.mark === 'warning' ? '5 4' : WIRES[a.kind] ? undefined : '2 4'} markerEnd={`url(#${head(c)})`} />
              <path className="sx-hit" d={d} fill="none" stroke="transparent" strokeWidth={10} />
              {a.kind !== 'next' && <text {...labelAt(f, t, lanes.get(key) ?? 0)} fill={c}>{a.kind === 'on-fail' ? 'on fail' : a.kind}</text>}
            </g>
          );
        })}
      </g>
      {band && <path className="sx-band" d={`M ${band.a.x} ${band.a.y} L ${band.b.x} ${band.b.y}`} />}
    </svg>
  );
}
