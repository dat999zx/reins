#!/usr/bin/env node
// Runs only the test files whose inputs changed since they last passed, committed or not.
//   node scripts/test-affected.mjs [--all] [--dry] [--batch N] [--jobs N] [-- <extra vitest args>]
// --jobs N runs N batches (N vitest processes) at the same time; the default is 1. ponytail: batches run in directory order, so the heavy files can land in one batch; longest-first needs recorded durations.
// A test file's fingerprint is its own bytes plus every file it imports (relative paths, '@reins/core', '@reins/server/*')
// plus the config and lock files. A file passes when none of its tests failed and at least one ran; its fingerprint is then
// stored in node_modules/.cache, so the next run skips it until something it depends on changes. A failed or crashed file
// is simply not stored, so the next run re-runs just those. Files run in small batches: a crashed batch (the vitest
// ERR_IPC_CHANNEL_CLOSED crash) is retried file by file and loses nothing already stored.
// ponytail: static imports only. Files a test reads at run time are covered by the coarse groups in makeCtx: `mods` (every server
// mod, fixture and helper script: the core and app setups load them by path) for every test; `scan` (all package source and the
// examples) for tests that walk directories; the built app for browser tests (a stale build is refused). Any other runtime-read
// file is not seen.
// Use --all when in doubt. Live tests (*.real.test.ts) need real keys and are never run here.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sha = (s) => createHash('sha1').update(s).digest('hex');
const SKIP = new Set(['node_modules', 'dist', '.git', 'docs', 'spike', '.knowl']);
const rel = (root, p) => relative(root, p).split(sep).join('/');

export function walk(dir, ok = () => true, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, ok, out);
    else if (ok(p)) out.push(p);
  }
  return out;
}

export function testFiles(root) {
  const all = walk(root, (p) => /\.test\.tsx?$/.test(p) && /^(packages\/[^/]+\/)?test\//.test(rel(root, p)));
  return { run: all.filter((p) => !/\.real\.test\./.test(p)), live: all.filter((p) => /\.real\.test\./.test(p)) };
}

const IMPORT = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
// `import type ... from` and `export type ... from` are erased before a test runs, so they are no dependency
const TYPE_ONLY = /\b(?:import|export)\s+type\s+[^;'"]*?from\s*['"][^'"]+['"]/g;

export function resolveSpec(root, from, spec) {
  let base;
  if (spec === '@reins/core') base = join(root, 'packages/core/src/index');
  else if (spec.startsWith('@reins/server/')) base = join(root, 'packages/server/src', spec.slice('@reins/server/'.length));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null; // a package from node_modules: the lock file covers it
  const stem = base.replace(/\.(m?js|jsx)$/, '');
  for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

export function makeCtx(root) {
  const bytes = new Map();
  const read = (f) => { if (!bytes.has(f)) bytes.set(f, readFileSync(f)); return bytes.get(f); };
  const hashes = new Map();
  const hash = (f) => { if (!hashes.has(f)) hashes.set(f, sha(read(f))); return hashes.get(f); };
  const deps = new Map(); // file -> the files it imports, resolved once
  const imports = (f) => {
    if (!deps.has(f)) deps.set(f, !/\.(tsx?|m?js)$/.test(f) ? [] : [...read(f).toString('utf8').replace(TYPE_ONLY, '').matchAll(IMPORT)].map((m) => resolveSpec(root, f, m[1])).filter(Boolean));
    return deps.get(f);
  };
  const group = (files) => sha(files.sort().map((f) => `${rel(root, f)}:${hash(f)}`).join('\n'));
  const isCfg = (name) => /^(package(-lock)?\.json|tsconfig[^/]*\.json|vite\.config\.[^/]+|vitest\.config\.[^/]+)$/.test(name);
  const pkgs = existsSync(join(root, 'packages')) ? readdirSync(join(root, 'packages')).map((d) => join(root, 'packages', d)) : [];
  const cfgFiles = [root, ...pkgs].flatMap((d) => readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile() && isCfg(e.name)).map((e) => join(d, e.name)));
  // `include: ['packages/x/test/**...'], setupFiles: ['packages/x/test/setup.ts']` in vitest.config.ts: a setup file runs before every test of its project but no test imports it
  const cfg = existsSync(join(root, 'vitest.config.ts')) ? read(join(root, 'vitest.config.ts')).toString('utf8') : '';
  const setups = [...cfg.matchAll(/include:\s*\['([^'*]+)[^\]]*\],\s*setupFiles:\s*\['([^']+)'\]/g)].map((m) => ({ dir: m[1], file: m[2] }));
  return {
    read, hash, imports, setups,
    global: group(cfgFiles),
    mods: group([...walk(join(root, 'packages/server/src/mods')), ...walk(join(root, 'packages/server/test/fixtures')),
      ...walk(join(root, 'packages/server/test'), (f) => /\.mjs$/.test(f))]), // fake-claude.mjs is referenced by URL, never imported
    scan: group([...pkgs.flatMap((d) => walk(join(d, 'src'))), ...walk(join(root, 'examples'))]),
    appAndServerSrc: group([...walk(join(root, 'packages/app/src')), ...walk(join(root, 'packages/server/src'))]),
  };
}

