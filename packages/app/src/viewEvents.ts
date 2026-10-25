import type { StatusRule, StatusWhen } from '../../core/src/nodes/fields.js';
import { KINDS } from './canvasKinds.js';

// What the served views say about events: a rule for the run's marks (`status`) and the events that draw no row (`hidden`). Read live from KINDS (a view
// registered or disposed later is seen); the first view in KINDS' order to name an event keeps it. Every lookup is by own property: a type like
// `constructor` finds nothing. ponytail: each call walks the views (about a dozen); cache by a generation counter if a long log makes it show.

/** The rule of the first view that has one for this event type. */
export function statusOf(type: string): StatusRule | undefined {
  for (const v of Object.values(KINDS)) {
    const rules = v.status as Record<string, StatusRule> | undefined;
    if (rules && Object.hasOwn(rules, type)) return rules[type];
  }
  return undefined;
}

/** True when some served view lists this event type as one that draws no row. */
export function viewHides(type: string): boolean {
  for (const v of Object.values(KINDS)) if (Array.isArray(v.hidden) && (v.hidden as readonly unknown[]).includes(type)) return true;
  return false;
}

/** Every event type the served views hide (a fresh set each call). */
export function viewHidden(): Set<string> {
  const out = new Set<string>();
  for (const v of Object.values(KINDS)) if (Array.isArray(v.hidden)) for (const t of v.hidden) if (typeof t === 'string') out.add(t);
  return out;
}

/** Whether the event's data holds `w.key` itself with one of the listed values. */
export const holds = (d: unknown, w: StatusWhen): boolean =>
  typeof d === 'object' && d !== null && Object.hasOwn(d, w.key) && w.is.includes((d as Record<string, never>)[w.key] as never);

/** The data's own value for `key`, else undefined. */
export const own = (d: unknown, key: string): unknown =>
  typeof d === 'object' && d !== null && Object.hasOwn(d, key) ? (d as Record<string, unknown>)[key] : undefined;
