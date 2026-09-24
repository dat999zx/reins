import { describe, it, expect } from 'vitest';
import { checkTool } from '../src/policy.js';

// Reviewer probes: guard bypass attempts on Windows paths.
const policy: any = { mode: 'write', guards: ['migrations/**'], allowShell: true };
const cwd = 'D:\\coding\\reins-scratch';

describe('reviewer probe: guard bypasses', () => {
  it('A: upper-case dir on a case-insensitive filesystem', () => {
    expect(checkTool(policy, 'Edit', { file_path: 'D:\\coding\\reins-scratch\\MIGRATIONS\\0001.sql' }, cwd)).toMatch(/guarded/);
  });
  it('B: dot-dot path that resolves into the guard', () => {
    expect(checkTool(policy, 'Write', { file_path: 'D:\\coding\\reins-scratch\\src\\..\\migrations\\0002.sql' }, cwd)).toMatch(/guarded/);
  });
  it('C: ./ prefix', () => {
    expect(checkTool(policy, 'Edit', { file_path: './migrations/0001.sql' }, cwd)).toMatch(/guarded/);
  });
  it('D: relative path with backslashes', () => {
    expect(checkTool(policy, 'Edit', { file_path: 'migrations\\0001.sql' }, cwd)).toMatch(/guarded/);
  });
});
