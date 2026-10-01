import { spawn } from 'node:child_process';
import path from 'node:path';

// The Explorer-style dialog (IFileDialog): it has an address bar and a Folder: box you can paste a path into, unlike FolderBrowserDialog.
const WINDOWS_SCRIPT = `try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ReinsPick {
  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")] class FileOpenDialog {}
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }
  [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint c, IntPtr t);
    void SetFileTypeIndex(uint i);
    void GetFileTypeIndex(out uint i);
    void Advise(IntPtr p, out uint c);
    void Unadvise(uint c);
    void SetOptions(uint o);
    void GetOptions(out uint o);
    void SetDefaultFolder(IShellItem i);
    void SetFolder(IShellItem i);
    void GetFolder(out IShellItem i);
    void GetCurrentSelection(out IShellItem i);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string n);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string n);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void GetResult(out IShellItem i);
  }
  // 0 = a folder was picked, 1 = cancelled, 2 = failed.
  public static int Run(IntPtr owner, out string path) {
    path = null;
    IFileDialog d = (IFileDialog)new FileOpenDialog();
    uint o; d.GetOptions(out o);
    d.SetOptions(o | 0x20 | 0x40); // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
    d.SetTitle("Choose a project folder");
    int hr = d.Show(owner);
    if (hr == unchecked((int)0x800704C7)) return 1; // ERROR_CANCELLED
    if (hr != 0) return 2;
    IShellItem item; d.GetResult(out item);
    item.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
    return 0;
  }
}
"@
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0
  $owner.Show(); $owner.Activate()
  $path = $null
  $code = [ReinsPick]::Run($owner.Handle, [ref]$path)
  if ($code -eq 0) { [Console]::Out.Write($path) }
  exit $code
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
