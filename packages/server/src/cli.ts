#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { printWorkflow } from '@reins/core';
import { claudeEngine } from './claude/engine.js';
import { findClaude } from './claude/find.js';
import { doctor } from './doctor.js';
import { serveMcp } from './mcp.js';
import { formatDiagnostic, loadWorkflow, startRunCli } from './run-cli.js';
import { defaultStorePath, openStore } from './store.js';

const USAGE = `usage:
  reins run <file> [--engine claude] [--model <m>] [--effort <e>] [--yes]
  reins run --resume <runId>
  reins check <file>
  reins print <file> [--write]
  reins doctor
  reins mcp            (internal: the approval MCP server Claude starts)`;

interface Io {
  stdout: Writable;
  stderr: Writable;
  stdin: Readable;
  env: NodeJS.ProcessEnv;
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
  const { pos, flags } = parseArgs(rest, ['yes', 'write']);

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

  if (cmd === 'doctor') {
    return (await doctor(out, io.env, io.env.REINS_HOME ?? os.homedir())) ? 0 : 1;
  }

  if (cmd === 'mcp') {
    serveMcp(io.stdin, io.stdout, io.env.REINS_APPROVE_URL ?? '');
    await new Promise((r) => io.stdin.on('end', r));
    return 0;
  }

  if (cmd === 'run' && (pos[0] || typeof flags.resume === 'string')) {
    if (flags.engine && flags.engine !== 'claude') {
      err(`The ${flags.engine} engine is not in Phase 2; only claude is (the Codex adapter is Phase 5).`);
      return 1;
    }
    const found = findClaude(io.env);
    const store = openStore(defaultStorePath());
    const h = startRunCli({
      ...(pos[0] ? { file: pos[0] } : {}),
      ...(typeof flags.resume === 'string' ? { resumeId: flags.resume } : {}),
      cwd: process.cwd(),
      input: io.stdin,
      output: io.stdout,
      store,
      yes: flags.yes === true,
      makeEngine: ({ workflow, ...cb }) => {
        if (workflow.engine === 'codex') throw new Error('This workflow asks for codex; the Codex adapter is Phase 5.');
        const model = typeof flags.model === 'string' ? flags.model : workflow.model;
        return claudeEngine({
          bin: found?.path ?? '',
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
    }
  }

  err(USAGE);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env }).then(
    (code) => { process.exitCode = code; },
    (e) => { process.stderr.write(`reins: ${e?.message ?? e}\n`); process.exitCode = 1; }
  );
}
