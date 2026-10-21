// Milestone P, Task 29 phase A, A10: a filesystem root is refused as a session folder whatever drive the two homes are on.
import { describe, expect, it } from 'vitest';
import { projectFolderWords, TOO_WIDE_WORDS } from '../src/session.js';

describe('A10: a filesystem root is too wide, on any drive', () => {
  it('another drive, a share root and a root with a forward slash are all refused; a project folder is not', () => {
    for (const root of ['X:\\', 'Z:/', '\\\\server\\share', '\\\\server\\share\\']) {
      expect(projectFolderWords(root, 'D:\\home\\.reins', 'D:\\home')).toBe(TOO_WIDE_WORDS);
    }
    expect(projectFolderWords('D:\\work\\proj', 'D:\\home\\.reins', 'D:\\home')).toBeUndefined();
  });
});
