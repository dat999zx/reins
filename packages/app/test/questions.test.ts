import { describe, it, expect } from 'vitest';
import { actionsFor, GENERIC, offersStop } from '../src/questions.js';

const pick = (kind: string, label: string) => actionsFor(kind).find((a) => a.label === label)!;
const labels = (kind: string) => actionsFor(kind).map((a) => a.label);

describe('question kinds', () => {
  it('gate: approve, changes <note>, stop', () => {
    expect(labels('gate')).toEqual(['Approve', 'Request changes', 'Stop']);
    expect(pick('gate', 'Approve').build('')).toBe('approve');
    expect(pick('gate', 'Request changes').build('rename it')).toBe('changes rename it');
    expect(pick('gate', 'Stop').build('')).toBe('stop');
  });

  it('gate: request changes is disabled while the note is empty', () => {
    expect(pick('gate', 'Request changes').build('')).toBeNull();
    expect(pick('gate', 'Request changes').build('   ')).toBeNull();
  });

  it('budget: allow <n> with a default of 2, at least 1', () => {
    const allow = pick('budget', 'Allow');
    expect(allow.field?.initial).toBe('2');
    expect(allow.build('2')).toBe('allow 2');
    expect(allow.build('10')).toBe('allow 10');
    for (const bad of ['', '0', '-1', '1.5', 'x']) expect(allow.build(bad)).toBeNull();
    expect(pick('budget', 'Stop').build('')).toBe('stop');
  });

  it('usd: allow $<amount>, an amount above 0 with at most two decimals, and stop', () => {
    expect(labels('usd')).toEqual(['Allow', 'Stop']);
    const allow = pick('usd', 'Allow');
    expect(allow.field).toMatchObject({ placeholder: 'more USD', initial: '0.50' });
    expect(allow.build('0.5')).toBe('allow $0.5');
    expect(allow.build(' 2 ')).toBe('allow $2');
    for (const bad of ['', 'x', '0', '1.234']) expect(allow.build(bad), bad).toBeNull();
    expect(pick('usd', 'Stop').build('')).toBe('stop');
    expect(offersStop('usd')).toBe(true);
  });

  it('resume: resume or resume <note>, and stop', () => {
    expect(pick('resume', 'Resume').build('')).toBe('resume');
    expect(pick('resume', 'Resume').build('  ')).toBe('resume');
    expect(pick('resume', 'Resume').build('go on')).toBe('resume go on');
    expect(pick('resume', 'Stop').build('')).toBe('stop');
  });

  it('tool: y, and n or n <reason>', () => {
    expect(labels('tool')).toEqual(['Allow', 'Deny']);
    expect(pick('tool', 'Allow').build('')).toBe('y');
    expect(pick('tool', 'Deny').build('')).toBe('n');
    expect(pick('tool', 'Deny').build(' ')).toBe('n');
    expect(pick('tool', 'Deny').build('too risky')).toBe('n too risky');
  });

  it('judge and trust: y and n', () => {
    expect([pick('judge', 'Yes').build(''), pick('judge', 'No').build('')]).toEqual(['y', 'n']);
    expect([pick('trust', 'Trust').build(''), pick('trust', "Don't trust").build('')]).toEqual(['y', 'n']);
  });

  it('switch: Switch and Keep the current model, no Stop of its own', () => {
    expect(labels('switch')).toEqual(['Switch', 'Keep the current model']);
    expect([pick('switch', 'Switch').build(''), pick('switch', 'Keep the current model').build('')]).toEqual(['switch', 'keep']);
    expect(offersStop('switch')).toBe(false);
  });

  it('offersStop: the kinds whose card has its own Stop', () => {
    for (const k of ['gate', 'budget', 'resume']) expect(offersStop(k), k).toBe(true);
    for (const k of ['tool', 'trust', 'judge', 'brand-new-kind']) expect(offersStop(k), k).toBe(false);
  });

  it('a kind with no file gets the generic card, which sends the typed text as is', () => {
    expect(actionsFor('brand-new-kind')).toBe(GENERIC.actions);
    const send = actionsFor('brand-new-kind')[0]!;
    expect(send.build('  keep  my spaces ')).toBe('  keep  my spaces ');
    expect(send.build('')).toBeNull();
    expect(send.build('  ')).toBeNull();
  });
});
