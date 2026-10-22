import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keeps the engine and the app free of block names: only core/src/nodes/ may branch on a kind.
// Limits: it checks a finite list of names and spellings. It misses double quotes, template
// strings, computed lookups (KINDS[x]) and future kind names.

const KINDS = 'phase|say|run|gate|repeat|if|verify|use|recall|store|model|subagent|end';
const OPS = 'RECALL|GATE|IF|LOOP_IN|RUN|LOOP_BK|VERIFY|STORE';
const ANY: RegExp[] = [
  new RegExp(`kind\\s*[!=]==\\s*'(${KINDS})'`),
  new RegExp(`case '(${OPS})'`),
  new RegExp(`op\\s*[!=]==\\s*'(${OPS})'`),
  new RegExp(`NODES\\.get\\('(${KINDS})'\\)`),
  new RegExp(`KINDS(\\.|\\[')(${KINDS})\\b`),
  new RegExp(`addStepAt\\([^)]*'(${KINDS})'`),
];
const CSS = /\[data-kind=/;

const hit = (line: string, file: string) => ANY.some((r) => r.test(line)) || (file.endsWith('.css') && CSS.test(line));

const ALLOW = [
  { file: 'packages/server/src/tags.ts', text: "const attrs = NODES.get('phase')?.attrs ?? [];", reason: 'a chat tag wraps a phase' },
  { file: 'packages/server/src/tags.ts', text: "for (const a of NODES.get('phase')?.attrs ?? []) out.push({ name: a, place: 'attr', arg: a, argRequired: true, enforced: true });", reason: 'a chat tag wraps a phase' },
  { file: 'packages/server/src/drive.ts', text: "if (kind === 'gate') {", reason: 'a question kind, core pause type' },
  { file: 'packages/server/src/run-cli.ts', text: "if (o.yes && q.kind === 'gate') { say('  approved (--yes)'); return Promise.resolve('approve'); }", reason: 'a question kind, core pause type' },
];

const root = fileURLToPath(new URL('../../..', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('no block names outside core/src/nodes', () => {
  it('the matcher bites', () => {
    expect(hit("if (x.kind === 'end') {}", 'a.ts')).toBe(true);
    expect(hit("kind === 'foo'", 'a.ts')).toBe(false);
    expect(hit("[data-kind='end'] {}", 'a.css')).toBe(true);
    expect(hit("[data-kind='end'] {}", 'a.ts')).toBe(false);
  });

  it('no file branches on a kind, and the allowlist is exact', () => {
    const files = readdirSync(join(root, 'packages')).flatMap((p) => existsSync(join(root, 'packages', p, 'src')) ? walk(join(root, 'packages', p, 'src')) : []);
    const used = new Set<number>();
    const bad: string[] = [];
    for (const f of files) {
      const rel = relative(root, f).replace(/\\/g, '/');
      if (rel.startsWith('packages/core/src/nodes/')) continue;
      readFileSync(f, 'utf8').split('\n').forEach((raw, n) => {
        const line = raw.trim();
        if (!hit(line, rel)) return;
        const k = ALLOW.findIndex((a) => a.file === rel && a.text === line);
        if (k >= 0) used.add(k);
        else bad.push(`${rel}:${n + 1}: ${line}`);
      });
    }
    const stale = ALLOW.filter((_, k) => !used.has(k)).map((a) => `${a.file}: ${a.text}`);
    expect({ bad, stale }).toEqual({ bad: [], stale: [] });
  });
});
