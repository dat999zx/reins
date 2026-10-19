import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Kill a process and everything it started. On Windows a plain kill leaves the children
 * running (Phase 0 P0.5b), so use taskkill /T. Elsewhere the child was spawned detached,
 * so its pid is also its process group.
 */
export function killTree(pid: number | undefined, env?: NodeJS.ProcessEnv): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    // Locating a system file, not building the child's env: this server's own SystemRoot says where Windows is. The helper is started by its
    // absolute path and with the system folder as its cwd, so a file in the project (or in this server's cwd) can never stand in for it.
    const sys = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const exe = path.win32.join(sys, 'taskkill.exe');
    // Absent: nothing is started; the caller's timers finish the call.
    if (!fs.existsSync(exe)) return;
    spawnSync(exe, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, cwd: sys, ...(env ? { env } : {}) });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}
