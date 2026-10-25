// M3 fix D, the app half. Items 5 and 9: the words under the Share and Export buttons carry every note of the server (a playbook file that is not carried),
// and the import dialog shows the tracks line next to the code prompt, for a single mod and for each mod of a mods file. Text only, never markup.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EnvelopeMod, ImportPanel, type KindSummary } from '../src/ImportSummary.js';
import { planOf } from '../src/importLines.js';
import { exportWords } from '../src/ShareWorkflow.js';

const LINE = 'This mod may run several sessions at once and spend money on them.';
const mod = (over: Partial<KindSummary> = {}): KindSummary => ({ id: 'a', label: 'A', kind: 'block', protocol: null, replaces: null, keys: [], headers: [], hasCode: true, codePrompt: 'CODE PROMPT', hash: 'h', files: [], warnings: [], ...over });

describe('the words under Share and Export my mods', () => {
  const note = 'The playbook review-pass is a file in your blocks folder and is not in this file. Whoever imports the file needs a playbook with that name.';
  it('hold every note, after the count', () => {
    expect(exportWords({ text: '', ids: [], notes: [note] })).toBe(`no mods in the file (the blocks it uses ship with Reins). ${note}`);
    expect(exportWords({ text: '', ids: ['a'], notes: ['n1', 'n2'] })).toBe('1 mod in the file. n1. n2');
    expect(exportWords({ text: '', ids: ['a', 'b'], notes: [] })).toBe('2 mods in the file');
  });
});

describe('the tracks line', () => {
  it('is in the plan only for a code mod that has it', () => {
    expect(planOf(mod({ tracksLine: LINE }), []).tracksLine).toBe(LINE);
    expect(planOf(mod(), []).tracksLine).toBeUndefined();
    expect(planOf(mod({ tracksLine: LINE, hasCode: false, codePrompt: undefined }), []).tracksLine).toBeUndefined();
    expect(planOf(undefined, []).tracksLine).toBeUndefined();
  });
  it('is shown under the code prompt of each mod of a mods file, and only for the mod that has it', () => {
    const show = (m: KindSummary) => renderToStaticMarkup(createElement(EnvelopeMod, { m, trust: new Set<string>(), replace: new Set<string>(), flip: () => {} }));
    const html = show(mod({ tracksLine: `${LINE} <i>x</i>` }));
    expect(html.indexOf(LINE)).toBeGreaterThan(html.indexOf('CODE PROMPT'));
    expect(html).not.toContain('<i>x</i>');
    expect(show(mod())).not.toContain('several sessions');
    expect(show(mod({ hasCode: false, codePrompt: undefined, tracksLine: LINE }))).not.toContain('several sessions');
  });
  it('is shown under the code prompt of a single mod, as text', () => {
    const html = renderToStaticMarkup(createElement(ImportPanel, { onDone: () => {}, onCancel: () => {}, shown: mod({ tracksLine: `${LINE} <b>x</b>` }) }));
    expect(html).toContain('CODE PROMPT');
    expect(html.indexOf(LINE)).toBeGreaterThan(html.indexOf('CODE PROMPT'));
    expect(html).not.toContain('<b>x</b>');
    expect(renderToStaticMarkup(createElement(ImportPanel, { onDone: () => {}, onCancel: () => {}, shown: mod() }))).not.toContain('several sessions');
  });
});
