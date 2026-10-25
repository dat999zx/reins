import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseWorkflow } from '../src/format/parse.js';
import { printWorkflow } from '../src/format/print.js';

const examplesDir = path.resolve(__dirname, '../../../examples');

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.reins.md') ? [p] : [];
  });

describe('every example', () => {
  const files = walk(examplesDir);

  it('finds the examples', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files.map((f) => [path.relative(examplesDir, f), f]))('%s parses with 0 diagnostics and prints back the same bytes', (_rel, file) => {
    const content = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const { workflow, diagnostics } = parseWorkflow(content);
    expect(diagnostics).toEqual([]);
    expect(printWorkflow(workflow!)).toBe(content);
  });
});
