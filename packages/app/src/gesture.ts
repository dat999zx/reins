export type Press = {
  button: number; shift: boolean; space: boolean;
  on: 'input' | 'block' | 'hat' | 'loose' | 'handle' | 'link' | 'empty' | 'outside';
};
export type GestureKind = 'none' | 'pan' | 'pending' | 'box' | 'link' | 'linkclick';
export const DRAG_PX = 4;
export const isTyping = (tag: string) => tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

// ponytail: block / hat / loose give 'none' until the pointer drag engine exists; the native grips handle them
export function pickGesture(p: Press): GestureKind {
  if (p.on === 'outside') return 'none';
  if (p.button === 1) return 'pan';
  if (p.button !== 0 || p.on === 'input') return 'none';
  if (p.space) return 'pan';
  return p.on === 'empty' ? 'pan' : 'none';
}
