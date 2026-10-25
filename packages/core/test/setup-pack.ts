// The core project's setup (vitest.config.ts): the default pack is registered before every core test file, the way the server's loader registers it.
// The server project has no such setup: its tests call `startMods`, which would throw "already registered" after a global registration.
import { PACK_DIR, registerPack } from './pack.js';

await registerPack(PACK_DIR);
// Tests read this to prove which project ran the setup (core: yes; server and app: no).
(globalThis as unknown as { __packSetup?: string }).__packSetup = PACK_DIR;
