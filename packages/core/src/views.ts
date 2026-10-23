import type { KindView } from './nodes/fields.js';
import gate from './nodes/gate.view.js';
import ifView from './nodes/if.view.js';
import model from './nodes/model.view.js';
import recall from './nodes/recall.view.js';
import repeat from './nodes/repeat.view.js';
import run from './nodes/run.view.js';
import store from './nodes/store.view.js';
import subagent from './nodes/subagent.view.js';
import use from './nodes/use.view.js';
import verify from './nodes/verify.view.js';

/** The faces of the built-in kinds, plain JSON, in no particular order (each has an `order`). The server serves them with the mods' views. */
export const BUILTIN_VIEWS: readonly KindView[] = [gate, ifView, model, recall, repeat, run, store, subagent, use, verify];
