import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KEY_IN_IDENTITY, openStore, redactingStore } from '../src/store.js';
import { Redactor, setKey } from '../src/secrets.js';
import { cleanup, tmpDir } from './http-helpers.js';

const KEY = 'sk-test-0123456789abcdef';
afterEach(cleanup);

describe('parallel run record (M5 T2)', () => {
  it('round trip, newest first, cap set and cleared, delete', async () => {
    const s = openStore(':memory:');
    const a = s.createParallel({ id: 'a1', title: 'first', capUsd: 5, tasks: [{ name: 't1', sessionId: 's1' }, { name: 't2', sessionId: 's2' }] });
    expect(a).toEqual({ id: 'a1', title: 'first', capUsd: 5, createdAt: expect.any(Number), tasks: [{ name: 't1', sessionId: 's1' }, { name: 't2', sessionId: 's2' }] });
    await new Promise((r) => setTimeout(r, 3));
    const b = s.createParallel({ id: 'b2', title: 'second', tasks: [] });
    expect(b).not.toHaveProperty('capUsd');
    expect(s.listParallel().map((x) => x.id)).toEqual(['b2', 'a1']);
    s.setParallelCap('b2', 2.5);
    expect(s.listParallel()[0]!.capUsd).toBe(2.5);
    s.setParallelCap('b2', null);
    expect(s.listParallel()[0]).not.toHaveProperty('capUsd');
    s.deleteParallel('b2');
    expect(s.listParallel().map((x) => x.id)).toEqual(['a1']);
    s.close();
  });

  it('a reopened file store keeps the row', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-parallel-'));
    const file = path.join(dir, 'reins.db');
    const s = openStore(file);
    s.createParallel({ id: 'a1', title: 'kept', capUsd: 1, tasks: [{ name: 't', sessionId: 's' }] });
    s.close();
    const again = openStore(file);
    expect(again.listParallel()).toEqual([{ id: 'a1', title: 'kept', capUsd: 1, createdAt: expect.any(Number), tasks: [{ name: 't', sessionId: 's' }] }]);
    again.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('through redactingStore: a key in a sessionId or id is refused, a key in title or name reads back redacted', () => {
    const dir = tmpDir();
    setKey(dir, 'a', KEY);
    const store = redactingStore(openStore(':memory:'), new Redactor({ home: dir, env: {}, keyEnvNames: () => [] }));
    expect(() => store.createParallel({ id: 'p1', title: 't', tasks: [{ name: 'n', sessionId: `s-${KEY}` }] })).toThrow(KEY_IN_IDENTITY);
    expect(() => store.createParallel({ id: `p-${KEY}`, title: 't', tasks: [] })).toThrow(KEY_IN_IDENTITY);
    const row = store.createParallel({ id: 'p2', title: `title ${KEY}`, tasks: [{ name: `name ${KEY}`, sessionId: 's' }] });
    expect(JSON.stringify(row)).not.toContain(KEY);
    const [read] = store.listParallel();
    expect(JSON.stringify(read)).not.toContain(KEY);
    expect(read!.title).toContain('[key Reins]');
    expect(read!.tasks[0]!.name).toContain('[key Reins]');
    store.close();
  });
});
