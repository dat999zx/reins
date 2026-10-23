// The default pack for APP tests (M3 Task 3). `setup-kinds.ts` runs this once per test file: the pack is loaded the way the server loads it (`startMods` over the
// bundled folder, in a temp home), so the kinds are in core's registry AND the app can be filled from the same builder `GET /api/kinds` uses.
// A test that needs "the list the setup file made" (to put it back after it changed it) calls `served()`; `servedKinds()` with no argument is only core's own views.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMods } from '../../server/src/engines.js';
import { servedKinds } from '../../server/src/mods/kinds-view.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-appkinds-'));
export const mods = await startMods({ dir: home, env: {} });
fs.rmSync(home, { recursive: true, force: true });
const problems = [...mods.problems, ...mods.mods.flatMap((m) => m.problems)];
if (problems.length) throw new Error(`The default pack did not load: ${problems.join(' ')}`);

/** The reply of `GET /api/kinds` for the loaded bundled mods (the default pack among them). */
export const served = () => servedKinds(mods);
