import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keeps the server and the app free of provider names: only packages/server/src/mods/ may name one (spec 11.1).
// Names: every shipped provider's id, base URL host and keyEnv names (read from its mod.json), plus a fixed list.
// Matched as case-insensitive substrings, so `claudeEngine` and `probeClaude` are caught. A name of 3 characters or fewer
// (a short id such as `zai`) would over-match as a substring, so it matches only as a whole word. No label words are used
// ("Z.ai" and "LM Studio" would ban `ai` and `studio`).
// Limits: a name built at run time or split across lines passes.

const FIXED = ['claude', 'anthropic', 'codex', 'openai', 'gemini', 'deepseek', 'ollama', 'openrouter', 'groq', 'mistral'];

const root = fileURLToPath(new URL('../../..', import.meta.url));
const MODS = join(root, 'packages', 'server', 'src', 'mods');

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (ext.test(e.name)) out.push(p);
  }
  return out;
}

interface Names { ids: string[]; hosts: string[]; keyEnvs: string[] }

/** The names the shipped provider manifests carry. */
function shipped(): Names {
  const n: Names = { ids: [], hosts: [], keyEnvs: [] };
  for (const f of walk(MODS, /^mod\.json$/)) {
    const m = JSON.parse(readFileSync(f, 'utf8')) as { kind?: string; id?: string; baseUrl?: string; auth?: { keyEnv?: string[] } };
    if (m.kind !== 'provider') continue;
    if (m.id) n.ids.push(m.id);
    if (m.baseUrl) n.hosts.push(new URL(m.baseUrl).hostname);
    n.keyEnvs.push(...(m.auth?.keyEnv ?? []));
  }
  return n;
}

const nameList = (n: Names) => [...new Set([...FIXED, ...n.ids, ...n.hosts, ...n.keyEnvs].map((s) => s.toLowerCase()))];

/** The first name the line holds, or undefined. */
function hit(line: string, names: string[]): string | undefined {
  const low = line.toLowerCase();
  return names.find((n) => (n.length <= 3 ? new RegExp(`(?<![a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(low) : low.includes(n)));
}

// Exact text per line; a stale entry fails.
const ALLOW: Array<{ file: string; text: string; reason: string }> = [
  {
    file: 'packages/app/src/providersStatus.ts',
    text: "export const AGENTS_LINE = 'Sessions on API providers do not read CLAUDE.md; put shared rules in AGENTS.md.';",
    reason: 'the fixed line of spec 7.4 names a file, not a provider',
  },
];

describe('no provider name outside packages/server/src/mods', () => {
  const names = nameList(shipped());

  it('reads the names from the shipped manifests', () => {
    const n = shipped();
    expect(n.ids.length).toBeGreaterThan(0);
    expect(n.hosts.length).toBeGreaterThan(0);
    for (const s of [...n.ids, ...n.hosts, ...n.keyEnvs]) expect(names).toContain(s.toLowerCase());
  });

  it('the matcher bites, one case per name class', () => {
    const fake: Names = { ids: ['acme-code', 'zai'], hosts: ['api.acme.example'], keyEnvs: ['ACME_TOKEN_KEY'] };
    const ns = nameList(fake);
    expect(hit('const x = probeClaude();', ns)).toBe('claude');                // fixed list, as a substring
    expect(hit('import { claudeEngine } from "x";', ns)).toBe('claude');
    expect(hit('the acme-code provider', ns)).toBe('acme-code');               // an id
    expect(hit('fetch("https://api.acme.example/v1")', ns)).toBe('api.acme.example'); // a host
    expect(hit('process.env.ACME_TOKEN_KEY', ns)).toBe('acme_token_key');      // a keyEnv name
    expect(hit('Open Z.ai now', ns)).toBe(undefined);                          // a label word is not a name
    expect(hit('a zai provider', ns)).toBe('zai');                             // a 3-char id, as a word
    expect(hit('the zaire river', ns)).toBe(undefined);                        // not inside a longer word
    expect(hit('const studio = 1; const ai = 2; cloud', ns)).toBe(undefined);  // no label words
  });

  it('no file names a provider, and the allowlist is exact', () => {
    const files = readdirSync(join(root, 'packages')).flatMap((p) => (existsSync(join(root, 'packages', p, 'src')) ? walk(join(root, 'packages', p, 'src'), /\.(tsx?|css|md|json)$/) : []));
    const used = new Set<number>();
    const bad: string[] = [];
    for (const f of files) {
      if (f.startsWith(MODS)) continue;
      const rel = relative(root, f).replace(/\\/g, '/');
      readFileSync(f, 'utf8').split('\n').forEach((raw, i) => {
        const line = raw.trim();
        const name = hit(line, names);
        if (!name) return;
        const k = ALLOW.findIndex((a) => a.file === rel && a.text === line);
        if (k >= 0) used.add(k);
        else bad.push(`${rel}:${i + 1} [${name}]: ${line}`);
      });
    }
    const stale = ALLOW.filter((_, k) => !used.has(k)).map((a) => `${a.file}: ${a.text}`);
    expect({ bad, stale }).toEqual({ bad: [], stale: [] });
  });
});
