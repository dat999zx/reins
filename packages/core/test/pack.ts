// The default pack for the core tests (M3 Task 1). The pack mods live under packages/server/src/mods/<id>/ (a mod.json that says "pack": "default");
// core tests do not start the server's loader, so each pack mod's code is activated here through a test api, with the SAME `order` the loader reads
// from its manifest (the order of the kinds in core's registry is observable). The server project has no such setup: it loads the pack through `startMods`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkMode, policyOf, register, registerCard, registerCondition, turnInstr } from '../src/index.js';

/** Where the pack mods are. */
export const PACK_DIR = fileURLToPath(new URL('../../server/src/mods/', import.meta.url));

interface PackManifest { id?: unknown; pack?: unknown; main?: unknown; order?: unknown }

/** The pack mods under `dir` as the loader would find them: a folder with a mod.json that says `"pack": "default"`, by folder name. */
export function packMods(dir: string): Array<{ id: string; dir: string; manifest: PackManifest }> {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((d) => {
      const file = path.join(dir, d.name, 'mod.json');
      if (!fs.existsSync(file)) return [];
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as PackManifest;
      return manifest.pack === 'default' ? [{ id: d.name, dir: path.join(dir, d.name), manifest }] : [];
    });
}

/**
 * What would keep a pack mod from running as a Customize copy, which runs from `<home>/mod-cache` with only its own files: a subfolder (an import file is
 * one folder with no folders in it), and any import that leaves the folder (a value import of `@reins/core`, `../x`, a package). Type imports are erased
 * when the mod is compiled, so they are allowed (the `declare module '@reins/core'` merges need them); `node:` modules and `./file` are allowed.
 * ponytail: a regex over the source, not a parser; it reads the import forms a mod is written with.
 */
export function packProblems(dir: string): string[] {
  const bad: string[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory()) bad.push(`${d.name}: a folder inside a pack mod (Customize copies one folder of files)`);
    if (!d.isFile() || !/\.(ts|js|mjs)$/.test(d.name)) continue;
    const src = fs.readFileSync(path.join(dir, d.name), 'utf8').replace(/\b(?:import|export)\s+type\b[\s\S]*?\bfrom\s*['"][^'"]+['"]/g, '');
    for (const m of src.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4]!;
      if (!(spec.startsWith('node:') || (spec.startsWith('./') && !path.posix.normalize(spec).startsWith('..')))) bad.push(`${d.name}: imports ${spec}, which is outside the mod folder`);
    }
  }
  return bad;
}

/** `main` as written (`index.js`); a source folder holds `index.ts` beside the same name. */
function codeOf(dir: string, main: string): string {
  const found = [main, main.replace(/\.js$/, '.ts')].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!found) throw new Error(`pack mod ${dir}: ${main} is not there`);
  return found;
}

/**
 * Activates every pack mod under `dir` through a test api: `registerBlock`, `registerCondition` and `registerCard` pass the manifest's `order`, and
 * `core` is the curated three. Returns one function that takes them all out again, newest first.
 */
export async function registerPack(dir: string): Promise<() => void> {
  const undo: Array<() => void> = [];
  try {
    for (const mod of packMods(dir)) {
      const { main, order } = mod.manifest;
      if (typeof main !== 'string' || typeof order !== 'number') throw new Error(`pack mod ${mod.id}: needs "main" and a numeric "order"`);
      const api = {
        env: process.env,
        registerBlock: (n: Parameters<typeof register>[0]) => { const d = register(n, order); undo.push(d); return d; },
        registerCondition: (c: Parameters<typeof registerCondition>[0]) => { const d = registerCondition(c, order); undo.push(d); return d; },
        registerCard: (c: Parameters<typeof registerCard>[0]) => { const d = registerCard(c, order); undo.push(d); return d; },
        core: Object.freeze({ checkMode, policyOf, turnInstr }),
      };
      const m = (await import(/* @vite-ignore */ pathToFileURL(codeOf(mod.dir, main)).href)) as { default?: (a: typeof api) => unknown };
      if (typeof m.default !== 'function') throw new Error(`pack mod ${mod.id}: does not default-export a function`);
      await m.default(api);
    }
  } catch (e) {
    for (const d of undo.splice(0).reverse()) d();
    throw e;
  }
  return () => { for (const d of undo.splice(0).reverse()) d(); };
}
