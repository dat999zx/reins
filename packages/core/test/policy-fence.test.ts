// M5 T1: a parallel run's session keeps its writes inside its folder (Policy.inside).
import { describe, it, expect } from 'vitest';
import { checkTool } from '../src/policy.js';
import type { Policy } from '../src/compile.js';

const IN: Policy = { mode: 'write', guards: [], allowShell: true, inside: true };
const PLAIN: Policy = { mode: 'write', guards: [], allowShell: true };
const CWD = 'D:\\wt\\r1\\a';
const write = (p: string, cwd = CWD, pol = IN) => checkTool(pol, 'Write', { file_path: p }, cwd);
const sh = (command: string, cwd = CWD, tool = 'Bash') => checkTool(IN, tool, { command }, cwd);

describe('Policy.inside: edit tools', () => {
  it('refuses an outside path with the words', () => {
    expect(write('D:\\coding\\reins\\x.ts')).toBe(`Blocked by Reins: D:\\coding\\reins\\x.ts is outside this task's folder, which a parallel run guards. Write only inside ${CWD}.`);
    expect(write('..\\..\\reins\\x.ts')).toContain('guard');
    expect(write('..\\..\\reins\\x.ts')).toContain('is outside this task');
  });
  it('lets inside paths pass', () => {
    expect(write('d:/WT/r1/a/src/x.ts')).toBeNull();
    expect(write('src/x.ts')).toBeNull();
    expect(write(CWD)).toBeNull();
  });
  it('refuses ~, Git Bash and UNC spellings', () => {
    expect(write('~/x')).toContain('guard');
    expect(write('/d/coding/x')).toContain('guard');
    expect(write('\\\\srv\\share\\x')).toContain('guard');
  });
  it('posix cwd', () => {
    expect(write('/home/me/main/x', '/home/me/wt/a')).toContain('guard');
    expect(write('/home/me/wt/a/x', '/home/me/wt/a')).toBeNull();
  });
  it('without inside the outside write passes (pins F2)', () => {
    expect(write('D:\\coding\\reins\\x.ts', CWD, PLAIN)).toBeNull();
  });
});

describe('Policy.inside: shell', () => {
  it('lets commands that name the cwd or nothing outside pass', () => {
    expect(sh('cd D:\\wt\\r1\\a && npm test')).toBeNull();
    expect(sh('git -C D:\\wt\\r1\\a status')).toBeNull();
    expect(sh('npx vitest --root D:\\wt\\r1\\a')).toBeNull();
    expect(sh('cmd /c dir')).toBeNull();
    expect(sh('curl http://localhost:3000/x')).toBeNull();
    expect(sh('npm test', CWD, 'PowerShell')).toBeNull();
  });
  it('refuses a command that names an outside path', () => {
    expect(sh('git -C D:\\coding\\reins commit -m x')).toBe("Blocked by Reins: this command names D:\\coding\\reins, outside this task's folder, which a parallel run guards.");
    expect(sh('git -C /d/coding/reins commit')).toContain('guard');
    expect(sh('type \\\\srv\\share\\x')).toContain('guard');
    expect(sh('git --git-dir=D:\\x status')).toContain('D:\\x');
    expect(sh('cd .. && ls')).toContain('guard');
  });
  it('posix cwd', () => {
    expect(sh('echo x > /dev/null', '/home/me/wt/a')).toBeNull();
    expect(sh('cd /home/me/wt/a && ls', '/home/me/wt/a')).toBeNull();
  });
  it('without inside a shell command passes', () => {
    expect(checkTool(PLAIN, 'Bash', { command: 'git -C D:\\coding\\reins status' }, CWD)).toBeNull();
  });
});

describe('Policy.inside: reads', () => {
  it('Read of an outside path passes', () => {
    expect(checkTool(IN, 'Read', { file_path: 'D:\\coding\\reins\\x.ts' }, CWD)).toBeNull();
  });
});
