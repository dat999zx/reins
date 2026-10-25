export * from './registry.js';
export * from './model.js';
export * from './cond.js';
export * from './format/parse.js';
export * from './format/print.js';
export * from './validate.js';
export * from './rename.js';
export * from './compile.js';
export * from './policy.js';
export * from './fake-engine.js';
export * from './run.js';
export * from './drift.js';
export * from './receipt.js';
export * from './cards/index.js';
export * from './conds/index.js';
export * from './display.js';
export * from './nodes/index.js';
export * from './data-block.js';
export * from './views.js';
export * from './viewShape.js';
export type { Field, KindView, Token } from './nodes/fields.js';
export { FAULT_OP, faultLine, modOfOp, tame, textOf } from './guard.js';

/**
 * Where a block of the default pack adds its own instruction shapes and event names:
 * `declare module '@reins/core' { interface ModInstrs { BEEP: { step: string } } interface ModEvents { beeped: unknown } }`.
 * They are declared here, in the module a mod augments, so the merge reaches `Instr` and `RunEventType`; a merge into `Instrs` or `RunEvents`
 * (re-exported by `export *`) is a copy that core's own types never see.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ModInstrs {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ModEvents {}
