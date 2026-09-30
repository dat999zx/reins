import { spawn } from 'node:child_process';
import path from 'node:path';

const WINDOWS_SCRIPT = `try {
  Add-Type -AssemblyName System.Windows.Forms
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) } else { exit 1 }
} catch { exit 2 }
`;

type Candidate = [command: string, args: string[]];
const CANDIDATES: Record<string, Candidate[]> = {
  win32: [['powershell', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')]]],
  darwin: [['osascript', ['-e', 'POSIX path of (choose folder)']]],
  linux: [['zenity', ['--file-selection', '--directory']], ['kdialog', ['--getexistingdirectory']]],
};

export function parsePickerOutput(stdout: string): string | null {
  const s = stdout.replace(/^\uFEFF/, '').trim();
  return s === '' ? null : path.resolve(s);
}

export function pickerExit(platform: string, code: number | null, signal: string | null, stderr: string): 'path' | 'cancel' | 'reject' {
  if (signal !== null) return 'reject';
  if (code === 0) return 'path';
  if (code === 1) return platform !== 'darwin' || stderr.includes('(-128)') ? 'cancel' : 'reject';
  return 'reject';
}

type Ran = { missing: true } | { code: number | null; signal: string | null; stdout: string; stderr: string };

function run([command, args]: Candidate, signal: AbortSignal): Promise<Ran> {
  return new Promise((resolve, reject) => {
    // No windowsHide: it could hide the dialog itself.
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    const kill = () => { child.kill(); };
    signal.addEventListener('abort', kill, { once: true });
    child.once('error', (e: NodeJS.ErrnoException) => {
      signal.removeEventListener('abort', kill);
      if (e.code === 'ENOENT') resolve({ missing: true });
      else reject(new Error('The folder picker could not start.'));
    });
    child.once('close', (code, sig) => {
      signal.removeEventListener('abort', kill);
      resolve({ code, signal: sig, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

export async function pickFolder(
  signal: AbortSignal,
  o: { platform?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const candidates = CANDIDATES[platform];
  if (!candidates) throw new Error('This platform has no folder picker.');
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) throw new Error('No display: cannot show a folder dialog.');
  for (const candidate of candidates) {
    if (signal.aborted) return null;
    const r = await run(candidate, signal);
    if ('missing' in r) continue;
    if (signal.aborted) return null;
    const verdict = pickerExit(platform, r.code, r.signal, r.stderr);
    if (verdict === 'reject') throw new Error(`The folder picker failed${r.code !== null ? ` (exit ${r.code})` : ''}.`);
    return verdict === 'path' ? parsePickerOutput(r.stdout) : null;
  }
  throw new Error(`No folder picker found${platform === 'linux' ? ' (install zenity or kdialog)' : ''}.`);
}
