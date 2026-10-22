import type { KindView } from './nodes/fields.js';
import end from './nodes/end.view.js';
import gate from './nodes/gate.view.js';
import ifView from './nodes/if.view.js';
import model from './nodes/model.view.js';
import phase from './nodes/phase.view.js';
import recall from './nodes/recall.view.js';
import repeat from './nodes/repeat.view.js';
import run from './nodes/run.view.js';
import say from './nodes/say.view.js';
import store from './nodes/store.view.js';
import subagent from './nodes/subagent.view.js';
import use from './nodes/use.view.js';
import verify from './nodes/verify.view.js';

/** The faces of the built-in kinds, plain JSON, in no particular order (each has an `order`). The server serves them with the mods' views. */
export const BUILTIN_VIEWS: readonly KindView[] = [end, gate, ifView, model, phase, recall, repeat, run, say, store, subagent, use, verify];
