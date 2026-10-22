// M2 Task 20: the import dialog and the Settings list say what a block, condition or card mod adds, from the server's words, as text.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ImportPanel, SummaryList, linesOf, type KindSummary } from '../src/ImportSummary.js';
import { KindDetails, Row, type KindRow } from '../src/Providers.js';

const CODE = 'This mod runs its own code inside Reins.';
const beep: KindSummary = {
  id: 'toy-beep', label: 'Toy beep', kind: 'block', protocol: null, replaces: null, keys: [], headers: [], hasCode: true, codePrompt: CODE,
  files: [{ name: 'index.js', bytes: 10 }, { name: 'mod.json', bytes: 20 }], warnings: [],
  adds: ['adds the block `beep`', 'its operations: BEEP', 'may log the events: beeped'],
};
const html = (s: KindSummary) => renderToStaticMarkup(createElement(SummaryList, { summary: s }));
const row = (o: Partial<KindRow> = {}): KindRow => ({ id: 'toy-beep', kind: 'block', label: 'Toy beep', enabled: true, bundled: false, source: 'custom', problems: [], ...o });
const details = (r: KindRow) => renderToStaticMarkup(createElement(KindDetails, { row: r }));

describe('the import summary lists what a kind mod adds', () => {
  it('puts the adds lines after the kind and before the files and the code line, in the server\'s order', () => {
    const lines = linesOf(beep);
    expect(lines.slice(0, 6)).toEqual(['Id: toy-beep', 'Label: Toy beep', 'Kind: block', 'adds the block `beep`', 'its operations: BEEP', 'may log the events: beeped']);
    expect(lines.slice(6)).toEqual(['Files: index.js (10 bytes), mod.json (20 bytes)', 'Has code: it runs inside Reins.']);
  });

  it('an older reply with no adds reads as before', () => {
    const { adds: _adds, ...old } = beep;
    expect(linesOf(old)).toEqual(['Id: toy-beep', 'Label: Toy beep', 'Kind: block', 'Files: index.js (10 bytes), mod.json (20 bytes)', 'Has code: it runs inside Reins.']);
  });

  it('shows each line as text in the list; markup in a line is escaped, never drawn', () => {
    const out = html({ ...beep, adds: ['adds the block `<img src=x onerror=alert(1)>`'], warnings: ['<b>bold</b>'] });
    expect(out).toContain('adds the block `&lt;img src=x onerror=alert(1)&gt;`');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<b>');
    expect(html(beep)).toContain('<li>adds the block `beep`</li>');
  });

  it('the dialog draws the adds lines, the code prompt and the trust choice of a block', () => {
    const out = renderToStaticMarkup(createElement(ImportPanel, { onDone: () => {}, onCancel: () => {}, shown: beep }));
    for (const s of ['<li>adds the block `beep`</li>', '<li>its operations: BEEP</li>', CODE, 'Trust and import', 'Import without running its code']) expect(out).toContain(s);
  });

  it('a warning about an existing kind is shown with the rest', () => {
    const w = 'the block `say` already exists in Reins, so the code of this mod would be refused.';
    expect(linesOf({ ...beep, warnings: [w] })).toContain(w);
  });
});

describe('a kind mod in the Settings list', () => {
  it('shows what it adds and a notice that it applies after a restart', () => {
    const out = details(row({ adds: ['adds the block `beep`'], notices: ['`toy-beep`: applies after a restart.'] }));
    expect(out).toContain('adds the block `beep`');
    expect(out).toContain('`toy-beep`: applies after a restart.');
  });

  it('a notice alone is shown, and a list of adds alone', () => {
    expect(details(row({ notices: ['`toy-beep`: applies after a restart.'] }))).toContain('applies after a restart.');
    expect(details(row({ notices: ['`toy-beep`: applies after a restart.'] }))).not.toContain('<ul');
    expect(details(row({ adds: ['adds the block `beep`'] }))).toContain('<li>adds the block `beep`</li>');
  });

  it('shows nothing for a provider or a mod with nothing to say', () => {
    expect(details(row())).toBe('');
  });

  it('a row shows the label, the id, the kind, the trust state, what it adds and the restart notice', () => {
    const draw = (r: KindRow) => renderToStaticMarkup(createElement(Row, { row: r, used: [], reload: async () => {}, edit: () => {} }));
    const waiting = draw(row({ trust: 'needs-trust', hash: 'h', codePrompt: CODE, adds: ['adds the block `beep`'] }));
    for (const s of ['Toy beep', 'toy-beep', 'block · user', 'needs trust', 'adds the block `beep`', '>Trust<']) expect(waiting).toContain(s);
    expect(waiting).not.toContain('applies after a restart');
    const carried = draw(row({ trust: 'trusted', adds: ['adds the block `beep`'], notices: ['`toy-beep`: applies after a restart.'] }));
    for (const s of ['ready', 'applies after a restart.', 'adds the block `beep`']) expect(carried).toContain(s);
    expect(carried).not.toContain('invalid');
    expect(draw(row({ trust: 'restart', problems: ['`toy-beep`: restart to run the new code.'] }))).toContain('restart to run the new code');
    expect(draw(row({ enabled: false, notices: ['`toy-beep`: applies after a restart.'] }))).toContain('disabled');
  });

  it('draws the words as text', () => {
    const out = details(row({ adds: ['<script>x</script>'], notices: ['<i>n</i>'] }));
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<i>');
    expect(out).toContain('&lt;script&gt;');
  });
});
