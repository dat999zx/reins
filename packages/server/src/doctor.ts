import { spawnSync } from 'node:child_process';
import { probeFrom, providerViews, shellEnvFrom } from './engines.js';
import type { EngineHost, Mods } from './mods/types.js';
import type { Redactor } from './secrets.js';

/** `reins doctor` (plan 15b 2.7). Prints one line per check; returns false if Reins cannot run. */
export async function doctor(say: (s: string) => void, mods: Mods, host: Pick<EngineHost, 'env' | 'home' | 'holdsSecret'>, redactor?: Redactor): Promise<boolean> {
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

  // Each installed provider is probed through its protocol; its own words say what is wrong (a missing program, no login, no key).
  const providers = providerViews(mods);
  if (!providers.length) {
    ok = false;
    say('provider   ✗ none installed');
  }
  for (const p of providers) {
    say(`provider   ${p.id}`);
    try {
      const r = await probeFrom(mods, p.id, host, redactor); // the process's one Redactor, never a second
      say(`  version  ${r.version ?? '?'}`);
      say(`  login    ${r.loggedIn === true ? 'logged in' : r.loggedIn === false ? 'not logged in' : 'unknown'}`);
      for (const pr of r.problems) say(`  ✗ ${pr}`);
      if (!r.installed || r.loggedIn === false) ok = false;
    } catch (e) {
      ok = false;
      say(`  ✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const knowl = run('knowl', ['--version'], shellEnvFrom(mods, host.env, host.holdsSecret ?? (() => false))());
  say(`knowl      ${knowl ?? 'not found: recall and store steps do nothing'}`);
  return ok;
}

/** `reins doctor --no-probe`: the mods that loaded and the problems of the rest. No model call, no provider process. False when a bundled mod has a problem or none loaded. */
export function doctorMods(say: (s: string) => void, loaded: Mods): boolean {
  let ok = loaded.mods.some((m) => m.source === 'bundled');
  if (!ok) say('mods       ✗ no bundled mods were found');
  for (const m of loaded.mods) {
    say(`mod        ${m.id}  ${m.kind || '?'}  ${m.source}${m.enabled ? '' : '  (off)'}${m.problems.length ? '' : '  ok'}`);
    for (const p of m.problems) say(`  ✗ ${p}`);
    if (m.source === 'bundled' && m.problems.length) ok = false;
  }
  for (const p of loaded.problems) say(`mods       ✗ ${p}`);
  return ok;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): string | undefined {
  // Through the shell so Windows finds knowl.cmd; the words are fixed, never user input.
  const r = spawnSync([cmd, ...args].join(' '), { encoding: 'utf8', shell: true, windowsHide: true, timeout: 15_000, env });
  return r.status === 0 ? `${r.stdout}${r.stderr}`.trim().split('\n')[0] : undefined;
}