export function fingerprint(root, test, ctx) {
  const seen = new Set();
  const t = rel(root, test);
  const todo = [test, ...ctx.setups.filter((s) => t.startsWith(s.dir)).map((s) => join(root, s.file))];
  const parts = [];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    parts.push(`${rel(root, f)}:${ctx.hash(f)}`);
    todo.push(...ctx.imports(f));
  }
  parts.sort();
  parts.push(`global:${ctx.global}`);
  parts.push(`mods:${ctx.mods}`); // mods are loaded by path at run time: the core and app setups do it too
  if (/readdirSync|examples/.test(ctx.read(test).toString('utf8'))) parts.push(`scan:${ctx.scan}`); // tests that walk source or example files
  if (/\.browser\./.test(t)) parts.push(`src:${ctx.appAndServerSrc}`); // browser tests drive the built app
  return sha(parts.join('\n'));
}

let batchNo = 0;
async function runBatch(root, files, extra, tmp, quiet) {
  const out = join(tmp, `run-${process.pid}-${batchNo++}.json`);
  let text = '';
  await new Promise((done) => {
    const c = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...files.map((f) => rel(root, f)),
      '--retry=2', '--reporter=default', '--reporter=json', `--outputFile.json=${out}`, ...extra], { cwd: root, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    if (quiet) for (const s of [c.stdout, c.stderr]) s.on('data', (d) => (text += d));
    c.on('exit', done);
  });
  if (!existsSync(out)) return null; // vitest died before it wrote a summary
  const j = JSON.parse(readFileSync(out, 'utf8'));
  rmSync(out);
  const res = parseResults(root, j);
  res.text = text; // what a quiet batch printed, for the caller to show when it failed
  return res;
}

