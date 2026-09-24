import type { Cond, Diagnostic, Pos } from './model.js';

export type JudgeKind = 'you' | 'command' | 'deterministic' | 'agent' | 'model' | 'subagent';

export interface ParseCondResult {
  cond?: Cond;
  diag?: Diagnostic;
}

export function judgeOf(cond: Cond): JudgeKind {
  switch (cond.t) {
    case 'approve':
      return 'you';
    case 'tests':
    case 'cmd':
      return 'command';
    case 'diff':
    case 'touches':
    case 'attempts':
    case 'same':
    case 'drift':
      return 'deterministic';
    case 'done':
      return 'agent';
    case 'llm':
      return 'model';
    case 'review':
      return 'subagent';
    case 'and':
    case 'or':
      return judgeOf(cond.a);
    case 'not':
      return judgeOf(cond.a);
  }
}

export function printCond(c: Cond): string {
  switch (c.t) {
    case 'approve':
      return 'you approve';
    case 'tests':
      return 'tests pass';
    case 'cmd':
      return `\`${c.cmd}\` passes`;
    case 'llm':
      return `llm says "${c.q}"`;
    case 'review':
      return c.q ? `reviewer approves "${c.q}"` : 'reviewer approves';
    case 'done':
      return 'agent says done';
    case 'diff':
      return `diff > ${c.n} lines`;
    case 'touches':
      return `touches ${c.glob}`;
    case 'attempts':
      return `attempts > ${c.n}`;
    case 'same':
      return 'same error twice';
    case 'drift':
      return 'drift';
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
  }
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

  function parseAtom(): { cond?: Cond; diag?: Diagnostic } {
    skipWs();
    const atomStart = idx;

    if (src.startsWith('you approve', idx)) {
      idx += 'you approve'.length;
      return { cond: { t: 'approve' } };
    }

    if (src.startsWith('tests pass', idx)) {
      idx += 'tests pass'.length;
      return { cond: { t: 'tests' } };
    }

    if (src[idx] === '`') {
      idx++;
      let cmd = '';
      while (idx < len && src[idx] !== '`') {
        cmd += src[idx];
        idx++;
      }
      if (idx >= len) {
        return error('Unterminated command', idx);
      }
      idx++; // skip `
      skipWs();
      if (!src.startsWith('passes', idx)) {
        return error('Expected "passes" after command', idx);
      }
      idx += 'passes'.length;
      return { cond: { t: 'cmd', cmd } };
    }

    if (src.startsWith('llm says', idx)) {
      idx += 'llm says'.length;
      const qRes = parseQuotedString();
      if (qRes.diag) return qRes;
      return { cond: { t: 'llm', q: qRes.val! } };
    }

    if (src.startsWith('reviewer approves', idx)) {
      idx += 'reviewer approves'.length;
      skipWs();
      if (idx < len && (src[idx] === '"' || src[idx] === "'")) {
        const qRes = parseQuotedString();
        if (qRes.diag) return qRes;
        return { cond: { t: 'review', q: qRes.val } };
      }
      return { cond: { t: 'review' } };
    }

    if (src.startsWith('agent says done', idx)) {
      idx += 'agent says done'.length;
      return { cond: { t: 'done' } };
    }

    if (src.startsWith('diff', idx)) {
      idx += 'diff'.length;
      skipWs();
      if (idx >= len || src[idx] !== '>') {
        return error('Expected ">" after diff', idx);
      }
      idx++; // skip >
      skipWs();
      const numStart = idx;
      while (idx < len && /[0-9]/.test(src[idx]!)) {
        idx++;
      }
      if (numStart === idx) {
        return error('Expected integer after "diff >"', numStart);
      }
      const n = parseInt(src.slice(numStart, idx), 10);
      skipWs();
      if (!src.startsWith('lines', idx)) {
        return error('Expected "lines" after diff count', idx);
      }
      idx += 'lines'.length;
      return { cond: { t: 'diff', n } };
    }

    if (src.startsWith('touches', idx)) {
      idx += 'touches'.length;
      skipWs();
      const globStart = idx;
      while (idx < len && !/\s|[)]/.test(src[idx]!)) {
        idx++;
      }
      if (globStart === idx) {
        return error('Expected glob pattern after "touches"', globStart);
      }
      const glob = src.slice(globStart, idx);
      return { cond: { t: 'touches', glob } };
    }

    if (src.startsWith('attempts', idx)) {
      idx += 'attempts'.length;
      skipWs();
      if (idx >= len || src[idx] !== '>') {
        return error('Expected ">" after attempts', idx);
      }
      idx++; // skip >
      skipWs();
      const numStart = idx;
      while (idx < len && /[0-9]/.test(src[idx]!)) {
        idx++;
      }
      if (numStart === idx) {
        return error('Expected integer after "attempts >"', numStart);
      }
      const n = parseInt(src.slice(numStart, idx), 10);
      return { cond: { t: 'attempts', n } };
    }

    if (src.startsWith('same error twice', idx)) {
      idx += 'same error twice'.length;
      return { cond: { t: 'same' } };
    }

    if (src.startsWith('drift', idx)) {
      idx += 'drift'.length;
      return { cond: { t: 'drift' } };
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
