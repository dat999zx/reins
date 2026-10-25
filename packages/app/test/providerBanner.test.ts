import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProviderBanner, type Engines } from '../src/ProviderBanner.js';

const caps = { midTurnSteer: 'none', preToolDeny: false, resume: false } as const;
const engines: Engines = [
  { id: 'first', installed: false, loggedIn: false, capabilities: caps, problems: ['first is broken'] },
  { id: 'second', installed: true, loggedIn: true, capabilities: caps, problems: [] },
  { id: 'third', installed: true, loggedIn: false, capabilities: caps, problems: ['third needs a login'] },
];
const html = (engine: string | undefined) => renderToStaticMarkup(createElement(ProviderBanner, { engines, engine }));

describe('the provider banner', () => {
  it('shows the problems of the selected session\'s provider, not of the first one', () => {
    expect(html('third')).toContain('third needs a login');
    expect(html('third')).not.toContain('first is broken');
  });
  it('is empty for a healthy provider even when another one has a problem', () => {
    expect(html('second')).toBe('');
  });
  it('is empty with no session selected, or one whose provider was not probed', () => {
    expect(html(undefined)).toBe('');
    expect(html('unknown')).toBe('');
  });
  it('says so when a broken provider has no words of its own', () => {
    const bare: Engines = [{ id: 'a', installed: false, loggedIn: false, capabilities: caps, problems: [] }];
    expect(renderToStaticMarkup(createElement(ProviderBanner, { engines: bare, engine: 'a' }))).toContain('The engine is not ready.');
  });
});
