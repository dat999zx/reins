import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelPicker } from '../src/ModelPicker.js';

const models = [{ id: 'm1', label: 'Model One' }, { id: 'm2', label: 'Model Two' }];
const html = (p: Partial<Parameters<typeof ModelPicker>[0]>) =>
  renderToStaticMarkup(createElement(ModelPicker, { models, value: '', onChange: () => {}, label: 'Model', ...p }));

describe('ModelPicker', () => {
  it('an empty value with a blank shows that text as its one empty option, then the models', () => {
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
    const el = ModelPicker({ models, value: 'm1', onChange: (v) => got.push(v), label: 'Model', className: 'sx-pill', title: 'why', disabled: true });
    expect(el.props).toMatchObject({ className: 'sx-pill', title: 'why', disabled: true, 'aria-label': 'Model', value: 'm1' });
    el.props.onChange({ target: { value: 'm2' } });
    expect(got).toEqual(['m2']);
  });
});
