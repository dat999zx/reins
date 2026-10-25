// M3 Task 14 (Group E), the app half: the import request of a mods file names each trusted code mod by the hash that was shown (never `true`), a mod that takes
// a built-in's place needs its own confirm, and the Share button of the workflow menu is off while the workflow has unsaved changes.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { envelopeBody, envelopeReady, isEnvelope, type EnvelopeSummary, type KindSummary } from '../src/ImportSummary.js';
import { ExportMine, ShareButton, shareName } from '../src/ShareWorkflow.js';

const mod = (id: string, over: Partial<KindSummary> = {}): KindSummary => ({ id, label: id, kind: 'block', protocol: null, replaces: null, keys: [], headers: [], hasCode: true, codePrompt: 'p', hash: `h-${id}`, files: [], warnings: [], ...over });
const env = (mods: KindSummary[], workflow?: EnvelopeSummary['workflow']): EnvelopeSummary => ({ envelope: true, mods, adds: [], warnings: [], ...(workflow ? { workflow } : {}) });

describe('the import request of a mods file', () => {
  it('names each ticked code mod with the hash the preview showed, and nothing else', () => {
    const s = env([mod('a'), mod('b'), mod('d', { hasCode: false })]);
    expect(envelopeBody('FILE', s, new Set(['a']), new Set())).toEqual({ file: 'FILE', trust: { a: 'h-a' } });
    expect(envelopeBody('FILE', s, new Set(['a', 'b']), new Set())).toEqual({ file: 'FILE', trust: { a: 'h-a', b: 'h-b' } });
    expect(envelopeBody('FILE', s, new Set(), new Set())).toEqual({ file: 'FILE' });
  });
  it('never trusts a data mod, an id that is not in the file, or a mod with no hash; never sends true', () => {
    const s = env([mod('d', { hasCode: false }), mod('n', { hash: undefined })]);
    expect(envelopeBody('F', s, new Set(['d', 'n', 'ghost']), new Set())).toEqual({ file: 'F' });
    expect(JSON.stringify(envelopeBody('F', env([mod('a')]), new Set(['a']), new Set()))).not.toContain('true');
  });
  it('lists the built-ins the user confirmed', () => {
    const s = env([mod('say', { replaces: 'builtin' })]);
    expect(envelopeBody('F', s, new Set(), new Set(['say']))).toEqual({ file: 'F', replaceBuiltin: ['say'] });
  });
  it('can be sent when every built-in it replaces is confirmed and its workflow name is free', () => {
    const s = env([mod('say', { replaces: 'builtin' }), mod('a')]);
    expect(envelopeReady(s, new Set())).toBe(false);
    expect(envelopeReady(s, new Set(['say']))).toBe(true);
    expect(envelopeReady(env([mod('a')], { name: 'w', exists: true, diagnostics: [] }), new Set())).toBe(false);
    expect(envelopeReady(env([mod('a')], { name: 'w', exists: false, diagnostics: [] }), new Set())).toBe(true);
  });
  it('tells an envelope preview from a single one', () => {
    expect(isEnvelope(env([]))).toBe(true);
    expect(isEnvelope(mod('a'))).toBe(false);
  });
});

describe('the share buttons', () => {
  it('the workflow name is the file name without .reins.md', () => {
    expect(shareName('C:\\a\\.reins\\workflows\\review.reins.md')).toBe('review');
    expect(shareName('/home/u/.reins/workflows/x-1.reins.md')).toBe('x-1');
  });
  it('Share is off while there are unsaved changes, and says why', () => {
    const off = renderToStaticMarkup(createElement(ShareButton, { name: 'w', text: 't', disabled: true }));
    const on = renderToStaticMarkup(createElement(ShareButton, { name: 'w', text: 't' }));
    expect(off).toMatch(/disabled/);
    expect(off).toMatch(/Save first/);
    expect(on).not.toMatch(/disabled/);
  });
  it('Export my mods is off when there is nothing to export', () => {
    expect(renderToStaticMarkup(createElement(ExportMine, { ids: [] }))).toMatch(/disabled/);
    expect(renderToStaticMarkup(createElement(ExportMine, { ids: ['a'] }))).not.toMatch(/disabled/);
  });
});
