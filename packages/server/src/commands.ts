import { spawn } from 'node:child_process';
import { killTree } from './proc.js';

export interface CommandOptions {
  cwd: string;
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
}

const KEEP_LINES = 200;
const KEEP_CHARS = 256 * 1024;

/**
 * Run a workflow command (plan 15b 2.4): through the shell, since it is the user's own command
 * line, in the project folder, with a timeout. Pass = exit 0. stdout and stderr are kept
 * interleaved and trimmed to the last 200 lines, returned as `stdout` (the evidence).
 */
export function runCommand(cmd: string, o: CommandOptions): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const timeoutMs = o.timeoutMs ?? 10 * 60_000;
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd: o.cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (d: Buffer) => {
      const s = d.toString('utf8');
      o.onOutput?.(s);
      out += s;
      if (out.length > 2 * KEEP_CHARS) out = out.slice(-KEEP_CHARS);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    const finish = (code: number) => {
      clearTimeout(timer);
      if (timedOut) out += `\n[Reins: timed out after ${Math.round(timeoutMs / 1000)} s and was killed]\n`;
      const lines = out.split(/\r?\n/);
      if (lines[lines.length - 1] === '') lines.pop();
      resolve({ exitCode: timedOut && code === 0 ? 1 : code, stdout: lines.slice(-KEEP_LINES).join('\n') + '\n', stderr: '' });
    };
    child.on('error', (e) => {
      out += `\n[Reins: could not start the command: ${e.message}]\n`;
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}
