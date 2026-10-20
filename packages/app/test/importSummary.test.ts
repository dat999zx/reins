import { describe, it, expect } from 'vitest';
import { CODE_PROMPT } from '../../server/src/mods/actions.js';
import { applyBody, planOf, problemsFrom, summaryLines, type PreviewSummary } from '../src/importLines.js';

// Spec 7.7, word for word.
const SPEC_PROMPT = 'This mod runs its own code inside Reins, with your rights: it can read your files and your keys, and use the network. Reins cannot limit what it does. Trust it only if you trust its author.';

const base = (over: Partial<PreviewSummary> = {}): PreviewSummary => ({
  id: 'acme', label: 'Acme', kind: 'provider', protocol: 'openai-chat', replaces: null, keys: [], headers: [], hasCode: false,
  files: [{ name: 'mod.json', bytes: 321 }], warnings: [], ...over,
});

describe('summaryLines', () => {
  it('says id, label, kind, protocol and the files', () => {
    expect(summaryLines(base())).toEqual(['Id: acme', 'Label: Acme', 'Kind: provider', 'Protocol: openai-chat', 'Files: mod.json (321 bytes)']);
    expect(summaryLines(base({ protocol: null }))).not.toContain('Protocol: null');
  });

  it('says what it replaces, in the server words, for your copy and for a built-in provider', () => {
    expect(summaryLines(base({ replaces: 'your', replacesLine: 'replaces your acme' }))).toContain('replaces your acme');
    expect(summaryLines(base({ replaces: 'builtin', replacesLine: 'replaces the built-in acme' }))).toContain('replaces the built-in acme');
    expect(summaryLines(base({ replaces: 'your' }))).toContain('replaces your acme');
    expect(summaryLines(base({ replaces: 'builtin' }))).toContain('replaces the built-in acme');
    expect(summaryLines(base()).join('\n')).not.toMatch(/replaces/);
  });

  it('says each key line, with the plain http words, the header names, the code and every warning', () => {
    const lines = summaryLines(base({
      keys: [
        { name: 'ACME_KEY', host: 'api.acme.test', plainHttp: false, line: 'sends the value of ACME_KEY to api.acme.test' },
        { name: 'ACME_TWO', host: 'api.acme.test', plainHttp: true, line: 'sends the value of ACME_TWO to api.acme.test over plain http' },
      ],
      headers: ['x-one', 'x-two'], hasCode: true,
      warnings: ['api.acme.test is not on this machine and is reached over plain http, so the key can be read on the way.', 'also holds files the manifest does not name: notes.txt. They are part of the code you would trust.'],
    }));
    expect(lines).toContain('sends the value of ACME_KEY to api.acme.test');
    expect(lines).toContain('sends the value of ACME_TWO to api.acme.test over plain http');
    expect(lines).toContain('Adds headers: x-one, x-two');
    expect(lines).toContain('Has code: it runs inside Reins.');
    expect(lines).toContain('api.acme.test is not on this machine and is reached over plain http, so the key can be read on the way.');
    expect(lines).toContain('also holds files the manifest does not name: notes.txt. They are part of the code you would trust.');
  });

  it('returns text with markup characters as plain strings, unchanged', () => {
    const evil = '<img src=x onerror=alert(1)> & "q"';
    const lines = summaryLines(base({ label: evil, files: [{ name: '<b>x</b>.json', bytes: 1 }], warnings: ['<script>x</script>'] }));
    expect(lines).toContain(`Label: ${evil}`);
    expect(lines).toContain('Files: <b>x</b>.json (1 bytes)');
    expect(lines).toContain('<script>x</script>');
    expect(lines.every((l) => typeof l === 'string')).toBe(true);
  });
});

describe('planOf', () => {
  it('lets a plain mod be imported, and a refusal not', () => {
    expect(planOf(base(), [])).toEqual({ canImport: true, trustChoice: false, confirmBuiltin: false });
    expect(planOf(undefined, ['`mod.json` is missing from the files.']).canImport).toBe(false);
    expect(planOf(base(), ['a problem']).canImport).toBe(false);
  });

  it('asks the code prompt of a mod with code, with the words the server sent', () => {
    const plan = planOf(base({ hasCode: true, codePrompt: SPEC_PROMPT }), []);
    expect(plan).toEqual({ canImport: true, trustChoice: true, confirmBuiltin: false, codePrompt: SPEC_PROMPT });
    // the app holds no copy of the words: none from the server, none shown, and Import stays off
    const none = planOf(base({ hasCode: true }), []);
    expect(none.canImport).toBe(false);
    expect(none.codePrompt).toBeUndefined();
  });

  it('the server words are the spec 7.7 sentence, word for word', () => {
    expect(CODE_PROMPT).toBe(SPEC_PROMPT);
  });

  it('asks for the built-in confirm only for a mod that replaces a built-in one', () => {
    expect(planOf(base({ replaces: 'builtin' }), []).confirmBuiltin).toBe(true);
    expect(planOf(base({ replaces: 'your' }), []).confirmBuiltin).toBe(false);
  });
});

describe('applyBody', () => {
  it('sends trust only after "Trust and import", and replaceBuiltin only after the confirm', () => {
    expect(applyBody('text', { trust: false, replaceBuiltin: false })).toEqual({ file: 'text' });
    expect(applyBody('text', { trust: true, replaceBuiltin: false })).toEqual({ file: 'text', trust: true });
    expect(applyBody('text', { trust: false, replaceBuiltin: true })).toEqual({ file: 'text', replaceBuiltin: true });
  });
});

describe('problemsFrom', () => {
  it('uses the server list, or the one error line', () => {
    expect(problemsFrom({ error: 'a b', problems: ['a', 'b'] }, 'a b')).toEqual(['a', 'b']);
    expect(problemsFrom({ error: 'one' }, 'one')).toEqual(['one']);
    expect(problemsFrom(undefined, 'fallback')).toEqual(['fallback']);
  });
});
