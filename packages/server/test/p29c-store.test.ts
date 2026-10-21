// Milestone P, Task 29 phase C (S7): sessions made before P carry engine `claude`; opening the store moves them to `claude-code`, once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore } from '../src/store.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const dbFile = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29c-store-'));
  dirs.push(d);
  return path.join(d, 'reins.db');
};

describe('the store at open', () => {
  it('moves engine claude to claude-code, keeps the CLI session id and everything else, and leaves other ids alone', () => {
    const file = dbFile();
    const a = openStore(file);
    a.createSession({ id: 'old', cwd: 'C:\\work', engine: 'claude', model: 'm', title: 'kept' });
    a.updateSession('old', { engineSessionId: 'cli-session-1' });
    a.createSession({ id: 'other', cwd: 'C:\\work', engine: 'deepseek' });
    a.createSession({ id: 'already', cwd: 'C:\\work', engine: 'claude-code' });
    a.createSession({ id: 'lookalike', cwd: 'C:\\work', engine: 'claude-x' });
    a.close();

    const b = openStore(file);
    const get = (id: string) => b.getSession(id)!;
    expect(get('old')).toMatchObject({ engine: 'claude-code', engineSessionId: 'cli-session-1', model: 'm', title: 'kept', cwd: 'C:\\work' });
    expect(get('other').engine).toBe('deepseek');
    expect(get('already').engine).toBe('claude-code');
    expect(get('lookalike').engine).toBe('claude-x');
    b.close();
  });

  it('opening again changes nothing (idempotent)', () => {
    const file = dbFile();
    const a = openStore(file);
    a.createSession({ id: 'old', cwd: 'C:\\work', engine: 'claude' });
    a.close();
    const b = openStore(file);
    const once = JSON.stringify(b.listSessions());
    b.close();
    const c = openStore(file);
    expect(JSON.stringify(c.listSessions())).toBe(once);
    expect(c.getSession('old')!.engine).toBe('claude-code');
    c.close();
  });

  it('an empty store opens', () => {
    const s = openStore(dbFile());
    expect(s.listSessions()).toEqual([]);
    s.close();
  });
});
