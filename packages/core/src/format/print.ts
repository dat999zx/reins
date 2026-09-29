import type { Workflow, Step } from '../model.js';
import { printCond } from '../cond.js';
import { NODES, defaultId, headingOwns } from '../nodes/index.js';

export function printWorkflow(w: Workflow): string {
  const parts: string[] = [];
  const owned = headingOwns();

  // 1. Frontmatter
  const isBlock = !!w.block;
  if (isBlock) {
    parts.push(`---\nreins: 1\nblock: ${w.block}\n---`);
  } else {
    const fm: string[] = ['---', 'reins: 1', `name: ${w.name}`];
    const quoteYaml = (s: string) => {
      if (s.includes(':') || s.includes('#') || s.startsWith('"') || s.startsWith("'")) {
        return JSON.stringify(s);
      }
      return s;
    };
    if (w.task) fm.push(`task: ${quoteYaml(w.task)}`);
    if (w.engine) fm.push(`engine: ${w.engine}`);
    if (w.model) fm.push(`model: ${w.model}`);
    if (w.test) fm.push(`test: ${w.test}`);

    const usdStr =
      w.budget.usd !== undefined
        ? `, usd: ${w.budget.usd.toFixed(2)}`
        : '';
    fm.push(`budget: { turns: ${w.budget.turns}, minutes: ${w.budget.minutes}${usdStr} }`);

    if (w.always.length === 0) {
      fm.push('always: []');
    } else {
      fm.push('always:');
      for (const item of w.always) {
        fm.push(`  - ${item}`);
      }
    }

    if (w.drift) {
      const dParts: string[] = [];
      if (w.drift.repeat !== undefined) dParts.push(`repeat: ${w.drift.repeat}`);
      if (w.drift.stagnation !== undefined) dParts.push(`stagnation: ${w.drift.stagnation}`);
      fm.push(`drift: { ${dParts.join(', ')} }`);
    }

    fm.push('---');
    parts.push(fm.join('\n'));
  }

  // 2. Steps
  const counters: Record<string, number> = {};

  function printStep(step: Step, depth: number): string {
    const hashes = '#'.repeat(depth);
    const h = NODES.get(step.kind)?.heading?.print(step);
    const headingText = h?.text ?? step.kind;

    const lines: string[] = [`${hashes} ${headingText}`];

    // Determine if custom id needs to be printed
    const defId = defaultId(step, counters);
    if (step.id && step.id !== defId) {
      lines.push(`id: ${step.id}`);
    }

    // Attributes in canonical order
    if (step.attrs.mode) lines.push(`mode: ${step.attrs.mode}`);

    // Cards (guards, notes, nudges, etc.)
    for (const card of step.cards) {
      lines.push(`${card.kind}: ${card.text}`);
    }

    if (!h?.condInHeading && step.cond) {
      lines.push(`until: ${printCond(step.cond)}`);
    }

    if (step.attrs.max) lines.push(`max: ${step.attrs.max}`);
    if (step.attrs.against) lines.push(`against: ${step.attrs.against}`);
    if (step.attrs.knowl) lines.push(`knowl: ${step.attrs.knowl}`);
    if (step.attrs.to) lines.push(`to: ${step.attrs.to}`);
    if (step.attrs.focus) lines.push(`focus: ${step.attrs.focus}`);

    // Extra attrs not handled
    for (const [k, v] of Object.entries(step.attrs)) {
      if (['id', 'mode', 'until', 'max', 'against', 'knowl', 'to', 'focus'].includes(k) || owned.has(k)) {
        continue;
      }
      lines.push(`${k}: ${v}`);
    }

    // Links
    for (const link of step.links) {
      const maxPart = link.max !== undefined ? ` (max ${link.max})` : '';
      lines.push(`${link.kind}: ${link.to}${maxPart}`);
    }

    // Prompt lines
    if (step.prompt !== undefined && step.prompt !== '') {
      const pLines = step.prompt.split('\n');
      for (const p of pLines) {
        lines.push(p === '' ? '>' : `> ${p}`);
      }
    }

    let result = lines.join('\n');

    // Children
    if (step.kids && step.kids.length > 0) {
      for (const kid of step.kids) {
        result += '\n\n' + printStep(kid, depth + 1);
      }
    }

    // Else branch
    if (step.else && step.else.length > 0) {
      result += '\n\n' + '#'.repeat(depth + 1) + ' else';
      for (const elseKid of step.else) {
        result += '\n\n' + printStep(elseKid, depth + 1);
      }
    }

    return result;
  }

  for (const step of w.steps) {
    parts.push(printStep(step, 2));
  }

  // 3. Auto cards
  for (const auto of w.autos) {
    parts.push(
      `## whenever ${printCond(auto.cond)}\n${auto.card.kind}: ${auto.card.text}`
    );
  }

  return parts.join('\n\n') + '\n';
}
