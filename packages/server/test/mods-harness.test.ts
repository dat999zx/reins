import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempHome } from './mods-harness.js';

describe('tempHome', () => {
  it('makes a home and an empty mods folder under the temp dir, and cleanup removes it', () => {
    const h = tempHome();
    expect(path.dirname(h.home)).toBe(fs.realpathSync(os.tmpdir()));
    expect(fs.readdirSync(h.modsDir)).toEqual([]);
    h.cleanup();
    expect(fs.existsSync(h.home)).toBe(false);
  });

  it('writeMod writes mod.json and extra files, nested ones too', () => {
    const h = tempHome();
    try {
      const dir = h.writeMod('acme', { version: 1, id: 'acme' }, { 'index.js': 'export {};', 'lib/a.js': '1' });
      expect(dir).toBe(path.join(h.modsDir, 'acme'));
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'mod.json'), 'utf8'))).toEqual({ version: 1, id: 'acme' });
      expect(fs.readFileSync(path.join(dir, 'index.js'), 'utf8')).toBe('export {};');
      expect(fs.readFileSync(path.join(dir, 'lib', 'a.js'), 'utf8')).toBe('1');
    } finally {
      h.cleanup();
    }
  });

  it('grantConsent writes consent.json and keeps earlier grants without duplicates', () => {
    const h = tempHome();
    try {
      h.grantConsent('a', 'https://one.test');
      h.grantConsent('a', 'https://two.test');
      h.grantConsent('a', 'https://one.test');
      h.grantConsent('b', 'http://127.0.0.1:1');
      expect(JSON.parse(fs.readFileSync(path.join(h.home, 'consent.json'), 'utf8'))).toEqual({ a: ['https://one.test', 'https://two.test'], b: ['http://127.0.0.1:1'] });
    } finally {
      h.cleanup();
    }
  });

  it('two homes never share a folder', () => {
    const a = tempHome();
    const b = tempHome();
    try {
      expect(a.home).not.toBe(b.home);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});
