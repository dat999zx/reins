// The CLI entry point hands the cleaned env to the browser opener and the folder picker (cli.ts). child_process is stubbed:
// nothing is opened and no dialog appears; the options of each spawn are recorded.
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const spawned = vi.hoisted(() => [] as Array<{ command: string; env: NodeJS.ProcessEnv | undefined }>);
vi.mock('node:child_process', async (orig) => {
  const m = await orig<typeof import('node:child_process')>();
  const stub = (command: string, ...rest: unknown[]) => {
    const opts = rest.find((r) => r && typeof r === 'object' && !Array.isArray(r)) as { env?: NodeJS.ProcessEnv } | undefined;
    spawned.push({ command, env: opts?.env });
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), unref() {}, kill() { return true; }, pid: 0 });
    setImmediate(() => { child.stdout.emit('data', Buffer.from(process.cwd())); child.emit('close', 0, null); });
    return child;
  };
  return { ...m, spawn: stub as unknown as typeof m.spawn };
});

const { main } = await import('../src/cli.js');
const { tempHome } = await import('./mods-harness.js');

const KEY = 'sk-test-0123456789abcdef';

describe('cli.ts: the cleaned env reaches the opener and the picker', () => {
  it('the browser opener and the folder dialog are started without an installed keyEnv var or a REINS_ var', async () => {
    const t = tempHome();
    try {
      const reins = path.join(t.home, '.reins');
      fs.mkdirSync(path.join(reins, 'mods', 'keyed'), { recursive: true });
      fs.writeFileSync(path.join(reins, 'mods', 'keyed', 'mod.json'), JSON.stringify({
        reins: 1, id: 'keyed', kind: 'provider', version: '1.0.0', label: 'Keyed', protocol: 'claude-code-cli', baseUrl: 'https://example.com',
        auth: { style: 'bearer', keyEnv: ['X_API_KEY'] }, defaultModel: 'm', models: [{ id: 'm' }],
      }));
      // no claude on this PATH: the probe at start-up spawns nothing
      const env = { REINS_HOME: t.home, PATH: path.join(t.home, 'empty'), X_API_KEY: KEY, DISPLAY: ':0', KEEP_ME: 'kept' };
      const stdout = new PassThrough();
      let out = '';
      stdout.on('data', (d) => (out += d));
      let stop!: () => void;
      const stopped = new Promise<void>((resolve) => { stop = resolve; });
      const running = main([], { stdout, stderr: new PassThrough(), stdin: new PassThrough(), env, stop: stopped });
      const url = await new Promise<URL>((resolve) => {
        const timer = setInterval(() => {
          const m = /http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]{64}/.exec(out);
          if (m) { clearInterval(timer); resolve(new URL(m[0])); }
        }, 20);
      });
      const token = url.hash.slice('#token='.length);
      const picked = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: Number(url.port), path: '/api/pick-folder', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-length': '0' } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end();
      });
      expect(picked).toBe(200);
      stop();
      expect(await running).toBe(0);

      const opener = spawned.filter((s) => s.command === 'cmd' || s.command === 'open' || s.command === 'xdg-open');
      const dialog = spawned.filter((s) => ['powershell', 'osascript', 'zenity', 'kdialog'].includes(s.command));
      expect(opener).toHaveLength(1);
      expect(dialog.length).toBeGreaterThanOrEqual(1);
      for (const s of [...opener, ...dialog]) {
        expect(s.env, `${s.command} got no env at all`).toBeDefined();
        expect(s.env).not.toHaveProperty('X_API_KEY');
        expect(s.env).not.toHaveProperty('REINS_HOME');
        expect(s.env!.KEEP_ME).toBe('kept');
      }
    } finally {
      t.cleanup();
    }
  }, 60_000);
});
