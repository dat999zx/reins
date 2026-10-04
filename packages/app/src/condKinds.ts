import type { Cond } from '@reins/core';

export type CondParam = { key: 'cmd' | 'q' | 'n' | 'glob'; look: 'code' | 'str' | 'num' | 'pill'; optional?: true };
type CondKind = { label: string; fresh(): Cond; param?: CondParam };

export const COND_KINDS: Record<string, CondKind> = {
  approve: { label: 'you approve', fresh: () => ({ t: 'approve' }) },
  tests: { label: 'tests pass', fresh: () => ({ t: 'tests' }) },
  cmd: { label: 'command passes', fresh: () => ({ t: 'cmd', cmd: 'npm run lint' }), param: { key: 'cmd', look: 'code' } },
  llm: { label: 'LLM says', fresh: () => ({ t: 'llm', q: 'the plan covers every requirement' }), param: { key: 'q', look: 'str' } },
  review: { label: 'reviewer approves', fresh: () => ({ t: 'review' }), param: { key: 'q', look: 'str', optional: true } },
  done: { label: 'agent says done', fresh: () => ({ t: 'done' }) },
  diff: { label: 'diff > N lines', fresh: () => ({ t: 'diff', n: 300 }), param: { key: 'n', look: 'num' } },
  touches: { label: 'touches files', fresh: () => ({ t: 'touches', glob: 'migrations/**' }), param: { key: 'glob', look: 'pill' } },
  attempts: { label: 'attempts > N', fresh: () => ({ t: 'attempts', n: 3 }), param: { key: 'n', look: 'num' } },
  same: { label: 'same error twice', fresh: () => ({ t: 'same' }) },
  drift: { label: 'drift detected', fresh: () => ({ t: 'drift' }) },
};

// ponytail: the core printers do not escape, so a value that would not read back is refused here; escape in core print to lift it
const OK: Record<CondParam['key'], (v: string) => boolean> = {
  n: (v) => /^\d{1,9}$/.test(v),
  q: (v) => !/["\\]/.test(v),
  cmd: (v) => v !== '' && !v.includes('`'),
  glob: (v) => v !== '' && !/[\s)]/.test(v),
};

// A new atom with the value set, or undefined when the value would not print back.
export function applyParam(c: Cond, v: string): Cond | undefined {
  const p = COND_KINDS[c.t]?.param;
  if (!p) return undefined;
  if (p.optional && v === '') {
    const { [p.key]: _gone, ...rest } = c as Cond & Record<string, unknown>;
    return rest as Cond;
  }
  if (!OK[p.key](v)) return undefined;
  return { ...c, [p.key]: p.key === 'n' ? Number(v) : v } as Cond;
}
