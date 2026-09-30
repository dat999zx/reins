import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONDS, compileProgram, condAtoms, printCond, type Cond, type Workflow } from '@reins/core';

// Files claude -p runs with no prompt: their hooks, MCP servers, apiKeyHelper and permissions.allow (plan 15d 3b.4).
const FOLDER_FILES = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json'];
export const FOLDER_PATH = '.claude/';

export function folderHash(cwd: string): { hash: string; detail: string } | undefined {
  const found = FOLDER_FILES.flatMap((f) => {
    try {
      return [{ f, text: fs.readFileSync(path.join(cwd, f), 'utf8') }];
    } catch {
      return [];
    }
  });
  if (!found.length) return undefined;
  const h = createHash('sha256');
  for (const x of found) h.update(`${x.f}\0${x.text.length}\0${x.text}\0`); // the length keeps file boundaries
  return { hash: h.digest('hex'), detail: found.map((x) => `${x.f}\n${x.text.slice(0, 4096)}`).join('\n\n') };
}

// What a workflow runs on its own (plan 15d 3b.6): RUN commands, the atoms a command judges, and the test command. No kind is named here.
export function commandsOf(w: Workflow, resolveBlock: (name: string) => Workflow | undefined): string[] {
  const out: string[] = [];
  const conds = (c: Cond | undefined) => {
    for (const a of condAtoms(c)) if (CONDS.get(a.t)?.judge === 'command') out.push(printCond(a));
  };
  for (const i of compileProgram(w, resolveBlock)) {
    if (i.op === 'RUN') out.push(i.cmd);
    const { cond, repeatCond } = i as { cond?: Cond; repeatCond?: Cond };
    conds(cond);
    conds(repeatCond);
  }
  for (const a of w.autos) conds(a.cond);
  out.push(w.test ?? 'npm test');
  return out;
}

export const hashCommands = (commands: string[]) => createHash('sha256').update(commands.join('\0')).digest('hex');
