// Build step after tsc: copies every src/mods/**/mod.json into dist/mods, then fails when the two counts differ.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const from = path.join(root, 'src', 'mods');
const to = path.join(root, 'dist', 'mods');

const manifests = (dir) =>
  !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { recursive: true }).filter((f) => path.basename(f) === 'mod.json').map(String).sort();

const src = manifests(from);
for (const f of src) {
  fs.mkdirSync(path.dirname(path.join(to, f)), { recursive: true });
  fs.copyFileSync(path.join(from, f), path.join(to, f));
}
const built = manifests(to);
if (built.length !== src.length) {
  console.error(`copy-mods: src/mods has ${src.length} mod.json files but dist/mods has ${built.length}. A mod is missing from the build.`);
  process.exit(1);
}
console.log(`copy-mods: ${src.length} mods copied to dist/mods`);
