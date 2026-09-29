import type { Cond, Diagnostic, Pos } from './model.js';
import type { CommandResult, RunEventRecord } from './run.js';
import { CONDS } from './conds/index.js';

export type JudgeKind = 'you' | 'command' | 'deterministic' | 'agent' | 'model' | 'subagent';

export interface ParseCondResult {
  cond?: Cond;
  diag?: Diagnostic;
}

/** The cursor a condition atom's `parse` reads from. */
export interface Scanner {
  readonly src: string;
  /** Read-write cursor. An atom that returns `null` must leave it unchanged. */
  idx: number;
  readonly len: number;
  skipWs(): void;
  /** A diagnostic at `i` (default: the cursor), with the caller's line and column offset. */
  error(msg: string, i?: number): { diag: Diagnostic };
  /** A '…' or "…" string at the cursor. */
  quoted(): { val?: string; diag?: Diagnostic };
}

/** What an atom may read while it is judged. Run builds a fresh one for each top-level judge call. */
export interface EvalCtx {
  lastTurnText: string | undefined;
  /** The run's live array: read it, never write it. */
  commandResults: CommandResult[];
  /** Runs the command AND records its result, so a later `same error twice` sees it. */
  runCommand(cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** The sum of every loop's attempt counter. */
  loopTotal: number;
  /** The run's live event log. */
  events: RunEventRecord[];
  cwd: string;
  /** workflow.test, or 'npm test'. */
  testCmd: string;
  /** The instruction being run is a RUN (its command just ran). */
  atRun: boolean;
  judge?: (cond: Cond, evidence: { lastText: string }) => Promise<boolean>;
  logEvent(type: RunEventRecord['type'], data: any): void;
  diffLines?: () => Promise<number>;
}

/** One condition atom. Add a file under conds/ and list it in conds/index.ts. */
export interface CondType<C extends { t: string } = any> {
  t: string;
  /**
   * Try this atom at the cursor. `null`: not mine, try the next atom (and leave `s.idx` as it was).
   * A diagnostic: mine but malformed, and parsing stops. Atoms are tried in CONDS order.
   */
  parse(s: Scanner): C | { diag: Diagnostic } | null;
  print(c: C): string;
  judge: JudgeKind;
  /** Judged without waiting. Absent: an auto card judges it on the async path. */
  evalSync?(c: C, ctx: EvalCtx): boolean;
  /** Defaults to evalSync. With neither, the atom is false. */
  evaluate?(c: C, ctx: EvalCtx): Promise<boolean>;
  /** Always false inside an auto card (`not` flips it). */
  auto?: false;
  /** Globs the validator checks. */
  globs?(c: C): string[];
  /** The validator's "costs extra model calls" warning names this. */
  modelCall?: string;
  /** Warn when the workflow sets no `test:` command. */
  needsTestCmd?: boolean;
}

export function judgeOf(cond: Cond): JudgeKind {
  if (cond.t === 'and' || cond.t === 'or' || cond.t === 'not') return judgeOf(cond.a);
  return CONDS.get(cond.t)?.judge as JudgeKind;
}

export function printCond(c: Cond): string {
  switch (c.t) {
    case 'not': {
      const inner = printCond(c.a);
      if (c.a.t === 'and' || c.a.t === 'or') {
        return `not (${inner})`;
      }
      return `not ${inner}`;
    }
    case 'and': {
      let left = printCond(c.a);
      if (c.a.t === 'or') {
        left = `(${left})`;
      }
      let right = printCond(c.b);
      if (c.b.t === 'or' || c.b.t === 'and') {
        right = `(${right})`;
      }
      return `${left} and ${right}`;
    }
    case 'or': {
      const left = printCond(c.a);
      let right = printCond(c.b);
      if (c.b.t === 'or') {
        right = `(${right})`;
      }
      return `${left} or ${right}`;
    }
    default:
      return CONDS.get(c.t)?.print(c) as string;
  }
}

/**
 * The auto-card sync pass: `auto: false` atoms are false, atoms without evalSync are unknown (null),
 * and and/or short-circuit on the left side. null means: judge the whole condition with evalCond.
 */
export function evalCondSync(c: Cond, ctx: EvalCtx): boolean | null {
  if (c.t === 'not') { const r = evalCondSync(c.a, ctx); return r === null ? null : !r; }
  if (c.t === 'and') { const a = evalCondSync(c.a, ctx); if (a === false) return false; if (a === null) return null; return evalCondSync(c.b, ctx); }
  if (c.t === 'or') { const a = evalCondSync(c.a, ctx); if (a === true) return true; if (a === null) return null; return evalCondSync(c.b, ctx); }
  const type = CONDS.get(c.t);
  if (!type || type.auto === false) return false;
  return type.evalSync ? type.evalSync(c, ctx) : null;
}

export async function evalCond(c: Cond, ctx: EvalCtx, forAuto = false): Promise<boolean> {
  if (c.t === 'not') return !(await evalCond(c.a, ctx, forAuto));
  if (c.t === 'and') return (await evalCond(c.a, ctx, forAuto)) && (await evalCond(c.b, ctx, forAuto));
  if (c.t === 'or') return (await evalCond(c.a, ctx, forAuto)) || (await evalCond(c.b, ctx, forAuto));
  const type = CONDS.get(c.t);
  if (!type || (forAuto && type.auto === false)) return false;
  if (type.evaluate) return type.evaluate(c, ctx);
  return type.evalSync ? type.evalSync(c, ctx) : false;
}

export function condAtoms(c: Cond | undefined, out: Cond[] = []): Cond[] {
  if (!c) return out;
  if (c.t === 'and' || c.t === 'or') { condAtoms(c.a, out); condAtoms(c.b, out); }
  else if (c.t === 'not') condAtoms(c.a, out);
  else out.push(c);
  return out;
}

export function parseCond(src: string, basePos: Pos = { line: 1, col: 1 }): ParseCondResult {
  let idx = 0;
  const len = src.length;

  function posAt(i: number): Pos {
    return {
      line: basePos.line,
      col: basePos.col + i,
    };
  }

  function skipWs(): void {
    while (idx < len && /\s/.test(src[idx]!)) {
      idx++;
    }
  }

  function error(msg: string, i: number = idx): { diag: Diagnostic } {
    return {
      diag: {
        severity: 'error',
        message: msg,
        pos: posAt(i),
      },
    };
  }

  function matchWord(word: string): boolean {
    skipWs();
    if (src.startsWith(word, idx)) {
      const nextChar = src[idx + word.length];
      if (!nextChar || /\s|[()]/.test(nextChar)) {
        idx += word.length;
        return true;
      }
    }
    return false;
  }

  function parseOr(): { cond?: Cond; diag?: Diagnostic } {
    const leftRes = parseAnd();
    if (leftRes.diag) return leftRes;
    let left = leftRes.cond!;

    while (true) {
      const save = idx;
      if (matchWord('or')) {
        const rightRes = parseAnd();
        if (rightRes.diag) return rightRes;
        left = { t: 'or', a: left, b: rightRes.cond! };
      } else {
        idx = save;
        break;
      }
    }
    return { cond: left };
  }

  function parseAnd(): { cond?: Cond; diag?: Diagnostic } {
    const leftRes = parseUnary();
    if (leftRes.diag) return leftRes;
    let left = leftRes.cond!;

    while (true) {
      const save = idx;
      if (matchWord('and')) {
        const rightRes = parseUnary();
        if (rightRes.diag) return rightRes;
        left = { t: 'and', a: left, b: rightRes.cond! };
      } else {
        idx = save;
        break;
      }
    }
    return { cond: left };
  }

  function parseUnary(): { cond?: Cond; diag?: Diagnostic } {
    skipWs();
    const save = idx;
    if (matchWord('not')) {
      const sub = parseUnary();
      if (sub.diag) return sub;
      return { cond: { t: 'not', a: sub.cond! } };
    }
    idx = save;

    if (idx < len && src[idx] === '(') {
      idx++;
      const inner = parseOr();
      if (inner.diag) return inner;
      skipWs();
      if (idx >= len || src[idx] !== ')') {
        return error('Expected closing parenthesis', idx);
      }
      idx++;
      return inner;
    }

    return parseAtom();
  }

  function parseQuotedString(): { val?: string; diag?: Diagnostic } {
    skipWs();
    if (idx >= len || (src[idx] !== '"' && src[idx] !== "'")) {
      return error('Expected quoted string', idx);
    }
    const quote = src[idx]!;
    idx++;
    let val = '';
    while (idx < len && src[idx] !== quote) {
      if (src[idx] === '\\' && idx + 1 < len) {
        idx++;
        val += src[idx];
      } else {
        val += src[idx];
      }
      idx++;
    }
    if (idx >= len) {
      return error('Unterminated quoted string', idx);
    }
    idx++; // skip closing quote
    return { val };
  }

  const s: Scanner = {
    src,
    get idx() { return idx; },
    set idx(v) { idx = v; },
    len,
    skipWs,
    error,
    quoted: parseQuotedString,
  };

  function parseAtom(): { cond?: Cond; diag?: Diagnostic } {
    skipWs();
    const atomStart = idx;
    for (const type of CONDS.values()) {
      const r = type.parse(s);
      if (r === null) { idx = atomStart; continue; }
      if ('diag' in r) return r;
      return { cond: r as Cond };
    }
    return error(`Unexpected condition token at "${src.slice(atomStart, Math.min(len, atomStart + 15))}"`, atomStart);
  }

  const result = parseOr();
  if (result.diag) return result;

  skipWs();
  if (idx < len) {
    return error(`Unexpected trailing characters "${src.slice(idx)}"`, idx);
  }

  return result;
}
