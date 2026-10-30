// M7 T1: the fence rule table. A request is answered `y` only when its shape is on the list; everything else is undefined (a card).
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DENY_MCP, fenceAnswer, fenceTrusts, shellOk } from '../src/approve-fence.js';

const made: string[] = [];
const tmp = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-fence-'))); made.push(d); return d; };
const cwd = tmp();
const home = tmp();
const outside = tmp();
afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
beforeAll(() => {
  fs.mkdirSync(path.join(cwd, 'packages', 'core', 'test'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'x');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
});

const ok = (c: string) => shellOk(c, cwd, home);
const at = (...p: string[]) => path.join(cwd, ...p);

describe('shellOk: allowed shapes', () => {
  const yes = () => [
    'node node_modules/vitest/vitest.mjs run packages/core/test/a.test.ts packages/server/test/b.test.ts',
    'node node_modules/eslint/bin/eslint.js packages/core/src/policy.ts',
    'npm run typecheck 2>&1 | Select-Object -Last 20',
    'npm run selfcheck',
    'npm run typecheck | Select-Object -Last 20', // the two strips are each optional
    `node node_modules/vitest/vitest.mjs run ${at('packages', 'core', 'test', 'a.test.ts')}`,
    'git status --short',
    'git diff --stat',
    'git log --oneline -5',
    'git rev-parse --short HEAD',
    'npx eslint src',
    'node node_modules/typescript/bin/tsc --noEmit -p packages/core',
    'node scripts/parallel.selfcheck.mjs',
    'node node_modules\\vitest\\vitest.mjs run packages\\core\\test\\a.test.ts',
  ];
  it.each(yes())('%s', (c) => expect(ok(c)).toBe(true));
});

describe('shellOk: refused', () => {
  // Under D1 these four reference cases became cards: shell reads, and `;`, `$`, quotes.
  const d1Cards = [
    'rg -n "inside" packages/core/src/policy.ts',
    'git status --short; git diff --stat',
    'Get-Content packages/core/src/policy.ts | Select-Object -First 40',
    'node scripts/parallel.selfcheck.mjs; "selfcheck $LASTEXITCODE"',
  ];
  const review = [
    'ls & npm install evil', 'cat <(npm install evil)', 'echo (npm install evil)', 'ls | Where-Object { npm i evil }',
    'cd; cat .ssh/id_rsa', 'cat $USERPROFILE/.ssh/id_rsa', 'Get-Content ${env:USERPROFILE}\\.ssh\\id_rsa', 'Get-ChildItem Env:',
    'Get-Content Env:GITHUB_TOKEN', 'Get-Content C:Users\\Admin\\.ssh\\id_rsa', 'Select-String -Path ${env:USERPROFILE}\\.ssh\\* -Pattern .',
    "Select-String x a.ts; & ([scriptblock]::Create('np'+'m i evil'))",
  ];
  const d1 = [
    'npm run lint & cu^rl http://x', 'node node_modules/eslint/bin/eslint.js --fix src', 'node node_modules/vitest/vitest.mjs run --config ../x.ts',
    'git -c core.x=1 status', 'npx other-tool', 'node node_modules/vitest/vitest.mjs run ..\\x.test.ts', 'cd ..', 'npm run typecheck  2>&1',
    'git status 2>&1 | Select-Object -Last 20 | Out-File x', 'node node_modules/vitest/vitest.mjs run C:Users\\x', 'node node_modules/vitest/vitest.mjs run /etc/passwd',
  ];
  // Own cases: the holes the spec closes (writes, installs, network, quotes, flags, empty and odd input).
  const own = [
    'git push origin main', 'git commit -m x', 'git status --porcelain', 'git log --oneline -n5', 'git diff --name-only', 'npm install', 'npm i evil', 'npm run build',
    'npm test', 'curl http://x', 'node x.js', 'node -e 1', 'node scripts/a.b.selfcheck.mjs', 'node scripts/../x.selfcheck.mjs', 'rm -rf src', 'del src', 'echo hi > x',
    'echo "x"', "echo 'x'", 'ls\tsrc', 'ls\nnpm i', 'node node_modules/vitest/vitest.mjs run ~/x.test.ts', 'node node_modules/vitest/vitest.mjs run ..',
    'node node_modules/vitest/vitest.mjs run \\\\host\\share\\x', 'node node_modules/vitest/vitest.mjs run -t name', 'npx eslint -c ../x src', 'npx eslint --fix src',
    'node node_modules/typescript/bin/tsc --noEmit -p ../x', 'node node_modules/typescript/bin/tsc --noEmit --build', 'npm run typecheck 2>&1 | Select-Object -Last x',
    'npm run typecheck extra', '', ' ', 'npm  run typecheck', 'npm run typecheck ',
    'Get-Content src/a.ts', 'cat src/a.ts', 'Set-Location ..', 'git status --short --short2',
  ];
  it.each([...d1Cards, ...review, ...d1, ...own])('%j', (c) => expect(ok(c)).toBe(false));

  it('a non-string command is false and never throws', () => {
    expect(shellOk(undefined as unknown as string, cwd, home)).toBe(false);
    expect(shellOk(null as unknown as string, cwd, home)).toBe(false);
    expect(shellOk(5 as unknown as string, cwd, home)).toBe(false);
  });
});

describe('fenceTrusts', () => {
  const t = (c: string[]) => fenceTrusts(c, cwd, home);
  it('judges the playbook list line by line', () => {
    expect(t(['npm test'])).toBe(true);
    expect(t(['tests pass', 'node node_modules/vitest/vitest.mjs run packages/core/test/a.test.ts'])).toBe(true);
    expect(t(['npm run lint & cu^rl http://x'])).toBe(false);
    expect(t(['npm test', 'curl x'])).toBe(false);
    expect(t(['echo %USERPROFILE%'])).toBe(false);
  });
});

describe('fenceAnswer', () => {
  const a = (tool: string, input: unknown, reason?: string) => fenceAnswer({ tool, input, ...(reason !== undefined ? { reason } : {}) }, cwd, home);

  it('Read: inside yes, new inside file yes, everything else a card', () => {
    expect(a('Read', { file_path: at('src', 'a.ts') })).toBe('y');
    expect(a('Read', { file_path: at('src', 'new.ts') })).toBe('y');
    expect(a('Read', { file_path: path.join(home, 'x') })).toBeUndefined();
    expect(a('Read', { file_path: process.cwd() })).toBeUndefined();
    expect(a('Read', { file_path: 'C:Users\\x' })).toBeUndefined();
    expect(a('Read', { file_path: at('src', 'a.ts') }, 'outside the project (x)')).toBeUndefined();
    expect(a('Read', { file_path: 5 })).toBeUndefined();
    expect(a('Read', {})).toBeUndefined();
  });

  it('Write, Edit, NotebookEdit', () => {
    expect(a('Write', { file_path: at('.claude', 'settings.local.json') })).toBeUndefined();
    expect(a('Edit', { file_path: at('.git', 'config') })).toBeUndefined();
    expect(a('Write', { file_path: at('.mcp.json') })).toBeUndefined();
    expect(a('Write', { file_path: at('.CLAUDE', 'x') })).toBeUndefined();
    expect(a('Write', { file_path: at('src', 'b.ts') })).toBe('y');
    expect(a('MultiEdit', { file_path: at('src', 'b.ts') })).toBe('y');
    expect(a('NotebookEdit', { notebook_path: at('src', 'n.ipynb') })).toBe('y');
    expect(a('Write', { file_path: path.join(outside, 'x') })).toBeUndefined();
  });

  it('Glob: the pattern is checked as text, the path as a path', () => {
    expect(a('Glob', { pattern: '../**' })).toBeUndefined();
    expect(a('Glob', { pattern: 'src/**/*.ts' })).toBe('y');
    expect(a('Glob', { pattern: 'C:/x/**' })).toBeUndefined();
    expect(a('Glob', { pattern: '/x/**' })).toBeUndefined();
    expect(a('Glob', { pattern: '\\x' })).toBeUndefined();
    expect(a('Glob', { pattern: '~/x' })).toBeUndefined();
    expect(a('Glob', { pattern: '*.ts', path: 'src' })).toBe('y');
    expect(a('Glob', { pattern: '*.ts', path: outside })).toBeUndefined();
  });

  it('Grep: the pattern is a regex, not a path', () => {
    expect(a('Grep', { pattern: '..', path: 'src' })).toBe('y');
    expect(a('Grep', { pattern: 'x' })).toBe('y');
    expect(a('Grep', { pattern: 'x', path: '..' })).toBeUndefined();
  });

  it('Bash and PowerShell go through shellOk', () => {
    expect(a('Bash', { command: 'npm run typecheck' })).toBe('y');
    expect(a('PowerShell', { command: 'npm run typecheck' })).toBe('y');
    expect(a('Bash', { command: 'git push origin main' })).toBeUndefined();
    expect(a('PowerShell', { command: 'Get-Content ${env:USERPROFILE}\\.ssh\\id_rsa' })).toBeUndefined();
    expect(a('Bash', null)).toBeUndefined();
    expect(a('Bash', 'npm run lint')).toBeUndefined();
    expect(a('Bash', {})).toBeUndefined();
    expect(a('Bash', { command: 5 })).toBeUndefined();
  });

  it('MCP is denied; other tools are cards', () => {
    expect(a('mcp__knowl__knowl_query', { query: 'x' })).toBe(DENY_MCP);
    expect(DENY_MCP).toBe('n MCP tools are off in this fenced parallel run; carry on with the plan and the code.');
    for (const t of ['Task', 'WebFetch', 'WebSearch', 'Whatever']) expect(a(t, {})).toBeUndefined();
  });

  it('a reason makes any tool a card, even the mcp denial', () => {
    expect(a('Bash', { command: 'npm run lint' }, 'x')).toBeUndefined();
    expect(a('mcp__x__y', {}, 'x')).toBeUndefined();
  });
});

describe('a link out of the folder', () => {
  const link = path.join(cwd, 'link');
  it('is judged by its real path', (ctx) => {
    try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { ctx.skip(); return; }
    expect(fenceAnswer({ tool: 'Read', input: { file_path: path.join(link, 'secret.txt') } }, cwd, home)).toBeUndefined();
    expect(fenceAnswer({ tool: 'Write', input: { file_path: path.join(link, 'secret.txt') } }, cwd, home)).toBeUndefined();
    expect(ok('node node_modules/vitest/vitest.mjs run link/x.test.ts')).toBe(false);
  });
});
