// findClaude (plan 15b 2.3): the real binary, never the npm shim.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findClaude } from '../src/claude/find.js';

function tree(files: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-find-'));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), '');
  }
  return root;
}

describe('findClaude', () => {
  it('REINS_CLAUDE wins', () => {
    expect(findClaude({ REINS_CLAUDE: '/x/claude', PATH: '' }, 'linux', '/h')).toEqual({ path: '/x/claude', source: 'REINS_CLAUDE' });
  });

  it('Windows: resolves the npm claude.cmd shim to the package bin/claude.exe', () => {
    const npm = tree(['claude', 'claude.cmd', 'node_modules/@anthropic-ai/claude-code/bin/claude.exe']);
    const empty = tree([]);
    const found = findClaude({ Path: `${empty};${npm}` }, 'win32', empty);
    expect(found).toEqual({ path: path.join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), source: 'PATH' });
    expect(found!.path).not.toMatch(/\.(cmd|ps1)$/);
  });

  it('Windows: a claude.exe on PATH is used as is; a bare shim without the package is skipped', () => {
    const shimOnly = tree(['claude.cmd']);
    const winget = tree(['claude.exe']);
    expect(findClaude({ PATH: `${shimOnly};${winget}` }, 'win32', shimOnly)).toEqual({ path: path.join(winget, 'claude.exe'), source: 'PATH' });
  });

  it('falls back to the native installer path, else undefined', () => {
    const home = tree(['.local/bin/claude.exe']);
    expect(findClaude({ PATH: '' }, 'win32', home)).toEqual({ path: path.join(home, '.local', 'bin', 'claude.exe'), source: 'native installer' });
    expect(findClaude({ PATH: '' }, 'win32', tree([]))).toBeUndefined();
  });

  it('finds this machine\'s real claude.exe when it has one', () => {
    const found = findClaude();
    if (process.platform === 'win32' && found) expect(found.path).toMatch(/claude\.exe$/i);
  });
});
