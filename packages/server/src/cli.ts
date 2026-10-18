#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { printWorkflow } from '@reins/core';
import { doctor, doctorMods } from './doctor.js';
import { defaultProviderOf, makeEngineFrom, probeFrom, providerViews, startMods } from './engines.js';
import { openUrl } from './opener.js';
import { pickFolder } from './picker.js';
import { runServe } from './serve.js';
import { formatDiagnostic, loadWorkflow, startRunCli } from './run-cli.js';
import { readSetting } from './settings.js';
import { defaultStorePath, openStore } from './store.js';

const USAGE = `usage:
  reins                  (opens the app: starts the server and your browser)
  reins run <file> [--provider <id>] [--model <m>] [--effort <e>] [--yes]
  reins run --resume <runId>
  reins check <file>
  reins print <file> [--write]
  reins doctor [--no-probe]   (--no-probe: load the mods and list them; no model call)
  reins --version
  reins serve [--port <n>]   (the local server the UI talks to; prints its address)`;

interface Io {
  stdout: Writable;
  stderr: Writable;
  stdin: Readable;
  env: NodeJS.ProcessEnv;
  stop?: Promise<void>;
  open?: (url: string) => void;
  /** Only the process entry point sets it, so no test reaches the network. */
  fetch?: typeof fetch;
}

/** Split argv into positionals and --flags; a flag takes the next word unless it is boolean. */
function parseArgs(argv: string[], booleans: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) pos.push(a);
    else if (booleans.includes(a.slice(2))) flags[a.slice(2)] = true;
    else flags[a.slice(2)] = argv[++i] ?? '';
  }
  return { pos, flags };
}

export async function main(argv: string[], io: Io): Promise<number> {
  const out = (s: string) => io.stdout.write(s + '\n');
  const err = (s: string) => io.stderr.write(s + '\n');
  const [cmd, ...rest] = argv;
  const { pos, flags } = parseArgs(rest, ['yes', 'write', 'no-probe']);
  // The Reins folder: mods, the code cache, the store and the lock live here.
  const home = io.env.REINS_HOME ?? os.homedir();
  const dir = path.join(home, '.reins');

  if (cmd === '--version' || cmd === '-v') {
    // src/ and dist/ both sit one level under the package root
    out(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    return 0;
  }

  if (cmd === 'check' && pos[0]) {
    const file = path.resolve(pos[0]);
    const { diagnostics } = loadWorkflow(file);
    for (const d of diagnostics) out(formatDiagnostic(file, d));
    if (!diagnostics.length) out(`${file}: ok`);
    return diagnostics.some((d) => d.severity === 'error') ? 1 : 0;
  }

  if (cmd === 'print' && pos[0]) {
    const file = path.resolve(pos[0]);
    const { workflow, diagnostics } = loadWorkflow(file);
    if (!workflow) {
      for (const d of diagnostics) err(formatDiagnostic(file, d));
      return 1;
    }
    const text = printWorkflow(workflow);
    if (flags.write) fs.writeFileSync(file, text);
    else io.stdout.write(text);
    return 0;
  }

  if (cmd === 'doctor' && flags['no-probe']) {
    const mods = await startMods({ dir, env: io.env });
    try {
      return doctorMods(out, mods) ? 0 : 1;
    } finally {
      mods.dispose();
    }
  }

  if (cmd === 'doctor') {
    const mods = await startMods({ dir, env: io.env });
    try {
      return (await doctor(out, mods, { env: io.env, home: dir })) ? 0 : 1;
    } finally {
      mods.dispose();
    }
  }

  if (cmd === 'serve' || cmd === undefined) {
    const raw = flags.port === undefined ? undefined : String(flags.port);
    if (raw !== undefined && !(/^\d+$/.test(raw) && Number(raw) <= 65535)) {
      err(`--port must be a whole number from 0 to 65535, not "${raw}".`);
      return 1;
    }
    // the published package carries the UI in app/; the repo builds it into packages/app/dist
    const appDir = ['../app/', '../../app/dist/'].map((u) => fileURLToPath(new URL(u, import.meta.url)))
      .find((d) => fs.existsSync(path.join(d, 'index.html')));
    if (!appDir) err('The UI is not built (run npm run build); serving the API only.');
    const bare = cmd === undefined;
    const open = io.open ?? ((url: string) => {
      try {
        openUrl(url, { platform: process.platform, dir: path.join(home, '.reins'), spawn, err });
      } catch {
        err(`Open this address in your browser: ${url}`);
      }
    });
    const mods = await startMods({ dir, env: io.env });
    const host = { env: io.env, home: dir };
    try {
      return await runServe({
        home, mods,
        ...(raw !== undefined ? { port: Number(raw) } : {}),
        ...(appDir ? { appDir } : {}),
        pickFolder: (signal) => pickFolder(signal),
        ...(io.fetch ? { fetch: io.fetch } : {}),
        ...(bare ? { open } : {}),
        makeEngine: makeEngineFrom(mods, host),
        probe: (provider) => probeFrom(mods, provider, host),
        out, err,
        stop: io.stop ?? new Promise<void>((resolve) => {
          process.once('SIGINT', () => resolve());
          process.once('SIGTERM', () => resolve());
        }),
      });
    } finally {
      mods.dispose();
    }
  }

  if (cmd === 'run' && (pos[0] || typeof flags.resume === 'string')) {
    const mods = await startMods({ dir, env: io.env });
    const installed = providerViews(mods);
    const named = typeof flags.provider === 'string' ? flags.provider : undefined;
    if (named !== undefined && !installed.some((p) => p.id === named)) {
      err(`No provider \`${named}\` is installed.`);
      mods.dispose();
      return 1;
    }
    const store = openStore(defaultStorePath());
    const provider = named ?? defaultProviderOf(installed, readSetting(store, 'defaultProvider'))?.id;
    if (!provider) {
      err('No provider is installed.');
      store.close();
      mods.dispose();
      return 1;
    }
    const engineOf = makeEngineFrom(mods, { env: io.env, home: dir });
    const h = startRunCli({
      ...(pos[0] ? { file: pos[0] } : {}),
      ...(typeof flags.resume === 'string' ? { resumeId: flags.resume } : {}),
      cwd: process.cwd(),
      input: io.stdin,
      output: io.stdout,
      store,
      yes: flags.yes === true,
      makeEngine: (cb) => {
        const model = typeof flags.model === 'string' ? flags.model : undefined;
        return engineOf({
          provider,
          ...(model ? { model } : {}),
          ...(typeof flags.effort === 'string' ? { effort: flags.effort } : {}),
          ...cb,
        });
      },
    });
    const onSigint = () => h.sigint();
    process.on('SIGINT', onSigint);
    try {
      return (await h.done).exitCode;
    } finally {
      process.off('SIGINT', onSigint);
      store.close();
      mods.dispose();
    }
  }

  err(USAGE);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env, fetch: globalThis.fetch }).then(
    (code) => { process.exitCode = code; },
    (e) => { process.stderr.write(`reins: ${e?.message ?? e}\n`); process.exitCode = 1; }
  );
}
