import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface FoundClaude {
  path: string;
  source: 'REINS_CLAUDE' | 'PATH' | 'native installer';
}

/**
 * Find the real claude binary (plan 15b 2.3), never the npm .cmd/.ps1 shim: an interrupt
 * through the shim orphans claude.exe (Phase 0 P0.5b). Order: REINS_CLAUDE, claude on PATH
 * (an npm shim resolved to its package's bin/claude.exe), then the native installer's path.
 */
export function findClaude(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir()
): FoundClaude | undefined {
  if (env.REINS_CLAUDE) return { path: env.REINS_CLAUDE, source: 'REINS_CLAUDE' };
  const win = platform === 'win32';
  const dirs = (env.PATH ?? env.Path ?? '').split(win ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    if (win) {
      const exe = path.join(dir, 'claude.exe');
      if (isFile(exe)) return { path: exe, source: 'PATH' };
      // The npm shim claude.cmd runs "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe".
      const npmExe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (isFile(path.join(dir, 'claude.cmd')) && isFile(npmExe)) return { path: npmExe, source: 'PATH' };
    } else {
      const bin = path.join(dir, 'claude');
      if (isFile(bin)) return { path: fs.realpathSync(bin), source: 'PATH' };
    }
  }
  const native = path.join(home, '.local', 'bin', win ? 'claude.exe' : 'claude');
  if (isFile(native)) return { path: native, source: 'native installer' };
  return undefined;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The command line to start `bin`: a .js/.mjs entry (a JS install, or the test fake) runs under this Node. */
export function claudeCommand(bin: string, args: string[]): [string, string[]] {
  return /\.(c|m)?js$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
}
