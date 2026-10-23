// M3 Task 1 (the app half): the first-run pack line cannot switch a required mod off; a Settings row of a required mod has no Disable button; a built-in pack
// mod offers Customize; a copy that has fallen behind the built-in says so. Rendered with react-dom/server (no browser), the rows are the server's JSON.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FirstRun } from '../src/FirstRun.js';
import { ImportPanel } from '../src/ImportSummary.js';
import { PACK_LINE, packRows, type ChooserEntry, type PackRow } from '../src/firstRunCards.js';
import { Row, type KindRow } from '../src/Providers.js';
import { otherMeta, rowInfo } from '../src/providersStatus.js';

const card: ChooserEntry = { id: 'alpha', label: 'Alpha', description: 'The alpha provider', protocol: 'openai-chat', host: 'api.alpha.test', keyEnv: ['ALPHA_KEY'], untested: false, local: false };
const pack: PackRow[] = [
  { id: 'say', label: 'Say', enabled: true, required: false },
  { id: 'end', label: 'End', enabled: true, required: true },
  { id: 'gate', label: 'Gate', enabled: false, required: false },
];
const row = (over: Partial<KindRow> = {}): KindRow => ({ id: 'say', kind: 'block', label: 'Say', enabled: true, bundled: true, source: 'bundled', pack: 'default', problems: [], ...over });
const render = (r: KindRow) => renderToStaticMarkup(createElement(Row, { row: r, used: [], reload: async () => {}, edit: () => {}, customize: () => {} }));
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

describe('the first-run pack line', () => {
  it('rows: a required mod is shown on and locked, whatever the server said', () => {
    expect(packRows(pack).map((p) => [p.id, p.enabled, p.locked])).toEqual([['say', true, false], ['end', true, true], ['gate', false, false]]);
    expect(packRows([{ id: 'end', label: 'End', enabled: false, required: true }])).toEqual([{ id: 'end', label: 'End', enabled: true, required: true, locked: true }]);
    expect(packRows([])).toEqual([]);
  });

  it('shows the line and a switch per mod; the switch of a required mod is disabled', () => {
    const html = renderToStaticMarkup(createElement(FirstRun, { cards: [card], pack, onLeave: () => {} }));
    expect(html).toContain('aria-label="Default pack"');
    expect(html).toContain(PACK_LINE);
    const boxes = [...html.matchAll(/<li class="prow" data-id="([^"]+)"><label class="phead"><input type="checkbox"([^>]*)\/>/g)].map((m) => [m[1], m[2]!]);
    expect(boxes.map((b) => b[0])).toEqual(['say', 'end', 'gate']);
    const by = Object.fromEntries(boxes.map(([id, attrs]) => [id, attrs]));
    expect(by.say).toContain('checked=""');
    expect(by.say).not.toContain('disabled');
    expect(by.end).toContain('checked=""');
    expect(by.end).toContain('disabled=""');
    expect(by.gate).not.toContain('checked');
    expect(html).toContain('<span class="badge">required</span>');
    expect(html.match(/class="badge">required/g)).toHaveLength(1);
  });

  it('shows no pack line when the pack is empty (today) or not sent', () => {
    for (const p of [[], undefined]) {
      const html = renderToStaticMarkup(createElement(FirstRun, { cards: [card], ...(p ? { pack: p } : {}), onLeave: () => {} }));
      expect(html).not.toContain('Default pack');
      expect(html).not.toContain(PACK_LINE);
      expect(html).toContain('Choose your providers');
    }
  });
});

describe('Customize in the import dialog', () => {
  it('opens on the copy of the built-in: the file text is already in the dialog, and nothing else changes', () => {
    const file = JSON.stringify({ reinsMod: 1, files: { 'mod.json': '{}' } });
    const html = renderToStaticMarkup(createElement(ImportPanel, { initial: file, onDone: () => {}, onCancel: () => {} }));
    expect(html).toContain('aria-label="Mod file text"');
    expect(html).toContain(file.replaceAll('"', '&quot;'));
    const plain = renderToStaticMarkup(createElement(ImportPanel, { onDone: () => {}, onCancel: () => {} }));
    expect(plain).not.toContain('reinsMod');
  });

  it('the app project has no pack setup of its own (that is core\'s)', () => {
    expect((globalThis as unknown as { __packSetup?: string }).__packSetup).toBeUndefined();
  });
});

describe('Settings rows of the default pack', () => {
  it('a required mod has no Disable button; an optional one has; both are in the pack', () => {
    expect(rowInfo(row({ required: true })).canDisable).toBe(false);
    expect(rowInfo(row()).canDisable).toBe(true);
    expect(buttons(render(row({ required: true })))).not.toContain('Disable');
    expect(buttons(render(row()))).toContain('Disable');
    expect(buttons(render(row({ enabled: false })))).toContain('Enable');
  });

  it('a built-in pack mod offers Customize; a user mod, a built-in outside the pack, and a copy do not', () => {
    expect(buttons(render(row()))).toContain('Customize');
    expect(buttons(render(row({ required: true })))).toContain('Customize');
    expect(buttons(render(row({ pack: undefined })))).not.toContain('Customize');
    expect(buttons(render(row({ bundled: false, source: 'custom', replaces: 'bundled' })))).not.toContain('Customize');
    expect(rowInfo(row()).canCustomize).toBe(true);
    expect(rowInfo(row({ bundled: false })).canCustomize).toBe(false);
    expect(rowInfo(row({ pack: undefined })).canCustomize).toBe(false);
  });

  it('a copy that has fallen behind says "the built-in is newer" (with the built-in\'s version); one that has not, does not', () => {
    const copy = row({ bundled: false, source: 'custom', replaces: 'bundled', builtinVersion: '1.10.0', newer: true });
    expect(rowInfo(copy).newer).toBe('the built-in is newer (1.10.0)');
    expect(otherMeta(copy, [])).toBe('block · user · default pack · replaces the built-in say · the built-in is newer (1.10.0)');
    expect(render(copy)).toContain('the built-in is newer (1.10.0)');
    const level = row({ bundled: false, source: 'custom', replaces: 'bundled', builtinVersion: '1.0.0' });
    expect(rowInfo(level).newer).toBeUndefined();
    expect(otherMeta(level, [])).not.toContain('newer');
  });

  it('the meta line names the pack and a required mod', () => {
    expect(otherMeta(row({ required: true }), [])).toBe('block · bundled · default pack · required');
    expect(otherMeta(row({ pack: undefined }), ['Dev'])).toBe('block · bundled · used by Dev');
  });
});
