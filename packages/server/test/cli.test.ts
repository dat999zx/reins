// reins check / print / doctor (plan 15b 2.7), in-process.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { main } from '../src/cli.js';
import { FAKE_CLAUDE, fakeSetup } from './helpers.js';

const EXAMPLES = path.resolve(__dirname, '../../../examples');

async function cli(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (d) => (out += d));
  stderr.on('data', (d) => (err += d));
  const code = await main(argv, { stdout, stderr, stdin: new PassThrough(), env: { ...process.env, ...env } });
  return { code, out, err };
}

describe('reins --version', () => {
  it('prints the package version', async () => {
    const r = await cli(['--version']);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).version);
  });
});

describe('reins check', () => {
  it('passes every example', async () => {
    for (const f of ['upload-retry', 'bug-fix', 'tdd-loop', 'safe-refactor']) {
      const r = await cli(['check', path.join(EXAMPLES, `${f}.reins.md`)]);
      expect(r.code, r.out + r.err).toBe(0);
    }
  });
  it('prints file:line:col and exits 1 on errors', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-cli-')), 'bad.reins.md');
    fs.writeFileSync(file, '---\nreins: 1\nname: b\nbudget: { turns: 9, minutes: 9 }\n---\n\n## gate\n\n## phase x\nstop: no\n> y\n');
    const r = await cli(['check', file]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/bad\.reins\.md:7:1: error: gate step "gate-1" requires until/);
    expect(r.out).toMatch(/bad\.reins\.md:10:\d+: error: "stop:" is only allowed in a whenever block/);
  });
});

describe('reins print', () => {
  it('prints the tidied file, and --write writes it back', async () => {
    const src = fs.readFileSync(path.join(EXAMPLES, 'upload-retry.reins.md'), 'utf8').replace(/\r\n/g, '\n');
    expect((await cli(['print', path.join(EXAMPLES, 'upload-retry.reins.md')])).out).toBe(src);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-cli-')), 'w.reins.md');
    fs.writeFileSync(file, '---\nreins: 1\nname: w\nbudget: {turns: 9, minutes: 9}\n---\n\n## phase   one\n>  hi\n');
    const r = await cli(['print', '--write', file]);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('---\nreins: 1\nname: w\nbudget: { turns: 9, minutes: 9 }\nalways: []\n---\n\n## phase one\n>  hi\n');
  });
});

describe('reins doctor', () => {
  it('reports node, sqlite, each installed provider with its version and login, and knowl', async () => {
    fakeSetup([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-home-'));
    const r = await cli(['doctor'], { REINS_CLAUDE: FAKE_CLAUDE, REINS_HOME: home });
    expect(r.out).toMatch(/node\s+v\d+/);
    expect(r.out).toMatch(/node:sqlite\s+ok/);
    expect(r.out).toMatch(/provider\s+claude-code/);
    expect(r.out).toMatch(/version\s+2\.1\.281/);
    expect(r.out).toMatch(/login\s+logged in/);
    expect(r.out).toMatch(/knowl/);
    expect(r.out).not.toMatch(/codex/);
  }, 60_000);
});

describe('reins', () => {
  it('prints usage for an unknown command', async () => {
    const r = await cli(['frobnicate']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/usage/i);
  });
  it('refuses a provider that is not installed', async () => {
    const r = await cli(['run', path.join(EXAMPLES, 'upload-retry.reins.md'), '--provider', 'codex']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('No provider `codex` is installed.');
  });
});
