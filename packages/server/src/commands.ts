import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { HOLDER, killTree } from './proc.js';

export interface CommandOptions {
  cwd: string;
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
  /** The child's environment, worked out when it starts (callers pass `shellEnvFrom(...)`); none = this process's. */
  env?: () => NodeJS.ProcessEnv;
  /** Ends the command's whole process tree. Already aborted: nothing starts and the result is exit 1. */
  signal?: AbortSignal;
}

const KEEP_LINES = 200;
const KEEP_CHARS = 256 * 1024;
// After the holder is told to stop: how long it gets to end its own tree before its tree is killed from here.
const STOP_GRACE_MS = 3000;

/**
 * Run a workflow command (plan 15b 2.4): through the shell, since it is the user's own command
 * line, in the project folder, with a timeout. Pass = exit 0. stdout and stderr are kept
 * interleaved and trimmed to the last 200 lines, returned as `stdout` (the evidence).
 */
export function runCommand(cmd: string, o: CommandOptions): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const timeoutMs = o.timeoutMs ?? 10 * 60_000;
  return new Promise((resolve) => {
    // An abort listener never fires for a signal that is already aborted, and close() would wait for a child nobody can stop.
    if (o.signal?.aborted) return resolve({ exitCode: 1, stdout: '', stderr: '' });
    // Asked here, at the start of THIS command: a provider installed or switched off since the workflow began is seen.
    const env = o.env?.();
    const child = spawn(process.execPath, ['-e', HOLDER, '--', cmd], {
      cwd: o.cwd,
      ...(env ? { env } : {}),
      windowsHide: true,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.on('error', () => {}); // never written to: it stays open while the server lives, and closing it tells the holder to stop
    let out = '';
    const take = (s: string) => {
      if (!s) return;
      o.onOutput?.(s);
      out += s;
      if (out.length > 2 * KEEP_CHARS) out = out.slice(-KEEP_CHARS);
    };
    // One decoder per stream: a character cut between two chunks is decoded whole, so nothing downstream sees a broken one.
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    child.stdout.on('data', (d: Buffer) => take(decoders[0]!.write(d)));
    child.stderr.on('data', (d: Buffer) => take(decoders[1]!.write(d)));

    // Stopping goes through the holder, the same way as when the server dies: it knows its shell, so no tree snapshot can miss a
    // process the holder is still starting (killing the holder's tree from here could orphan a shell started a moment later, M9).
    // The tree kill from here is only the fallback for a holder that does not end.
    let stopping = false;
    let grace: NodeJS.Timeout | undefined;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      child.stdin.end();
      grace = setTimeout(() => killTree(child.pid, o.env?.() ?? env), STOP_GRACE_MS); // the kill helper's env is worked out now
    };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    o.signal?.addEventListener('abort', stop, { once: true });

    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      o.signal?.removeEventListener('abort', stop);
      for (const d of decoders) take(d.end());
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
    // A stopped command finishes when the holder exits, not when the last pipe closes: a process that escaped the kill can hold
    // the pipe open for ever, and a server stop would wait on it. The short wait lets the last output arrive.
    child.on('exit', (code) => { if (stopping) setTimeout(() => finish(code ?? 1), 200); });
  });
}
