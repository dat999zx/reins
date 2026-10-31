import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// On Windows a hard kill of the server ends its direct children and leaves their children (measured, M9 spec 3). So the shell is not a direct child: a detached
// holder starts it and sits on a pipe from the server. The pipe closing means the server is gone, however it died; the holder ends the tree it still owns.
// argv: the command. No pid is stored, so none can be reused.
export const HOLDER = `
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const c = spawn(process.argv[1], { shell: true, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
const end = () => {
  const sys = path.win32.join(process.env.SystemRoot ?? 'C:\\\\Windows', 'System32');
  if (process.platform === 'win32') spawnSync(path.win32.join(sys, 'taskkill.exe'), ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, cwd: sys });
  else process.kill(0, 'SIGKILL');
  process.exit(1);
};
c.on('exit', (code) => process.exit(code ?? 1));
process.stdin.on('end', end).on('error', end).resume();
`;

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
