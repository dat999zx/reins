import type { Hit } from './blocks.js';
export type Press = {
  button: number; shift: boolean; space: boolean;
  on: 'input' | 'block' | 'hat' | 'loose' | 'handle' | 'link' | 'empty' | 'outside';
};
export type GestureKind = 'none' | 'pan' | 'pending' | 'box' | 'link' | 'linkclick';
export const DRAG_PX = 4;
export const isTyping = (tag: string) => tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

export function pickGesture(p: Press): GestureKind {
  if (p.on === 'outside') return 'none';
  if (p.button === 1) return 'pan';
  if (p.button !== 0 || p.on === 'input') return 'none';
  if (p.space) return 'pan';
  if (p.on === 'empty') return 'pan';
  return p.on === 'block' || p.on === 'hat' || p.on === 'loose' ? 'pending' : 'none';
}

// What a pointer can be over. The type and the id are separate attributes, so a step called end or hat never meets those zones.
export type Zone = { type: 'block' | 'cap' | 'chead' | 'body' | 'mid' | 'foot' | 'hat' | 'end' | 'hex' | 'loose' | 'free' | 'surface'; id?: string; branch?: 'kids' | 'else'; path?: string };
export type Target = { hit: Hit } | { hex: { id: string; path: Array<'a' | 'b'> } } | { surface: true };

export const zoneKey = (z: Zone) => [z.type, z.id ?? '', z.branch ?? '', z.path ?? ''].join('|');
export const zoneAttrs = (z: Zone) => ({ 'data-zone': z.type, 'data-zid': z.id, 'data-zb': z.branch, 'data-zpath': z.path });

export function hitOf(z: Zone, half: 'top' | 'bottom'): Target | undefined {
  const top = half === 'top', id = z.id!;
  switch (z.type) {
    case 'block': return { hit: { block: id, edge: top ? 'before' : 'after' } };
    case 'cap': return top ? { hit: { block: id, edge: 'before' } } : undefined;
    case 'chead': return { hit: { block: id, edge: top ? 'before' : 'into' } };
    case 'body': return { hit: { body: id, branch: z.branch ?? 'kids' } };
    case 'mid': return { hit: { block: id, edge: 'else' } };
    case 'foot': return { hit: { block: id, edge: 'after' } };
    case 'hat': return { hit: { top: 'start' } };
    case 'end': return { hit: { top: 'end' } };
    case 'hex': return { hex: { id, path: (z.path ? z.path.split('.') : []) as Array<'a' | 'b'> } };
    case 'free': return undefined;
    default: return { surface: true };
  }
}

// The element that shows the snap bar for a drop on z, and the bar's class.
export function snapOf(z: Zone, half: 'top' | 'bottom'): { el: Zone; cls: string } {
  const top = half === 'top';
  switch (z.type) {
    case 'chead': return top ? { el: z, cls: 'sx-before' } : { el: { type: 'body', id: z.id, branch: 'kids' }, cls: 'sx-into' };
    case 'mid': return { el: { type: 'body', id: z.id, branch: 'else' }, cls: 'sx-into' };
    case 'body': return { el: z, cls: 'sx-into' };
    case 'end': return { el: z, cls: 'sx-end' };
    case 'hex': return { el: z, cls: 'sx-hexover' };
    case 'foot': case 'hat': return { el: z, cls: 'sx-after' };
    default: return { el: z, cls: top ? 'sx-before' : 'sx-after' };
  }
}