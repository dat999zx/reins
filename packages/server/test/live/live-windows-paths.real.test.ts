// Row 9 of the live checks (Windows only, no key, both modes): paths the loop's file tools must not follow. A junction to the user home, the 8.3
// short name of the home folder, and \\localhost\c$ style paths. The tools are driven through the same entry points the unit tests use
// (confine, then the tool). No network is used; the count of TCP connections to port 445 must not grow.
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { HOME_WORDS, LEXICAL_WORDS, confine } from '../../src/loop/paths.js';
import { findTool } from '../../src/loop/tools.js';
import { LONG, liveSuite, record } from './live-harness.js';

const MODEL = 'none (no model is used)';

/** The connections whose remote port is 445, one line each (local, remote, state). */
function smb(): string[] {
  const text = execFileSync('netstat', ['-n', '-p', 'tcp'], { encoding: 'utf8' });
  return text.split(/\r?\n/).flatMap((l) => {
    const c = l.trim().split(/\s+/);
    return c[0] === 'TCP' && c[2]?.endsWith(':445') ? [`${c[1]} ${c[2]} ${c[3]}`] : [];
  });
}
const PLAIN = /^Blocked by Reins: /;
/** A file system that fails the test if confinement asks it anything. */
const injectedNone = () => ({ realpathSync: { native: () => { throw new Error('fs touched'); } }, lstatSync: () => { throw new Error('fs touched'); } });

