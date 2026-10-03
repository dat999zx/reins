// The command runner for `run` steps and `cmd` passes atoms (plan 15b 2.4).
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../src/commands.js';

let dir: string;
const node = `"${process.execPath}"`;
beforeAll(() => {
  // A space in the folder name, as Windows user folders often have.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins cmd-'));
  fs.writeFileSync(path.join(dir, 'lines.mjs'), 'for (let i = 1; i <= 500; i++) console.log("line " + i); console.error("boom"); process.exitCode = 3;');
  fs.writeFileSync(path.join(dir, 'hang.mjs'), 'setInterval(() => {}, 1000);');
  fs.writeFileSync(path.join(dir, 'cwd.mjs'), 'console.log(process.cwd());');
});

describe('runCommand', () => {
  it('passes on exit 0 and runs in the given cwd', async () => {
    const r = await runCommand(`${node} cwd.mjs`, { cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(fs.realpathSync(r.stdout.trim())).toBe(fs.realpathSync(dir));
  });

  it('keeps the exit code and only the last 200 lines, stderr included', async () => {
    const r = await runCommand(`${node} lines.mjs`, { cwd: dir });
    expect(r.exitCode).toBe(3);
    const lines = r.stdout.trimEnd().split(/\r?\n/);
    expect(lines).toHaveLength(200);
    expect(lines, JSON.stringify([lines.slice(0, 3), lines.slice(-3), r.stdout.length])).toContain('boom');
    expect(lines).toContain('line 500');
    expect(lines).not.toContain('line 250');
  });

  it('streams output as it comes', async () => {
    let seen = '';
    await runCommand(`${node} lines.mjs`, { cwd: dir, onOutput: (s) => (seen += s) });
    expect(seen).toContain('line 1\n');
  });

  it('kills the command at the timeout and fails', async () => {
    const t = Date.now();
    const r = await runCommand(`${node} hang.mjs`, { cwd: dir, timeoutMs: 800 });
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toContain('timed out');
  });
});
