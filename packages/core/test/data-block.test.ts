// M2 Task 19, core side: a data block's node (`dataBlock`) and the template filler it uses (`fillTurn`). A data block is one TURN whose prompt is the
// manifest's `turn` with its placeholders filled from the step's own attributes; its policy is the step's (`policyOf`), never the manifest's.
import { afterEach, describe, expect, it } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { validate } from '../src/validate.js';
import { compileProgram } from '../src/compile.js';
import { dataBlock, fillTurn, turnNames } from '../src/data-block.js';
import { NODES, register } from '../src/nodes/index.js';

const head = '---\nreins: 1\nname: t\nbudget: { turns: 10, minutes: 10 }\nalways: []\n---\n\n';
const BIDI = String.fromCharCode(0x202e); // a right-to-left override, written so no source line holds it
const disposers: Array<() => void> = [];
afterEach(() => { for (const off of disposers.splice(0).reverse()) off(); });

/** Registers a data block `ask` at order 150 (after `end`), undone after the test. */
function ask(turn = 'Answer about {topic}. Mode: {mode|topic}.', statusLine?: string) {
  disposers.push(register(dataBlock({ kind: 'ask', attrs: ['topic', 'mode'], turn, statusLine }), 150));
}

describe('fillTurn: placeholders are filled from the step\'s own attributes', () => {
  it('fills `{attr}` with the value the step has', () => {
    expect(fillTurn('Topic {topic}.', { topic: 'cats' })).toBe('Topic cats.');
  });

  it('`{a|b}` takes the first alternative that has a value', () => {
    expect(fillTurn('{mode|topic}', { topic: 'cats' })).toBe('cats');
    expect(fillTurn('{mode|topic}', { mode: 'read-only', topic: 'cats' })).toBe('read-only');
    expect(fillTurn('{mode|topic}', { mode: '', topic: 'cats' })).toBe('cats');
  });

  it('a placeholder the step does not set fills empty', () => {
    expect(fillTurn('[{nope}]', {})).toBe('[]');
  });

  it('fills only own string properties: constructor, __proto__ and an inherited value fill empty', () => {
    expect(fillTurn('{constructor}|{__proto__.x}|{toString}|{__proto__}', {})).toBe('|||');
    expect(fillTurn('{topic}', Object.create({ topic: 'inherited' }))).toBe('');
  });

  it('an own value that is not text fills empty', () => {
    expect(fillTurn('[{n}|{o}]', { n: 5, o: { x: 1 } } as unknown as Record<string, string>)).toBe('[|]');
  });

  it('a value with a hidden character is shown, not written as it is', () => {
    expect(fillTurn('{x}', { x: `a${BIDI}b` })).toBe('a<U+202E>b');
  });

  it('a value is cut to 1000 characters', () => {
    const out = fillTurn('{x}', { x: 'y'.repeat(5000) });
    expect(out.length).toBe(1003);
    expect(out.endsWith('...')).toBe(true);
  });

  it('the whole prompt is cut to 16 KB, however many placeholders it has', () => {
    const out = fillTurn('{x}'.repeat(2000), { x: 'y'.repeat(900) });
    expect(out.length).toBeLessThanOrEqual(16 * 1024 + 3);
    expect(out.endsWith('...')).toBe(true);
  });

  it('the template\'s own text is kept as it is, a line break included', () => {
    expect(fillTurn('a\nb {x}', { x: 'c' })).toBe('a\nb c');
  });
});

describe('turnNames: every attribute a template names', () => {
  it('lists each alternative of each placeholder, in order', () => {
    expect(turnNames('{topic} and {mode|topic}, not text')).toEqual(['topic', 'mode', 'topic']);
    expect(turnNames('no placeholder')).toEqual([]);
  });
});

describe('dataBlock: one TURN, its prompt the filled template, its policy the step\'s', () => {
  const compile = (text: string) => {
    const w = parseWorkflow(head + text).workflow!;
    return { errors: validate(w).filter((d) => d.severity === 'error'), program: compileProgram(w) };
  };

  it('compiles a step to exactly one TURN with the filled prompt and a write policy', () => {
    ask();
    const { errors, program } = compile('## ask\ntopic: cats\n');
    expect(errors).toEqual([]);
    expect(program.map((i) => i.op)).toEqual(['TURN', 'END']); // the step's one TURN, then the workflow's END
    expect(program[0]).toMatchObject({ op: 'TURN', policy: { mode: 'write', allowShell: true }, src: { prompt: 'Answer about cats. Mode: cats.' } });
  });

  it('`mode: read-only` on the step gives a read-only policy', () => {
    ask();
    const { program } = compile('## ask\ntopic: cats\nmode: read-only\n');
    expect(program[0]).toMatchObject({ op: 'TURN', policy: { mode: 'read-only' }, src: { prompt: 'Answer about cats. Mode: read-only.' } });
  });

  it('the step\'s own prompt lines are not sent: the manifest\'s template is the prompt', () => {
    ask();
    const { program } = compile('## ask\ntopic: cats\n> my own words\n');
    expect(program[0]).toMatchObject({ src: { prompt: 'Answer about cats. Mode: cats.' } });
  });

  it('a bad `mode` on the step is an error, as for any kind', () => {
    ask();
    expect(compile('## ask\ntopic: cats\nmode: sideways\n').errors.map((d) => d.message).join(' ')).toContain('mode must be read-only or write');
  });

  it('a data block has no ops, no exec and no heading; its status line is the manifest\'s', () => {
    ask('Say {topic}.', 'REINS: done | blocked: <why>');
    const node = NODES.get('ask')!;
    expect(node).toMatchObject({ kind: 'ask', attrs: ['topic', 'mode'], statusLine: 'REINS: done | blocked: <why>' });
    expect(node.ops).toBeUndefined();
    expect(node.exec).toBeUndefined();
    expect(node.heading).toBeUndefined();
  });
});
