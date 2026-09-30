import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { releaseLock, takeLock } from '../src/lock.js';

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-lock-')), 'serve.lock');
const me = { pid: process.pid, port: 4000, token: 't1' };

describe('serve.lock (3b.3)', () => {
  it('takes a free lock and writes pid, port and token', () => {
    const f = file();
    expect(takeLock(f, me)).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual(me);
  });
  it('a second instance is refused and told who is running', () => {
    const f = file();
    takeLock(f, me);
    expect(takeLock(f, { pid: 999999, port: 5000, token: 't2' }, () => true)).toEqual({ ok: false, running: me });
  });
  it('a lock whose pid is dead is replaced', () => {
    const f = file();
    takeLock(f, { pid: 999999, port: 1, token: 'old' });
    expect(takeLock(f, me, () => false)).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(f, 'utf8')).token).toBe('t1');
  });
  it('a corrupt lock file is replaced, and no temp file is left behind', () => {
    const f = file();
    fs.writeFileSync(f, 'not json');
    expect(takeLock(f, me)).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual(me);
    expect(fs.readdirSync(path.dirname(f))).toEqual(['serve.lock']);
  });
  it('a refused instance leaves no temp file either', () => {
    const f = file();
    takeLock(f, me);
    takeLock(f, { pid: 999999, port: 5000, token: 't2' }, () => true);
    expect(fs.readdirSync(path.dirname(f))).toEqual(['serve.lock']);
  });
  it('the file mode is 0600 (POSIX; a no-op on Windows)', () => {
    if (process.platform === 'win32') return;
    const f = file();
    takeLock(f, me);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });
  it('releaseLock removes only its own lock', () => {
    const f = file();
    takeLock(f, me);
    releaseLock(f, 12345);
    expect(fs.existsSync(f)).toBe(true);
    releaseLock(f, me.pid);
    expect(fs.existsSync(f)).toBe(false);
  });
});