liveSuite('row 9: Windows paths and links', { windows: true }, () => {
  let tmp = '';
  let proj = '';
  const userHome = os.homedir();
  const reinsHome = path.join(userHome, '.reins'); // only its name is used; nothing in it is read
  const notes: string[] = [];
  const counts: Record<string, string | number | boolean> = {};
  let before: string[] = [];

  beforeAll(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-row9-')));
    proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, 'ok.txt'), 'inside the project\n');
    before = smb();
  }, LONG);
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  }, LONG);

  /** The ways a path can go: refused, outside the project (the engine asks the user first), or inside. */
  const judge = (raw: string, home = reinsHome) => {
    const r = confine(raw, { cwd: proj, home });
    return r.ok ? (r.inside ? 'inside' : 'outside') : r.reason;
  };

  it('a plain path in the project is read (the checks below refuse for a reason)', async () => {
    const at = confine('ok.txt', { cwd: proj, home: reinsHome });
    expect(at.ok && at.inside).toBe(true);
    if (!at.ok) return;
    const out = await findTool('Read')!.run!({ file_path: 'ok.txt' }, { cwd: proj, home: reinsHome, policy: () => ({}) as never, signal: new AbortController().signal, redact: (t) => t, redactAll: (t) => t, platform: 'win32' }, { abs: at.abs, root: at.root });
    expect(out.text).toContain('inside the project');
  });

  it('a junction to the user home: the Reins folder behind it is refused, and nothing behind it counts as inside the project', () => {
    const link = path.join(proj, 'homelink');
    fs.symlinkSync(userHome, link, 'junction');
    counts.junction = 'created';
    expect(judge('homelink\\.reins\\secrets.json')).toBe(HOME_WORDS);
    expect(judge('homelink/.reins/secrets.json')).toBe(HOME_WORDS);
    expect(judge('homelink\\.reins')).toBe(HOME_WORDS);
    // A file elsewhere in the home is OUTSIDE the project: the engine asks the user before it reads (Reins's rule), it does not read on its own.
    const elsewhere = judge('homelink\\Desktop');
    counts.junctionElsewhere = elsewhere === 'outside' ? 'outside the project (the user is asked)' : elsewhere === 'inside' ? 'INSIDE' : 'refused';
    expect(elsewhere).not.toBe('inside');
    notes.push('a junction to the user home: a path to the Reins folder through it is refused with the Reins-folder words; any other path through it is outside the project, so the engine asks the user first (it is not refused outright)');
  });

  it('the 8.3 short name of the home folder is refused with a plain refusal and no file system call', () => {
    const asked = execSync('cmd /c for %I in ("%USERPROFILE%") do @echo %~sI', { encoding: 'utf8' }).trim();
    const long = path.resolve(userHome);
    const has83 = /~\d/.test(asked);
    counts.shortName = has83 ? 'exists on this machine' : '8.3 names are off for this folder';
    let expands: boolean | string = 'not tested (no short name)';
    if (has83) {
      const real = fs.realpathSync.native(asked);
      expands = real.toLowerCase() === long.toLowerCase();
    } else {
      // The home folder has a short name only when its own name is long. A folder of ours with a long name shows whether this volume makes 8.3 names.
      const folder = path.join(proj, 'a-folder-with-a-long-name');
      fs.mkdirSync(folder);
      const short = execSync(`cmd /c for %I in ("${folder}") do @echo %~sI`, { encoding: 'utf8' }).trim();
      counts.shortNameOfALongFolder = /~\d/.test(short) ? 'exists' : '8.3 names are off on this volume';
      if (/~\d/.test(short)) expands = fs.realpathSync.native(short).toLowerCase() === folder.toLowerCase();
      if (/~\d/.test(short)) expect(confine(short, { cwd: proj, home: reinsHome, fs: injectedNone() as never })).toEqual({ ok: false, reason: LEXICAL_WORDS(short) });
    }
    counts.realpathNativeExpands83 = String(expands);
    const injected = { realpathSync: { native: () => { throw new Error('fs touched'); } }, lstatSync: () => { throw new Error('fs touched'); } };
    // The real short form when there is one, and the usual form of the same home when there is not: the rule reads the text only.
    for (const raw of [...(has83 ? [`${asked}\\.reins\\x`, `${asked}\\Desktop`] : []), 'C:\\Users\\ADMIN~1\\Desktop', 'C:\\PROGRA~1\\x', 'homelink\\..\\ADMIN~1']) {
      const r = confine(raw, { cwd: proj, home: reinsHome, fs: injected as never });
      expect(r, raw).toEqual({ ok: false, reason: LEXICAL_WORDS(raw) });
      expect((r as { reason: string }).reason).toMatch(PLAIN);
    }
    notes.push(`fs.realpathSync.native expands an 8.3 name on this machine: ${String(expands)}`);
  });

  it('\\\\localhost\\c$ style paths are refused with a plain refusal and the file system is not asked', () => {
    const injected = { realpathSync: { native: () => { throw new Error('fs touched'); } }, lstatSync: () => { throw new Error('fs touched'); } };
    const forms = ['\\\\localhost\\c$\\Users', '//localhost/c$/Users', '\\\\127.0.0.1\\c$\\Users', '\\\\?\\UNC\\localhost\\c$\\Users', '\\\\.\\C:\\Users', '\\\\localhost\\c$\\Users\\' + path.basename(userHome)];
    for (const raw of forms) {
      const r = confine(raw, { cwd: proj, home: reinsHome, fs: injected as never });
      expect(r, raw).toEqual({ ok: false, reason: LEXICAL_WORDS(raw) });
      expect((r as { reason: string }).reason).toMatch(PLAIN);
    }
    counts.networkFormsRefused = forms.length;
    // The same through a junction whose target is such a path would be refused by the link walk; a junction to a network path cannot be made without one.
  });

  it('no new connection to port 445 was made by any of it', () => {
    const now = smb();
    const fresh = now.filter((c) => !before.includes(c));
    counts.smbBefore = before.length;
    counts.smbNow = now.length;
    counts.smbNew = fresh.length;
    expect(fresh).toEqual([]);
  });

  it('writes the evidence', () => {
    expect(Object.keys(counts).length).toBeGreaterThan(0);
    const after = smb();
    record({ row: '9', model: MODEL, pass: after.filter((c) => !before.includes(c)).length === 0, counts: { ...counts, smbAfter: after.length }, notes });
  });
});
