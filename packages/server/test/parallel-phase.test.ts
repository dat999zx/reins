// M8 S1: the run row (phase and job), interrupted on restart, and checkSpec.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkSpec } from '../src/parallel.js';
import { recover } from '../src/recover.js';
import { KEY_IN_IDENTITY, openStore, redactingStore, type ParallelJob } from '../src/store.js';
import { Redactor, setKey } from '../src/secrets.js';
import { cleanup, tmpDir } from './http-helpers.js';

const KEY = 'sk-test-0123456789abcdef';
afterEach(cleanup);

const job = (extra: Partial<ParallelJob> = {}): ParallelJob => ({
  repo: '/r', branch: 'main', head: 'abc', folder: '/f', tasks: [], words: '', merged: [], notMerged: [], gateResult: 'not run', ...extra,
});

describe('run row: phase and job (M8 T1)', () => {
  it('reads back phase and job when given, and neither key when not', () => {
    const s = openStore(':memory:');
    const a = s.createParallel({ id: 'a1', title: 'a', tasks: [], phase: 'setup', job: job({ gate: 'g' }) });
    expect(a.phase).toBe('setup');
    expect(a.job).toEqual(job({ gate: 'g' }));
    expect(s.listParallel()[0]!.job).toEqual(job({ gate: 'g' }));
    const b = s.createParallel({ id: 'b2', title: 'b', tasks: [] });
    expect('phase' in b).toBe(false);
    expect('job' in b).toBe(false);
    s.close();
  });

  it('patchParallel keeps what it is not given, and an unknown id does nothing', () => {
    const s = openStore(':memory:');
    s.createParallel({ id: 'a1', title: 'a', tasks: [], phase: 'setup', job: job({ gate: 'g', words: 'old' }) });
    s.patchParallel('a1', { phase: 'gating' });
    expect(s.listParallel()[0]).toMatchObject({ phase: 'gating', job: job({ gate: 'g', words: 'old' }) });
    s.patchParallel('a1', { job: { words: 'x' } });
    expect(s.listParallel()[0]).toMatchObject({ phase: 'gating', job: job({ gate: 'g', words: 'x' }) });
    s.patchParallel('a1', { tasks: [{ name: 't', sessionId: 's1' }] });
    expect(s.listParallel()[0]).toMatchObject({ phase: 'gating', tasks: [{ name: 't', sessionId: 's1' }], job: job({ gate: 'g', words: 'x' }) });
    s.patchParallel('a1', { job: { words: '' } });
    expect(s.listParallel()[0]!.job!.words).toBe('');
    s.patchParallel('nope', { phase: 'done' });
    expect(s.listParallel()).toHaveLength(1);
    s.close();
  });

  it('a job column that does not parse reads as no job', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-phase-'));
    const file = path.join(dir, 'reins.db');
    const s = openStore(file);
    s.createParallel({ id: 'a1', title: 'a', tasks: [], phase: 'running', job: job() });
    s.close();
    const raw = new DatabaseSync(file);
    raw.prepare('update parallel_runs set job = ? where id = ?').run('not json', 'a1');
    raw.close();
    const again = openStore(file);
    const row = again.listParallel()[0]!;
    expect('job' in row).toBe(false);
    expect(row.phase).toBe('running');
    again.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a store made with the M5 schema is migrated and keeps its row', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-phase-'));
    const file = path.join(dir, 'reins.db');
    const old = new DatabaseSync(file);
    old.exec('create table parallel_runs (id text primary key, title text not null, cap_usd real, tasks text not null, created_at integer not null)');
    old.prepare('insert into parallel_runs (id, title, cap_usd, tasks, created_at) values (?, ?, ?, ?, ?)').run('o1', 'old', null, '[]', 1);
    old.close();
    const s = openStore(file);
    expect(s.listParallel()).toEqual([{ id: 'o1', title: 'old', createdAt: 1, tasks: [] }]);
    s.createParallel({ id: 'n1', title: 'new', tasks: [], phase: 'setup', job: job() });
    expect(s.listParallel().find((r) => r.id === 'n1')).toMatchObject({ phase: 'setup', job: job() });
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('through redactingStore: a key in the job never reaches the raw store, a key in a sessionId is refused', () => {
    const dir = tmpDir();
    setKey(dir, 'a', KEY);
    const raw = openStore(':memory:');
    const store = redactingStore(raw, new Redactor({ home: dir, env: {}, keyEnvNames: () => [] }));
    store.createParallel({ id: 'p1', title: 't', tasks: [], phase: 'setup', job: job({ gate: `run ${KEY}` }) });
    expect(JSON.stringify(raw.listParallel())).not.toContain(KEY);
    store.patchParallel('p1', { job: { words: `out ${KEY}` } });
    expect(JSON.stringify(raw.listParallel())).not.toContain(KEY);
    expect(raw.listParallel()[0]!.job!.words).toContain('[key Reins]');
    expect(() => store.patchParallel('p1', { tasks: [{ name: 'n', sessionId: `s-${KEY}` }] })).toThrow(KEY_IN_IDENTITY);
    store.close();
  });
});

