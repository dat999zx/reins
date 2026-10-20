#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { printWorkflow } from '@reins/core';
import { doctor, doctorMods } from './doctor.js';
import { checkEnvFrom, defaultProviderOf, keyEnvNames, makeEngineFrom, probeFrom, providerViews, redactEnvNames, startMods } from './engines.js';
import { parseModel } from './models.js';
import type { Mods } from './mods/types.js';
import { missingProviderWords, resolveSubagent, runChecks } from './run-checks.js';
import { childEnv, KEY_IN_WORKFLOW, Redactor } from './secrets.js';
import { openUrl } from './opener.js';
import { pickFolder } from './picker.js';
import { runServe } from './serve.js';
import { formatDiagnostic, loadWorkflow, startRunCli } from './run-cli.js';
import { readSetting } from './settings.js';
import { openStore, redactingStore } from './store.js';

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
  // The Reins folder: mods, the code cache, the store and the lock live here.
  const home = io.env.REINS_HOME ?? os.homedir();
  const dir = path.join(home, '.reins');

  if (argv[0] === '--version' || argv[0] === '-v') {
    // src/ and dist/ both sit one level under the package root
    io.stdout.write(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version + '\n');
    return 0;
  }

  // The mods are loaded first for every command: the redactor needs the key names of all of them (a rejected mod included), because
  // everything the CLI prints, an error message too, passes through it.
  const mods = await startMods({ dir, env: io.env });
  const redactor = new Redactor({ home: dir, env: io.env, keyEnvNames: () => redactEnvNames(mods) });
  try {
    return await dispatch(argv, io, { home, dir, mods, redactor });
  } catch (e) {
    // The entry point prints a rejection's message; it must not carry a key.
    throw new Error(redactor.redact(e instanceof Error ? e.message : String(e)));
  } finally {
    mods.dispose();
  }
}

async function dispatch(argv: string[], io: Io, c: { home: string; dir: string; mods: Mods; redactor: Redactor }): Promise<number> {
  const { home, dir, mods, redactor } = c;
  const out = (s: string) => io.stdout.write(redactor.redact(s) + '\n');
  const err = (s: string) => io.stderr.write(redactor.redact(s) + '\n');
  const [cmd, ...rest] = argv;
  const { pos, flags } = parseArgs(rest, ['yes', 'write', 'no-probe']);
  const children = () => childEnv(io.env, keyEnvNames(mods));

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
    if (flags.write) {
      if (redactor.has(text)) {
        err(KEY_IN_WORKFLOW);
        return 1;
      }
      fs.writeFileSync(file, text);
    }
    else io.stdout.write(redactor.redact(text));
    return 0;
  }

  if (cmd === 'doctor' && flags['no-probe']) return doctorMods(out, mods) ? 0 : 1;

  if (cmd === 'doctor') return (await doctor(out, mods, { env: io.env, home: dir })) ? 0 : 1;

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
        openUrl(url, { platform: process.platform, dir: path.join(home, '.reins'), spawn, err, env: children() });
      } catch {
        err(`Open this address in your browser: ${url}`);
      }
    });
    const host = { env: io.env, home: dir };
    return await runServe({
      home, mods,
      ...(raw !== undefined ? { port: Number(raw) } : {}),
      ...(appDir ? { appDir } : {}),
      pickFolder: (signal) => pickFolder(signal, { env: children() }),
      ...(io.fetch ? { fetch: io.fetch } : {}),
      env: io.env,
      ...(bare ? { open } : {}),
      makeEngine: makeEngineFrom(mods, host),
      probe: (provider) => probeFrom(mods, provider, host),
      out, err,
      stop: io.stop ?? new Promise<void>((resolve) => {
        process.once('SIGINT', () => resolve());
        process.once('SIGTERM', () => resolve());
      }),
    });
  }

  if (cmd === 'run' && (pos[0] || typeof flags.resume === 'string')) {
    const installed = providerViews(mods);
    const env = checkEnvFrom(mods, { env: io.env, home: dir });
    const named = typeof flags.provider === 'string' ? flags.provider : undefined;
    if (named !== undefined && !env.installed(named)) {
      err(`No provider \`${named}\` is installed.`);
      return 1;
    }
    const store = redactingStore(openStore(path.join(dir, 'reins.db')), redactor);
    // A run that belongs to a chat session is resumed from the app; if that session's provider is gone, the words of spec 9.4 say why first.
    const owner = typeof flags.resume === 'string' ? store.sessionOfRun(flags.resume) : undefined;
    const ownerProvider = owner ? store.getSession(owner)?.engine : undefined;
    if (ownerProvider !== undefined && !env.installed(ownerProvider)) {
      err(missingProviderWords(ownerProvider));
      store.close();
      return 1;
    }
    const chosen = named ?? defaultProviderOf(installed, readSetting(store, 'defaultProvider'))?.id;
    if (!chosen) {
      err('No provider is installed.');
      store.close();
      return 1;
    }
    // `--model` is a model name like any other (spec 9.2): `<provider>:<model>` puts the run on that provider, even against `--provider`.
    let provider = chosen;
    let model = typeof flags.model === 'string' && flags.model ? flags.model : undefined;
    if (model) {
      const p = parseModel(model, chosen, env.installed);
      if ('error' in p) {
        err(p.error);
        store.close();
        return 1;
      }
      if (named !== undefined && p.provider !== named) err(`--model ${model} names ${p.provider}, so the run is on ${p.provider}, not ${named}.`);
      provider = p.provider;
      model = p.model;
    }
    const effort = typeof flags.effort === 'string' ? flags.effort : undefined;
    const engineOf = makeEngineFrom(mods, { env: io.env, home: dir });
    const settings = { get maxCallsPerTurn() { return readSetting(store, 'maxCallsPerTurn'); } };
    const h = startRunCli({
      ...(pos[0] ? { file: pos[0] } : {}),
      ...(typeof flags.resume === 'string' ? { resumeId: flags.resume } : {}),
      cwd: process.cwd(),
      input: io.stdin,
      output: io.stdout,
      store,
      redactor,
      env: children(),
      yes: flags.yes === true,
      refuse: (w, resolveBlock) => runChecks(env, { provider, model }, w, resolveBlock),
      makeEngine: (cb) => engineOf({ provider, ...(model ? { model } : {}), ...(effort ? { effort } : {}), settings, ...cb }),
      subagentEngine: (s, cb) => {
        const r = resolveSubagent(env, { provider, model, effort }, s);
        if ('error' in r) return r;
        return { engine: engineOf({ provider: r.provider, ...(r.model ? { model: r.model } : {}), ...(r.effort ? { effort: r.effort } : {}), settings, ...cb }), ...(r.model ? { model: r.model } : {}) };
      },
    });
    const onSigint = () => h.sigint();
    process.on('SIGINT', onSigint);
    try {
      return (await h.done).exitCode;
    } finally {
      process.off('SIGINT', onSigint);
      store.close();
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
