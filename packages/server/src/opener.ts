import fs from 'node:fs';
import path from 'node:path';

export const URL_PATTERN = /^http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]{64}$/;

export interface Spawned { on(event: 'error', listener: (e: Error) => void): unknown; unref(): void }
export type Spawn = (command: string, args: string[], options: { shell: false; detached: true; stdio: 'ignore'; windowsHide: true }) => Spawned;

/** Never puts the URL on a command line on darwin/linux: a browser's argv is readable by other local users. */
export function openUrl(url: string, o: { platform: string; dir: string; spawn: Spawn; err: (line: string) => void }): void {
  const paste = () => o.err(`Open this address in your browser: ${url}`);
  if (!URL_PATTERN.test(url)) return paste();
  let command: string;
  let args: string[];
  if (o.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (o.platform === 'darwin' || o.platform === 'linux') {
    const file = path.join(o.dir, 'open.html');
    fs.mkdirSync(o.dir, { recursive: true });
    fs.rmSync(file, { force: true }); // mode applies only on create, so never reuse a looser file
    fs.writeFileSync(file, `<meta http-equiv="refresh" content="0;url=${url}">\n<a href="${url}">Open Reins</a>\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    command = o.platform === 'darwin' ? 'open' : 'xdg-open';
    args = [file];
  } else {
    return;
  }
  const child = o.spawn(command, args, { shell: false, detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', paste);
  child.unref();
}
