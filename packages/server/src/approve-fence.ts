// M7 T1: the fence rule table of an `approve: "fence"` parallel run. A tool request is answered `y` only when its shape is on the list below;
// anything else is undefined, which the session leaves as a card for a human. Default deny. Not a sandbox: an approved test or lint run
// executes code the agent wrote in its own folder.
import path from 'node:path';
import type { ToolRequest } from '@reins/core';
import { confine } from './loop/paths.js';

export const DENY_MCP = 'n MCP tools are off in this fenced parallel run; carry on with the plan and the code.';

const PROTECTED = new Set(['.claude', '.git', '.mcp.json']);

/** A string path whose REAL path is inside `cwd`, not under the Reins home, and not through a protected name. Never throws. */
function inside(p: unknown, cwd: string, home: string): boolean {
  if (typeof p !== 'string') return false;
  try {
    const c = confine(p, { cwd, home });
    if (!c.ok || !c.inside) return false;
    return !path.relative(c.root, c.abs).split(/[\\/]/).some((part) => PROTECTED.has(part.toLowerCase()));
  } catch {
    return false;
  }
}

type Rule = (input: Record<string, unknown>, cwd: string, home: string) => string | undefined;
const yes = (b: boolean) => (b ? 'y' : undefined);
const filePath = (key: string): Rule => (i, cwd, home) => yes(inside(i[key], cwd, home));
const optPath: Rule = (i, cwd, home) => yes(i.path === undefined || inside(i.path, cwd, home));
const shell: Rule = (i, cwd, home) => yes(typeof i.command === 'string' && shellOk(i.command, cwd, home));

const RULES: Record<string, Rule> = {
  Read: filePath('file_path'),
  Write: filePath('file_path'),
  Edit: filePath('file_path'),
  MultiEdit: filePath('file_path'),
  NotebookEdit: filePath('notebook_path'),
  Grep: optPath, // `pattern` is a regex, not a path
  Glob: (i, cwd, home) => {
    const p = i.pattern;
    if (typeof p !== 'string' || p.includes('..') || /^[\\/~]/.test(p) || p.includes(':')) return undefined;
    return optPath(i, cwd, home);
  },
  Bash: shell,
  PowerShell: shell,
};

/** 'y', a 'n <reason>' answer, or undefined: leave it a card. `home` = the Reins folder (refused by confine). */
export function fenceAnswer(r: ToolRequest, cwd: string, home: string): string | undefined {
  try {
    if (r.reason !== undefined) return undefined; // Reins asked on purpose (the real path is outside): a human decides
    if (typeof r.tool !== 'string') return undefined;
    if (r.tool.startsWith('mcp__')) return DENY_MCP;
    const rule = Object.prototype.hasOwnProperty.call(RULES, r.tool) ? RULES[r.tool] : undefined;
    if (!rule || r.input === null || typeof r.input !== 'object') return undefined;
    return rule(r.input as Record<string, unknown>, cwd, home);
  } catch {
    return undefined;
  }
}

// One row per whole-command shape. `words`: the fixed leading tokens (a RegExp row matches one token). `flags`: the `-` tokens it takes;
// `-N` is `-<digits>`, `-p` takes one path after it. `paths`: whether bare tokens (checked as paths) follow; `min`: how many at least.
interface Shape { words: Array<string | RegExp>; paths: boolean; flags: string[]; min?: number }
const SHAPES: Shape[] = [
  { words: ['node', 'node_modules/vitest/vitest.mjs', 'run'], paths: true, min: 1, flags: [] },
  { words: ['node', 'node_modules/eslint/bin/eslint.js'], paths: true, min: 1, flags: [] },
  { words: ['node', 'node_modules/typescript/bin/tsc', '--noEmit'], paths: false, flags: ['-p'] },
  { words: ['npm', 'run', 'typecheck'], paths: false, flags: [] },
  { words: ['npm', 'run', 'lint'], paths: false, flags: [] },
  { words: ['npm', 'run', 'selfcheck'], paths: false, flags: [] },
  { words: ['npx', 'vitest', 'run'], paths: true, min: 1, flags: [] },
  { words: ['npx', 'eslint'], paths: true, min: 1, flags: [] },
  { words: ['node', /^scripts\/[A-Za-z0-9_-]+\.selfcheck\.mjs$/], paths: false, flags: [] },
  { words: ['git', 'status'], paths: false, flags: ['--short'] },
  { words: ['git', 'diff'], paths: true, flags: ['--stat'] },
  { words: ['git', 'log', '--oneline'], paths: false, flags: ['-N'] },
  { words: ['git', 'rev-parse', '--short', 'HEAD'], paths: false, flags: [] },
];

/** A path token of a shell command: the file tools' `inside`, no `..` part (`\` counts as `/` on every platform), no leading `~` or `\\`, no leading `/` on Windows (MSYS and UNC spellings; elsewhere an absolute path goes through `inside`), a `:` only as `X:\` or `X:/`. */
function pathToken(t: string, cwd: string, home: string): boolean {
  if (t.replace(/\\/g, '/').split('/').includes('..') || t.startsWith('~') || t.startsWith('\\\\')) return false;
  if (process.platform === 'win32' && t.startsWith('/')) return false;
  if (t.includes(':') && !/^[A-Za-z]:[\\/]/.test(t)) return false;
  return inside(t, cwd, home);
}

function matches(s: Shape, tokens: string[], cwd: string, home: string): boolean {
  const fixed = tokens.map((t) => t.replace(/\\/g, '/'));
  if (tokens.length < s.words.length) return false;
  if (!s.words.every((w, i) => (typeof w === 'string' ? fixed[i] === w : w.test(fixed[i]!)))) return false;
  const rest = tokens.slice(s.words.length);
  let paths = 0;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    if (t.startsWith('-')) {
      if (s.flags.includes(t)) {
        if (t === '-p' && !(i + 1 < rest.length && pathToken(rest[++i]!, cwd, home))) return false;
      } else if (!(s.flags.includes('-N') && /^-\d+$/.test(t))) return false;
    } else if (!s.paths || !pathToken(t, cwd, home)) return false;
    else paths++;
  }
  return paths >= (s.min ?? 0);
}

/** Whole-command shapes, default deny (spec 4A steps 1 to 5). */
export function shellOk(command: string, cwd: string, home: string): boolean {
  try {
    if (typeof command !== 'string') return false;
    // Strip at the very end only: the pipe to Select-Object, then the stderr merge. Nothing else is stripped.
    const c = command.replace(/ \| Select-Object -(?:First|Last) \d+$/, '').replace(/ 2>&1$/, '');
    if (!/^[A-Za-z0-9 _./\\:=,@+-]+$/.test(c)) return false;
    const tokens = c.split(' ');
    if (tokens.includes('')) return false; // two spaces in a row, or a space at either end
    return SHAPES.some((s) => matches(s, tokens, cwd, home));
  } catch {
    return false;
  }
}

/** The playbook trust list: every line is `npm test`, `tests pass`, or passes shellOk. */
export function fenceTrusts(commands: string[], cwd: string, home: string): boolean {
  return commands.every((c) => c === 'npm test' || c === 'tests pass' || shellOk(c, cwd, home));
}
