import type { KindView } from './nodes/fields.js';

/** The faces of the kinds core itself holds, plain JSON (each has an `order`). The server serves them with the mods' views. Every block is a mod of the default pack now, so none is left. */
export const BUILTIN_VIEWS: readonly KindView[] = [];
