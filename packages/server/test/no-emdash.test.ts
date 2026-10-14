import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packages = fileURLToPath(new URL('../../', import.meta.url));
const EM_DASH = String.fromCharCode(0x2014);

function* files(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (/\.(tsx?|css|md|json)$/.test(e.name)) yield p;
  }
}

describe('no em-dash in the source', () => {
  it('no file under packages/*/src holds U+2014', () => {
    const roots = fs.readdirSync(packages).map((n) => path.join(packages, n, 'src')).filter((d) => fs.existsSync(d));
    expect(roots.length).toBeGreaterThan(0);
    const bad = roots.flatMap((r) => [...files(r)]).filter((f) => fs.readFileSync(f, 'utf8').includes(EM_DASH)).map((f) => path.relative(packages, f));
    expect(bad).toEqual([]);
  });
});
