import { timingSafeEqual } from 'node:crypto';

// Byte lengths, not string lengths: timingSafeEqual throws on buffers of different sizes, and a non-ASCII string can match a token's character count (plan 15d 3b.7).
export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
