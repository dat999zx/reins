import picomatch from 'picomatch';
import { posix } from 'node:path';
import type { Policy } from './compile.js';

export const WRITE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Windows calls its shell tool PowerShell; treat it exactly like Bash (Phase 0 finding 6).
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);

/** Normalise a tool path: `\` → `/`, `.`/`..` resolved, then relative to cwd when it lies inside it. */
export function relPath(p: string, cwd: string): string {
  const norm = posix.normalize(p.replace(/\\/g, '/'));
  if (!cwd) return norm.replace(/^\.\//, '');
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  // Windows paths are case-insensitive, and drive letters arrive in either case.
  const inside = /^[a-z]:\//i.test(root)
    ? norm.toLowerCase().startsWith(root.toLowerCase())
    : norm.startsWith(root);
  return inside ? norm.slice(root.length) : norm.replace(/^\.\//, '');
}

function guardHit(policy: Policy, path: string, cwd: string): string | undefined {
  const rel = relPath(path, cwd);
  // Windows and macOS filesystems ignore case, so `MIGRATIONS/x` is the same file as `migrations/x`.
  // Matching without case everywhere is the safe side: a guard may over-block, never under-block.
  return policy.guards.find((g) => picomatch(g, { dot: true, nocase: true })(rel));
}

/**
 * The one policy check (plan 6.4): the refusal reason written for the agent, or null to pass.
 * Reasons say "read-only" or "guarded" so the receipt can count them.
 */
export function checkTool(policy: Policy, tool: string, input: any, cwd: string): string | null {
  const isWrite = WRITE_TOOLS.has(tool);
  const isShell = SHELL_TOOLS.has(tool);
  if (!isWrite && !isShell) return null;

  if (policy.pendingGate) {
    return `Blocked by Reins: waiting for gate "${policy.pendingGate}". Edits unlock after it passes.`;
  }
  if (policy.mode === 'read-only') {
    // ponytail: every shell command counts as a write in a read-only step; a read-only shell
    // allowlist (ls, git log, …) would need a real command parser.
    return isShell
      ? 'Blocked by Reins: this step is read-only, so shell commands are blocked. Use Read, Grep and Glob.'
      : 'Blocked by Reins: this step is read-only. Finish the step; edits unlock after the gate.';
  }
  if (isShell && !policy.allowShell) {
    return 'Blocked by Reins: shell commands are not allowed in this step.';
  }

  if (isWrite) {
    const p = input?.file_path ?? input?.path ?? input?.notebook_path;
    const g = typeof p === 'string' ? guardHit(policy, p, cwd) : undefined;
    return g ? `Blocked by Reins: ${relPath(p, cwd)} is guarded (${g}). Do not touch it.` : null;
  }

  // ponytail: a shell command is refused when any word in it names a guarded path, reads
  // included. Conservative on purpose; it misses paths built at runtime (variables, globs).
  const words = String(input?.command ?? '').split(/[\s"'`;|&<>()]+/).filter(Boolean);
  for (const w of words) {
    const g = guardHit(policy, w, cwd);
    if (g) return `Blocked by Reins: this command touches ${relPath(w, cwd)}, which is guarded (${g}).`;
  }
  return null;
}