// vitest's json reporter has no retry count: a test that failed and then passed on a retry is `passed` with the failed attempts' messages kept in `failureMessages`.
export function parseResults(root, j) {
  const res = new Map();
  for (const r of j.testResults ?? []) {
    const k = rel(root, r.name);
    const o = res.get(k) ?? { passed: 0, failed: 0, flaky: false };
    for (const a of r.assertionResults ?? []) {
      if (a.status === 'passed') { o.passed++; if (a.failureMessages?.length) o.flaky = true; } else if (a.status === 'failed') o.failed++;
    }
    if (r.status === 'failed' && !o.failed) o.failed++;
    res.set(k, o);
  }
  return res;
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const argv = process.argv.slice(2);
  const dd = argv.indexOf('--');
  const flags = dd < 0 ? argv : argv.slice(0, dd);
  const extra = dd < 0 ? [] : argv.slice(dd + 1);
  const all = flags.includes('--all'), dry = flags.includes('--dry');
  const bi = flags.indexOf('--batch');
  const size = bi >= 0 ? Math.max(1, Number(flags[bi + 1]) || 6) : 6;
  const ji = flags.indexOf('--jobs');
  const jobs = ji >= 0 ? Math.max(1, Number(flags[ji + 1]) || 1) : 1;

  const tmp = join(root, 'node_modules/.cache');
  const stateFile = join(tmp, 'reins-test-green.json');
  mkdirSync(tmp, { recursive: true });
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};

  const { run: tests, live } = testFiles(root);
  const ctx = makeCtx(root);
  const fp = new Map(tests.map((t) => [rel(root, t), fingerprint(root, t, ctx)]));
  const todo = tests.filter((t) => all || state[rel(root, t)] !== fp.get(rel(root, t)));
  console.log(`test-affected: ${tests.length} test files, ${tests.length - todo.length} up to date, ${todo.length} to run${live.length ? ` (${live.length} live tests are never run here)` : ''}`);
  if (dry || !todo.length) { if (dry) for (const t of todo) console.log(`  ${rel(root, t)}`); return 0; }

  // A browser test drives the BUILT app: against an old build it would pass and be stored for the new source.
  const newest = (d) => walk(d).reduce((m, f) => Math.max(m, statSync(f).mtimeMs), 0);
  const built = join(root, 'packages/app/dist/index.html');
  const stale = !existsSync(built) || statSync(built).mtimeMs < Math.max(newest(join(root, 'packages/app/src')), newest(join(root, 'packages/core/src')));
  const browser = todo.filter((t) => /\.browser\./.test(rel(root, t)));
  if (stale && browser.length) {
    console.log(`test-affected: packages/app/dist is missing or older than the source, so ${browser.length} browser test file(s) are not run: run \`npm run build\` first`);
    for (const t of browser) todo.splice(todo.indexOf(t), 1);
  }

  const save = () => writeFileSync(stateFile, JSON.stringify(state));
  const failed = [], crashed = [], flaky = [];
  let passed = 0;
  const record = (res, files) => {
    for (const f of files) {
      const k = rel(root, f), o = res.get(k);
      if (o && o.failed === 0 && o.passed > 0 && o.flaky) flaky.push(k); // green only after a retry: not stored, so it re-runs next time
      else if (o && o.failed === 0 && o.passed > 0) { state[k] = fp.get(k); passed++; }
      else if (o && o.failed > 0) failed.push(k);
      else failed.push(`${k} (no test ran)`);
    }
    save();
  };
  const started = Date.now();
  const batches = [];
  for (let i = 0; i < todo.length; i += size) batches.push(todo.slice(i, i + size));
  let next = 0, done = 0;
  const quiet = jobs > 1; // parallel output would interleave: a quiet batch prints one line, and its full output only when it did not pass
  const worker = async () => {
    while (next < batches.length) {
      const files = batches[next++];
      const res = await runBatch(root, files, extra, tmp, quiet);
      done++;
      if (res) {
        const before = failed.length;
        record(res, files);
        if (quiet) {
          console.log(`test-affected: batch ${done}/${batches.length} ${failed.length > before ? 'FAILED' : 'ok'} (${files.length} files)`);
          if (failed.length > before) console.log(res.text);
        }
        continue;
      }
      console.log(`test-affected: vitest died on a batch of ${files.length}; retrying file by file`);
      for (const f of files) {
        const one = await runBatch(root, [f], extra, tmp, quiet);
        if (one) record(one, [f]); else crashed.push(rel(root, f));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, batches.length) }, worker));
  console.log(`\ntest-affected: ${passed} passed and stored, ${failed.length} failed, ${crashed.length} crashed, ${flaky.length} flaky (passed only after a retry, not stored), ${((Date.now() - started) / 1000).toFixed(0)}s`);
  for (const f of flaky) console.log(`  FLAKY   ${f}`);
  for (const f of failed) console.log(`  FAILED  ${f}`);
  for (const f of crashed) console.log(`  CRASHED ${f}`);
  return failed.length || crashed.length || (stale && browser.length) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((code) => process.exit(code));
