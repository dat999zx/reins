import type { KindView } from './nodes/fields.js';
import use from './nodes/use.view.js';

/** The faces of the built-in kinds, plain JSON, in no particular order (each has an `order`). The server serves them with the mods' views. */
export const BUILTIN_VIEWS: readonly KindView[] = [use];
