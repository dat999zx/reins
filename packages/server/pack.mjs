// npm pack hooks for the published `reins` package: one install carries the CLI, the core and the UI.
// prepack copies them in as real files (npm will not bundle a hoisted workspace symlink); postpack removes them.
import fs from 'node:fs';

const core = 'node_modules/@reins/core';
const docs = ['README.md', 'CHANGELOG.md'];
if (process.argv[2] === 'pre') {
  for (const f of docs) fs.copyFileSync(`../../${f}`, f);
  fs.cpSync('../app/dist', 'app', { recursive: true });
  fs.cpSync('../core/dist', `${core}/dist`, { recursive: true });
  fs.copyFileSync('../core/package.json', `${core}/package.json`);
  // a global install leaves bundled-dir siblings empty, so bundle the runtime deps too (both have no deps of their own)
  for (const d of ['picomatch', 'yaml']) fs.cpSync(`../../node_modules/${d}`, `node_modules/${d}`, { recursive: true });
} else {
  for (const f of docs) fs.rmSync(f, { force: true });
  fs.rmSync('app', { recursive: true, force: true });
  fs.rmSync('node_modules', { recursive: true, force: true });
}