describe('interrupted on restart (M8 T2)', () => {
  it('setup, merging and gating go interrupted; the rest stay; a second recover changes nothing', () => {
    const s = openStore(':memory:');
    const phases = ['setup', 'merging', 'gating', 'running', 'done', 'failed'] as const;
    for (const p of phases) s.createParallel({ id: `r-${p}`, title: p, tasks: [], phase: p, job: job({ gate: 'g', words: 'keep' }) });
    s.createParallel({ id: 'r-none', title: 'none', tasks: [] });
    recover(s);
    const by = (id: string) => s.listParallel().find((r) => r.id === id)!;
    for (const p of ['setup', 'merging', 'gating']) {
      expect(by(`r-${p}`).phase).toBe('interrupted');
      expect(by(`r-${p}`).job!.words).toBe(`The server stopped during ${p}; anything it started may still be running.`);
      expect(by(`r-${p}`).job!.gate).toBe('g');
    }
    for (const p of ['running', 'done', 'failed']) {
      expect(by(`r-${p}`).phase).toBe(p);
      expect(by(`r-${p}`).job!.words).toBe('keep');
    }
    expect('phase' in by('r-none')).toBe(false);
    const before = JSON.stringify(s.listParallel());
    recover(s);
    expect(JSON.stringify(s.listParallel())).toBe(before);
    s.close();
  });
});

describe('checkSpec (M8 T3)', () => {
  const task = { name: 'Task A', playbook: 'p.md' };
  const ok = { tasks: [task] };
  const err = (b: unknown) => checkSpec(b);

  it.each([
    [null, 'The tasks file must be a JSON object.'],
    [[], 'The tasks file must be a JSON object.'],
    ['x', 'The tasks file must be a JSON object.'],
    [{ ...ok, title: ' ' }, 'title must be a non-empty string.'],
    [{ ...ok, capUsd: 0 }, 'capUsd must be a number above 0.'],
    [{ ...ok, approve: 'all' }, 'approve must be "fence".'],
    [{ ...ok, install: '' }, 'install must be a non-empty string.'],
    [{ ...ok, gate: 3 }, 'gate must be a non-empty string.'],
    [{ ...ok, gate: 'g', gateRetry: ' ' }, 'gateRetry must be a non-empty string.'],
    [{ ...ok, gateRetry: 'g' }, 'gateRetry needs gate.'],
    [{ ...ok, reports: '../x' }, 'reports must be a path inside the repo.'],
    [{ ...ok, copy: 'a' }, 'copy must be a list of paths inside the repo.'],
    [{ ...ok, copy: ['a', '../b'] }, 'copy must be a list of paths inside the repo.'],
    [{}, 'tasks must be a non-empty array.'],
    [{ tasks: [] }, 'tasks must be a non-empty array.'],
    [{ tasks: [{ playbook: 'p.md' }] }, 'each task needs a non-empty name.'],
    [{ tasks: [{ name: 'A' }] }, 'Task "A" has no playbook.'],
    [{ tasks: [{ name: 'A', playbook: '../p.md' }] }, 'task A: playbook must be a path inside the repo.'],
    [{ tasks: [{ name: 'A b', playbook: 'p' }, { name: 'a-B', playbook: 'p' }] }, 'Task name "a-B" is empty or repeats another once lower-cased.'],
    [{ tasks: [{ name: '!!!', playbook: 'p' }] }, 'Task name "!!!" is empty or repeats another once lower-cased.'],
    [{ tasks: [{ name: 'A', playbook: 'p', model: '' }] }, 'task A: model must be a string.'],
    [{ tasks: [{ name: 'A', playbook: 'p', model: 'x\u0001' }] }, 'task A: model must be a short name with no control characters.'],
    [{ tasks: [{ name: 'A', playbook: 'p', effort: 3 }] }, 'task A: effort must be a string.'],
  ])('refuses %j with its words', (b, error) => {
    expect(err(b)).toEqual({ error });
  });

  const bad = ['../x', 'a/../b', 'a\\..\\b', '.. /x', 'a/. /b', '/etc/passwd', 'C:\\x', 'C:x', 'a:b', 'a\0b'];
  const good = ['docs/plan/a.reins.md', 'docs/spec/', 'a..b/c'];
  it.each(bad)('refuses the path %j in copy, playbook and reports', (p) => {
    expect('error' in checkSpec({ ...ok, copy: [p] })).toBe(true);
    expect('error' in checkSpec({ tasks: [{ name: 'A', playbook: p }] })).toBe(true);
    expect('error' in checkSpec({ ...ok, reports: p })).toBe(true);
  });
  it.each(good)('accepts the path %j in copy, playbook and reports', (p) => {
    expect('error' in checkSpec({ ...ok, copy: [p] })).toBe(false);
    expect('error' in checkSpec({ tasks: [{ name: 'A', playbook: p }] })).toBe(false);
    expect('error' in checkSpec({ ...ok, reports: p })).toBe(false);
  });

  it('a minimal file gets the defaults and no optional keys; slug is computed; unknown keys are dropped', () => {
    const r = checkSpec({ tasks: [{ name: 'Task A', playbook: 'p.md', slug: 'evil', extra: 1 }], other: 2 });
    expect(r).toEqual({ value: { title: 'parallel run', copy: [], tasks: [{ name: 'Task A', slug: 'task-a', playbook: 'p.md' }] } });
    const v = 'value' in r ? r.value : ({} as never);
    for (const k of ['install', 'gate', 'gateRetry', 'reports', 'capUsd', 'approve']) expect(k in v).toBe(false);
  });

  it('keeps every field it is given', () => {
    const r = checkSpec({
      title: 'T', capUsd: 2, approve: 'fence', install: 'i', gate: 'g', gateRetry: 'r', reports: 'docs/plan', copy: ['a'],
      tasks: [{ name: 'A', playbook: 'p', model: 'm', effort: 'e' }],
    });
    expect(r).toEqual({ value: { title: 'T', capUsd: 2, approve: 'fence', install: 'i', gate: 'g', gateRetry: 'r', reports: 'docs/plan', copy: ['a'], tasks: [{ name: 'A', slug: 'a', playbook: 'p', model: 'm', effort: 'e' }] } });
  });
});
