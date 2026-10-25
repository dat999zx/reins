import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { expect } from 'vitest';

/** JSON with sorted keys and undefined dropped, so key order and absent-vs-undefined never matter. */
export function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, stable(o[k])]));
  }
  return v;
}
export const json = (v: unknown) => JSON.stringify(stable(v), null, 2) + '\n';
export const hash = (v: unknown) => createHash('sha256').update(json(v)).digest('hex');

/** Compare with a recorded file; the env flag set to 1 writes it instead (Task 0 only). */
export function golden(name: string, value: unknown, flag = 'REINS_RECORD_3A', dir = __dirname) {
  const file = path.join(dir, name);
  const text = json(value);
  if (process.env[flag] === '1') {
    fs.writeFileSync(file, text);
    return;
  }
  expect(fs.existsSync(file), `missing golden ${name}`).toBe(true);
  expect(text, `golden ${name} changed`).toBe(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
}
