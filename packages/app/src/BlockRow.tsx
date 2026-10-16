import { Md } from './Md.js';

// A feed row a block's view brings: a summary line, and a collapsible Md body when there are details.
export function BlockRow({ text, details, className }: { text: string; details?: string; className?: string }) {
  const cls = className ? `row ${className}` : 'row';
  return details === undefined ? <div className={cls}>{text}</div>
    : <details className={cls}><summary>{text}</summary><Md text={details} /></details>;
}
