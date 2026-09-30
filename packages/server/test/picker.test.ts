import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePickerOutput, pickerExit, pickFolder } from '../src/picker.js';

describe('parsePickerOutput', () => {
  it("'' and a bare BOM plus newline are null, never the server's own folder", () => {
    expect(parsePickerOutput('')).toBeNull();
    expect(parsePickerOutput('\uFEFF\r\n')).toBeNull();
    expect(parsePickerOutput('  \n')).toBeNull();
  });

  it('a path is trimmed, BOM-stripped and resolved (a trailing slash goes)', () => {
    const p = path.resolve('some', 'folder');
    expect(parsePickerOutput(`\uFEFF${p}\r\n`)).toBe(p);
    expect(parsePickerOutput(`${p}${path.sep}\n`)).toBe(p);
  });
});

describe('pickerExit', () => {
  it('0 is a path on every platform', () => {
    for (const p of ['win32', 'darwin', 'linux'] as const) expect(pickerExit(p, 0, null, '')).toBe('path');
  });

  it('1 is a cancel on win32 and linux, whatever stderr says', () => {
    expect(pickerExit('win32', 1, null, '')).toBe('cancel');
    expect(pickerExit('linux', 1, null, '')).toBe('cancel');
    expect(pickerExit('linux', 1, null, 'Gtk-WARNING: cannot open display')).toBe('cancel');
  });

  it('darwin exit 1 is a cancel only with (-128) on stderr; anything else rejects', () => {
    expect(pickerExit('darwin', 1, null, 'execution error: User canceled. (-128)')).toBe('cancel');
    expect(pickerExit('darwin', 1, null, 'execution error: Application isn’t running. (-1713)')).toBe('reject');
    expect(pickerExit('darwin', 1, null, '')).toBe('reject');
  });

  it('any other code, or a signal, rejects', () => {
    for (const p of ['win32', 'darwin', 'linux'] as const) {
      expect(pickerExit(p, 2, null, '')).toBe('reject');
      expect(pickerExit(p, 127, null, '')).toBe('reject');
      expect(pickerExit(p, null, 'SIGKILL', '')).toBe('reject');
      expect(pickerExit(p, 0, 'SIGTERM', '')).toBe('reject');
    }
  });
});

describe('pickFolder without spawning', () => {
  const signal = new AbortController().signal;
  it('rejects on linux with no display, and on a platform with no picker', async () => {
    await expect(pickFolder(signal, { platform: 'linux', env: {} })).rejects.toThrow(/display/i);
    await expect(pickFolder(signal, { platform: 'freebsd', env: {} })).rejects.toThrow(/no folder picker/i);
  });
});
