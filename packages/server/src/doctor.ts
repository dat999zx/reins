import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findClaude } from './claude/find.js';
import { probeClaude } from './claude/engine.js';

// The claude version Phase 0 and the Phase 2 e2e ran against.
const TESTED_CLAUDE = '2.1.281';

/** `reins doctor` (plan 15b 2.7). Prints one line per check; returns false if Reins cannot run. */
export async function doctor(say: (s: string) => void, env: NodeJS.ProcessEnv, home: string): Promise<boolean> {
  let ok = true;
  const major = Number(process.versions.node.split('.')[0]);
  say(`node       v${process.versions.node}${major >= 22 ? '' : '  ✗ Reins needs Node 22 or newer'}`);
  if (major < 22) ok = false;
  try {
    await import('node:sqlite');
    say('node:sqlite ok');
  } catch (e: any) {
    ok = false;
    say(`node:sqlite ✗ ${e.message}`);
  }

  const found = findClaude(env);
  if (!found) {
    ok = false;
    say('claude     ✗ not found. Install Claude Code, or set REINS_CLAUDE to the claude binary.');
  } else {
    say(`claude     ${found.path} (${found.source})`);
    const p = await probeClaude(found.path);
    say(`  version  ${p.version ?? '?'}${p.version && p.version !== TESTED_CLAUDE ? `  (Reins was tested with ${TESTED_CLAUDE})` : ''}`);
    say(`  login    ${p.loggedIn === true ? 'logged in' : p.loggedIn === false ? 'not logged in' : 'unknown'}`);
    for (const pr of p.problems) say(`  ✗ ${pr}`);
    if (!p.installed || p.loggedIn === false) ok = false;
  }

  // Information only in Phase 2: the Codex adapter is Phase 5. Fixed args, so the shell is safe here.
  const codex = run('codex', ['--version']);
  say(`codex      ${codex ?? 'not found'}${codex ? `; ${run('codex', ['login', 'status']) ?? 'login status unknown'}` : ''}  (information only)`);
  const knowl = run('knowl', ['--version']);
  say(`knowl      ${knowl ?? 'not found: recall and store steps do nothing'}`);

  // Global Claude hooks and plugins run inside Reins's -p sessions too (Phase 0 finding 6).
  const settingsFile = path.join(home, '.claude', 'settings.json');
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const hooks = Object.entries(s.hooks ?? {}).filter(([, v]) => Array.isArray(v) && v.length);
    say(`global hooks (${settingsFile}): ${hooks.length ? hooks.map(([k, v]) => `${k} ×${(v as unknown[]).length}`).join(', ') : 'none'}`);
    const plugins = Object.entries(s.enabledPlugins ?? {}).filter(([, v]) => v).map(([k]) => k);
    if (plugins.length) say(`enabled plugins (may add hooks and context): ${plugins.join(', ')}`);
  } catch {
    say(`global hooks: none (${settingsFile} not readable)`);
  }
  return ok;
}

function run(cmd: string, args: string[]): string | undefined {
  // Through the shell so Windows finds codex.cmd / knowl.cmd; the words are fixed, never user input.
  const r = spawnSync([cmd, ...args].join(' '), { encoding: 'utf8', shell: true, windowsHide: true, timeout: 15_000 });
  return r.status === 0 ? `${r.stdout}${r.stderr}`.trim().split('\n')[0] : undefined;
}
