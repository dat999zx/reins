// node scripts/test-affected.selfcheck.mjs: the selection logic of test-affected.mjs on a throwaway tree. Exits non-zero on a wrong answer.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, makeCtx, parseResults, testFiles } from './test-affected.mjs';

const root = mkdtempSync(join(tmpdir(), 'ta-'));
const put = (p, s) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), s); };
put('package.json', '{}');
put('packages/core/src/index.ts', 'export * from "./a.js";');
put('packages/core/src/a.ts', 'import { b } from "./b.js"; export const a = b;');
put('packages/core/src/b.ts', 'export const b = 1;');
put('packages/core/src/c.ts', 'export const c = 1;');
put('packages/core/test/x.test.ts', 'import { a } from "../src/a.js"; import { it } from "vitest";');
put('packages/core/test/y.test.ts', 'import { c } from "../src/c.js";');
put('packages/core/test/live.real.test.ts', '');
put('vitest.config.ts', "export default { test: { projects: [{ test: { include: ['packages/core/test/**/*.test.ts'], setupFiles: ['packages/core/test/setup.ts'] } }] } };");
put('packages/core/test/setup.ts', 'export const s = 1;');

const fps = () => { const ctx = makeCtx(root); return Object.fromEntries(testFiles(root).run.map((t) => [t.split(/[\\/]/).pop(), fingerprint(root, t, ctx)])); };
try {
  const base = fps();
  assert.deepEqual(Object.keys(base).sort(), ['x.test.ts', 'y.test.ts'], 'live tests are left out');
  put('packages/core/src/b.ts', 'export const b = 2;');                  // two imports deep from x.test.ts
  const afterB = fps();
  assert.notEqual(afterB['x.test.ts'], base['x.test.ts'], 'a change two imports away changes the test');
  assert.equal(afterB['y.test.ts'], base['y.test.ts'], 'an unrelated test keeps its fingerprint');
  put('packages/core/test/setup.ts', 'export const s = 2;');               // a setup file no test imports
  const afterSetup = fps();
  assert.notEqual(afterSetup['y.test.ts'], afterB['y.test.ts'], 'a setup file changes the tests of its project');
  put('package-lock.json', '{"x":1}');                                    // a global file
  const afterLock = fps();
  assert.notEqual(afterLock['y.test.ts'], afterSetup['y.test.ts'], 'a global file changes every test');
  put('packages/server/src/mods/m/index.ts', 'export default 1;');       // a mod: loaded by path by the core setup, never imported
  put('packages/core/test/scan.test.ts', 'import { readdirSync } from "node:fs"; readdirSync(".");');
  put('examples/e.reins.md', 'one');
  const m0 = fps();
  put('packages/server/src/mods/m/index.ts', 'export default 2;');
  put('examples/e.reins.md', 'two');
  const m1 = fps();
  assert.notEqual(m1['y.test.ts'], m0['y.test.ts'], 'a server mod changes core tests (the setup loads every mod)');
  assert.notEqual(m1['scan.test.ts'], m0['scan.test.ts'], 'a test that walks directories sees an example change');
  put('packages/server/test/fake-claude.mjs', 'a');
  const m2 = fps();
  put('packages/server/test/fake-claude.mjs', 'b');
  assert.notEqual(fps()['y.test.ts'], m2['y.test.ts'], 'a helper script referenced by URL counts');
  // vitest json: a retried-then-passed test is `passed` with failureMessages from the failed attempts
  const t = (name, status, failureMessages = []) => ({ name: join(root, name), status, assertionResults: [{ status, failureMessages }] });
  const pr = parseResults(root, { testResults: [t('a.test.ts', 'passed'), t('b.test.ts', 'passed', ['Error: x']), t('c.test.ts', 'failed', ['Error: y'])] });
  assert.deepEqual(pr.get('a.test.ts'), { passed: 1, failed: 0, flaky: false }, 'a clean pass is not flaky');
  assert.deepEqual(pr.get('b.test.ts'), { passed: 1, failed: 0, flaky: true }, 'a pass with failure messages needed a retry');
  assert.equal(pr.get('c.test.ts').failed, 1, 'a failure stays a failure');
  console.log('test-affected selfcheck: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
