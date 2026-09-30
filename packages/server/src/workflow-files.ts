import fs from 'node:fs';
import path from 'node:path';
import { compileProgram, compileTurn, parseWorkflow, type Step } from '@reins/core';
import { loadWorkflowText } from './run-cli.js';
import { under } from './session.js';

export type Scope = 'project' | 'user';
type Denied = { status: 400 | 404; error: string };
type Reply = { status: number; body: unknown };

const denied = (status: 400 | 404, error: string): Denied => ({ status, error });
const real = (p: string) => {
  try { return fs.realpathSync(p); } catch { return undefined; }
};
const there = (p: string) => {
  try { fs.lstatSync(p); return true; } catch { return false; }
};
const reply = (d: Denied): Reply => ({ status: d.status, body: { error: d.error } });

export function resolveWorkflowPath(
  cwd: string, dir: string, p: string, o: { forWrite: boolean; missingOk?: boolean },
): { abs: string; scope: Scope } | Denied {
  if (p.includes('\0')) return denied(400, 'The path has a NUL byte.');
  const abs = path.resolve(cwd, p);
  const name = path.basename(abs);
  if (!name.endsWith('.reins.md') || name.includes(':')) return denied(400, 'The file name must end in .reins.md and have no colon.');
  const roots: Record<Scope, string> = { project: path.join(cwd, '.reins', 'workflows'), user: path.join(dir, 'workflows') };
  const scope = (['project', 'user'] as const).find((s) => path.relative(roots[s], path.dirname(abs)) === '');
  if (!scope) return denied(400, 'The workflow must be directly in <session folder>/.reins/workflows or ~/.reins/workflows.');
  const folder = roots[scope];
  const realCwd = real(cwd);
  const outside = () => denied(400, 'The .reins folder must stay inside the session folder.');

  if (scope === 'project') {
    const dot = path.join(cwd, '.reins');
    if (there(dot)) {
      const r = real(dot);
      if (!r || !realCwd || !under(r, realCwd)) return outside();
    }
  }
  if (o.forWrite) {
    try { fs.mkdirSync(folder, { recursive: true }); } catch { return denied(400, 'Cannot create the workflows folder.'); }
  }
  const realFolder = real(folder);
  if (!realFolder) return o.missingOk ? { abs, scope } : o.forWrite ? denied(400, 'Cannot create the workflows folder.') : denied(404, 'No such workflow.');
  if (scope === 'project' && (!realCwd || !under(realFolder, realCwd))) return outside();

  if (there(abs)) {
    if (real(abs) !== path.join(realFolder, name)) return denied(400, 'The file is a link that leaves the workflows folder, or does not resolve.');
  } else if (!o.forWrite && !o.missingOk) {
    return denied(404, 'No such workflow.');
  }
  return { abs, scope };
}

export function readWorkflow(cwd: string, dir: string, p: string): Reply {
  const r = resolveWorkflowPath(cwd, dir, p, { forWrite: false });
  if ('error' in r) return reply(r);
  let text: string;
  try { text = fs.readFileSync(r.abs, 'utf8'); } catch { return reply(denied(400, 'Cannot read the file.')); }
  return { status: 200, body: { path: r.abs, text, diagnostics: loadWorkflowText(text, r.abs).diagnostics } };
}

export function writeWorkflow(cwd: string, dir: string, p: string, text: string, create: boolean): Reply {
  const r = resolveWorkflowPath(cwd, dir, p, { forWrite: true });
  if ('error' in r) return reply(r);
  // ponytail: a link swapped in between the check and this write is followed; local attackers only. O_NOFOLLOW if it matters.
  try {
    fs.writeFileSync(r.abs, text, create ? { flag: 'wx' } : {});
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EEXIST' ? { status: 409, body: { error: 'A workflow with that name already exists.' } } : reply(denied(400, 'Cannot write the file.'));
  }
  return { status: 200, body: { diagnostics: loadWorkflowText(text, r.abs).diagnostics } };
}

export function previewWorkflow(cwd: string, dir: string, p: string, text: string, stepId?: string): Reply {
  const r = resolveWorkflowPath(cwd, dir, p, { forWrite: false, missingOk: true });
  if ('error' in r) return reply(r);
  const loaded = loadWorkflowText(text, r.abs);
  const flat: Array<{ step: Step; depth: number }> = [];
  const walk = (steps: Step[], depth: number) => {
    for (const step of steps) {
      flat.push({ step, depth });
      walk(step.kids ?? [], depth + 1);
      walk(step.else ?? [], depth + 1);
    }
  };
  walk(parseWorkflow(text).workflow?.steps ?? [], 0);
  const steps = flat.map(({ step, depth }) => ({ id: step.id, kind: step.kind, ...(step.title ? { title: step.title } : {}), depth }));

  let turn: string | undefined;
  const w = loaded.workflow;
  if (w && stepId !== undefined) {
    const instr = compileProgram(w, loaded.resolveBlock).find((i) => i.op === 'TURN' && i.step === stepId);
    const step = instr?.op === 'TURN' ? instr.src ?? flat.find((f) => f.step.id === stepId)?.step : undefined;
    if (instr && step) turn = compileTurn(step, { workflowName: w.name, stepIndex: instr.top ?? 0, totalSteps: w.steps.length, always: w.always });
  }
  return { status: 200, body: { diagnostics: loaded.diagnostics, steps, ...(turn !== undefined ? { turn } : {}) } };
}
