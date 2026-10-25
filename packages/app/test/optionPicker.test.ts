import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { pickFor } from '../src/BlockPanel.js';
import { OptionPicker } from '../src/OptionPicker.js';

const options = [{ id: 'm1', label: 'Model One' }, { id: 'm2', label: 'Model Two' }];
const html = (p: Partial<Parameters<typeof OptionPicker>[0]>) =>
  renderToStaticMarkup(createElement(OptionPicker, { options, value: '', onChange: () => {}, label: 'Model', ...p }));

describe('OptionPicker', () => {
  it('an empty value with a blank shows that text as its one empty option, then the options', () => {
    expect(html({ blank: 'Model One' })).toBe(
      '<select aria-label="Model"><option value="" selected="">Model One</option><option value="m1">Model One</option><option value="m2">Model Two</option></select>');
  });
  it('an empty value with no blank asks to pick, and that option cannot be chosen', () => {
    expect(html({})).toContain('<option value="" disabled="" selected="">Pick a model</option>');
  });
  it('a chosen model has no empty option unless a blank is given', () => {
    expect(html({ value: 'm2' })).not.toContain('value=""');
    expect(html({ value: 'm2', blank: 'Model One' })).toContain('<option value="">Model One</option>');
  });
  it('a model the catalog lacks stays selectable', () => {
    expect(html({ value: 'typed' })).toContain('<option value="typed" selected="">typed</option>');
  });
  it('passes its class, title and disabled to the select, and the chosen value to onChange', () => {
    const got: string[] = [];
    const el = OptionPicker({ options, value: 'm1', onChange: (v) => got.push(v), label: 'Model', className: 'sx-pill', title: 'why', disabled: true });
    expect(el.props).toMatchObject({ className: 'sx-pill', title: 'why', disabled: true, 'aria-label': 'Model', value: 'm1' });
    el.props.onChange({ target: { value: 'm2' } });
    expect(got).toEqual(['m2']);
  });
});

describe('OptionPicker groups and the typed id', () => {
  const two = [
    { id: 'a:m1', label: 'M1', group: 'Alpha' }, { id: 'a:m2', label: 'M2', group: 'Alpha' }, { id: 'b:x', label: 'X', group: 'Beta' },
  ];
  const three = [...two, { id: 'c:y', label: 'Y', group: 'Gamma' }];
  it('draws one optgroup per provider when the list spans providers, values provider:model', () => {
    const out = html({ options: three, value: 'a:m1' });
    expect(out.match(/<optgroup label="[^"]+">/g)).toEqual(['<optgroup label="Alpha">', '<optgroup label="Beta">', '<optgroup label="Gamma">']);
    expect(out).toContain('<optgroup label="Beta"><option value="b:x">X</option></optgroup>');
    expect(out).toContain('<option value="a:m1" selected="">M1</option>');
  });
  it('is a flat list for one provider, tagged or not', () => {
    expect(html({ options: two.slice(0, 2), value: 'a:m1' })).not.toContain('optgroup');
    expect(html({ value: 'm1' })).not.toContain('optgroup');
  });
  it('a current model the list lacks is added to the first group, selected', () => {
    expect(html({ options: two, value: 'a:typed' })).toContain('<optgroup label="Alpha"><option value="a:m1">M1</option><option value="a:m2">M2</option><option value="a:typed" selected="">a:typed</option></optgroup>');
  });
  it('the Blocks panel: a model field takes a typed id and a reasoning field does not; the list stays as given', () => {
    const f = (input: string) => ({ input, inherits: false }) as any;
    const list = [{ id: 'm1', label: 'M1' }];
    expect(pickFor(f('model'), { models: list, efforts: [] })).toMatchObject({ options: list, other: {} });
    expect(pickFor(f('effort'), { models: list, efforts: [] }).other).toBeUndefined();
  });
  it('"Other model..." is the last option, only when asked for', () => {
    expect(html({ options: two, value: 'a:m1', other: { own: 'a' } })).toMatch(/<option value="__other__">Other model\.\.\.<\/option><\/select>$/);
    expect(html({ options: two, value: 'a:m1' })).not.toContain('Other model');
    expect(html({ options, value: 'm1', other: {} })).toMatch(/<option value="m2">Model Two<\/option><option value="__other__">Other model\.\.\.<\/option><\/select>$/);
  });
});
