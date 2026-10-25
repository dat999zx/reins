import { Md } from './Md.js';

/** The classes a view's row may carry. The server refuses any other at import (mods/kinds.ts ROW_CLASSES); a test pins the two lists equal. */
export const ROW_CLASSES: readonly string[] = ['sx-sub', 'faint'];

// A feed row a block's view brings: a summary line, and a collapsible Md body when there are details.
export function BlockRow({ text, details, className }: { text: string; details?: string; className?: string }) {
  const cls = className !== undefined && ROW_CLASSES.includes(className) ? `row ${className}` : 'row';
  return details === undefined ? <div className={cls}>{text}</div>
    : <details className={cls}><summary>{text}</summary><Md text={details} /></details>;
}
