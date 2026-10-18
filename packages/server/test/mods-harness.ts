// A temp Reins home with a mods folder, for tests that load or run mods.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempHome() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-home-')));
  const modsDir = path.join(home, 'mods');
  fs.mkdirSync(modsDir);
  return {
    home,
    modsDir,
    /** Writes `<modsDir>/<id>/mod.json` and any extra files (relative path to content). Returns the mod folder. */
    writeMod(id: string, manifest: unknown, files: Record<string, string> = {}) {
      const dir = path.join(modsDir, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify(manifest, null, 2));
      for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), content);
      }
      return dir;
    },
    /** Spec 7.8 does not fix the consent file. Placeholder: `<home>/consent.json` = `{ "<modId>": ["<origin>"] }`. Task 21 owns the real format and changes this. */
    grantConsent(id: string, origin: string) {
      const file = path.join(home, 'consent.json');
      const all: Record<string, string[]> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      all[id] = [...new Set([...(all[id] ?? []), origin])];
      fs.writeFileSync(file, JSON.stringify(all, null, 2));
    },
    cleanup() {
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
