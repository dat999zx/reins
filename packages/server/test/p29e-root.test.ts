// Milestone P, Task 29 phase E5: the Win32 spellings of a root (namespace prefixes, trailing dots and spaces) are refused as text, before any filesystem call.
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectFolderWords, rootFolderWords, TOO_WIDE_WORDS } from '../src/session.js';

afterEach(() => vi.restoreAllMocks());

const ROOTS = [
  '\\\\?\\C:\\', '\\\\?\\C:', '\\\\.\\C:\\', '//?/C:/', '\\\\?\\UNC\\server\\share\\', '\\\\?\\UNC\\server\\share', '\\\\?\\unc\\server\\share\\', '//?/UNC/server/share',
  '\\\\.\\UNC\\server\\share\\', 'C:\\ ', 'C:\\. ', 'C:\\..', 'C:\\...', 'C:\\ \\', '\\\\?\\C:\\ ', '\\\\?\\C:\\. ', '\\\\server\\share\\ ', '\\\\?\\UNC\\server\\share\\. ',
];
const FINE = ['\\\\?\\C:\\work\\proj', '\\\\.\\C:\\work', '\\\\?\\UNC\\server\\share\\proj', 'C:\\work\\proj. ', 'D:\\work\\proj'];

describe('E5: a root has many Win32 spellings and all are refused as text', () => {
  it('rootFolderWords refuses each, accepts a folder under a root, and never touches the filesystem', () => {
    const calls = [vi.spyOn(fs, 'statSync'), vi.spyOn(fs, 'realpathSync'), vi.spyOn(fs, 'existsSync'), vi.spyOn(fs, 'lstatSync')];
    for (const root of ROOTS) expect(rootFolderWords(root), root).toBe(TOO_WIDE_WORDS);
    for (const ok of FINE) expect(rootFolderWords(ok), ok).toBeUndefined();
    for (const c of calls) expect(c).not.toHaveBeenCalled();
  });

  it('projectFolderWords refuses each before it asks the filesystem for anything', () => {
    const calls = [vi.spyOn(fs, 'statSync'), vi.spyOn(fs, 'realpathSync'), vi.spyOn(fs, 'existsSync'), vi.spyOn(fs, 'lstatSync')];
    for (const root of ROOTS) expect(projectFolderWords(root, 'D:\\home\\.reins', 'D:\\home'), root).toBe(TOO_WIDE_WORDS);
    for (const c of calls) expect(c).not.toHaveBeenCalled();
  });
});
