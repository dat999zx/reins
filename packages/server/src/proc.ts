import { spawnSync } from 'node:child_process';

/**
 * Kill a process and everything it started. On Windows a plain kill leaves the children
 * running (Phase 0 P0.5b), so use taskkill /T. Elsewhere the child was spawned detached,
 * so its pid is also its process group.
 */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
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
