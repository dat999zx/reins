// The default pack for SERVER tests (M3 Task 3). Since the move of the built-in kinds out of core, a kind exists only while the pack is loaded.
// A server test that parses, validates or runs workflows without starting the loader itself (`startMods`, or `boot`/`startServer`, which start it) calls
// `usePack()` once at the top of the file, the way core's tests get the pack from `setup-pack.ts` and the app's from `setup-kinds.ts`:
//
//   usePack();                       // beforeAll / afterAll for the whole file
//   const off = await loadPack();    // or by hand, when a test needs the pack only for a moment (call `off()` after)
//
// It is the product's own start (`startMods` over the real bundled folder, in a temp home), so the kinds are registered with their manifest `order`, guarded as
// a mod's block is, and gone again after `off()`. A test that starts the loader itself must NOT also call this: the second registration throws "already registered".
import { afterAll, beforeAll } from 'vitest';
import { startMods } from '../src/engines.js';
import type { Mods } from '../src/mods/types.js';
import { tempHome } from './mods-harness.js';

/** Loads the bundled mods (the default pack among them). Returns the loaded set; `dispose()` takes the kinds out again and the temp home with it. */
export async function loadPack(): Promise<Mods & { off(): void }> {
  const h = tempHome();
  const mods = await startMods({ dir: h.home, env: {} });
  const problems = mods.problems.concat(mods.mods.flatMap((m) => m.problems));
  if (problems.length) {
    mods.dispose();
    h.cleanup();
    throw new Error(`The default pack did not load: ${problems.join(' ')}`);
  }
  return Object.assign(mods, {
    off() {
      mods.dispose();
      h.cleanup();
    },
  });
}

/** `loadPack()` before the tests of the file and `off()` after them. */
export function usePack(): void {
  let loaded: (Mods & { off(): void }) | undefined;
  beforeAll(async () => { loaded = await loadPack(); });
  afterAll(() => { loaded?.off(); loaded = undefined; });
}
