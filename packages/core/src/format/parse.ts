import YAML from 'yaml';
import type { Workflow, Step, StepKind, Card, Link, AutoCard, Diagnostic, CardKind, LinkKind } from '../model.js';
import { parseCond } from '../cond.js';
import { CARDS } from '../cards/index.js';
import { NODES, defaultId, nodeAttrs } from '../nodes/index.js';

export interface ParseWorkflowResult {
  workflow?: Workflow;
  diagnostics: Diagnostic[];
}

const KNOWN_LINK_KINDS: Set<LinkKind> = new Set([
  'next',
  'on-pass',
  'on-fail',
  'retry',
  'verify-against',
  'hand-off',
]);

const attrSet = () =>
  new Set<string>(['id', 'until', ...nodeAttrs(), ...CARDS.keys(), ...KNOWN_LINK_KINDS]);

export { slugify } from '../util.js';

interface RawLine {
  text: string;
  lineNum: number;
}

interface ParsedBlock {
  depth: number;
  kindStr: string;
  argStr: string;
  lineNum: number;
  lines: RawLine[];
}

export function parseWorkflow(input: string): ParseWorkflowResult {
  const knownAttrs = attrSet();
  const diagnostics: Diagnostic[] = [];
  const lines = input.replace(/\r\n/g, '\n').split('\n');

  // 1. Extract frontmatter
  let frontmatterEnd = -1;
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === '---') {
        frontmatterEnd = i;
        break;
      }
    }
  }

  if (frontmatterEnd === -1) {
    diagnostics.push({
      severity: 'error',
      message: 'Missing YAML frontmatter',
      pos: { line: 1, col: 1 },
    });
    return { diagnostics };
  }

  const fmText = lines.slice(1, frontmatterEnd).join('\n');
  let fm: any = {};
  try {
    fm = YAML.parse(fmText) || {};
  } catch (err: any) {
    diagnostics.push({
      severity: 'error',
      message: `Invalid YAML frontmatter: ${err.message}`,
      pos: { line: 2, col: 1 },
    });
    return { diagnostics };
  }

  const isBlock = typeof fm.block === 'string';
  const name = isBlock ? fm.block : String(fm.name || '');

  // 2. Scan headings and step blocks
  const blocks: ParsedBlock[] = [];
  let currentBlock: ParsedBlock | null = null;

  for (let i = frontmatterEnd + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    const headingMatch = raw.match(/^(#{2,6})\s+(.*)$/);
    if (headingMatch) {
      if (currentBlock) {
        blocks.push(currentBlock);
      }
      const hashes = headingMatch[1]!;
      const rest = headingMatch[2]!.trim();
      const firstSpace = rest.indexOf(' ');
      const kindStr = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
      const argStr = firstSpace === -1 ? '' : rest.slice(firstSpace + 1).trim();

      currentBlock = {
        depth: hashes.length,
        kindStr,
        argStr,
        lineNum: i + 1,
        lines: [],
      };
    } else if (currentBlock) {
      currentBlock.lines.push({ text: raw, lineNum: i + 1 });
    }
  }
  if (currentBlock) {
    blocks.push(currentBlock);
  }

  // Counters for default IDs
  const counters: Record<string, number> = {};

  const autos: AutoCard[] = [];

  function parseBlockLines(block: ParsedBlock): {
    id?: string;
    title?: string;
    promptLines: string[];
    attrs: Record<string, string>;
    cards: Card[];
    links: Link[];
  } {
    const promptLines: string[] = [];
    const attrs: Record<string, string> = {};
    const cards: Card[] = [];
    const links: Link[] = [];
    let customId: string | undefined;

    for (const { text, lineNum } of block.lines) {
      const trimmed = text.trim();
      if (!trimmed) continue;

      if (text.startsWith('>')) {
        const pLine = text.startsWith('> ') ? text.slice(2) : text.slice(1);
        promptLines.push(pLine);
        continue;
      }

      const colonIdx = text.indexOf(':');
      if (colonIdx !== -1) {
        const key = text.slice(0, colonIdx).trim();
        const val = text.slice(colonIdx + 1).trim();

        if (!knownAttrs.has(key)) {
          diagnostics.push({
            severity: 'error',
            message: `Unknown attribute "${key}"`,
            pos: { line: lineNum, col: text.indexOf(key) + 1 },
          });
          continue;
        }

        if (key === 'id') {
          customId = val;
        } else if (CARDS.has(key)) {
          cards.push({
            kind: key as CardKind,
            text: val,
            pos: { line: lineNum, col: colonIdx + 2 },
          });
        } else if (KNOWN_LINK_KINDS.has(key as LinkKind)) {
          const maxMatch = val.match(/^(.*?)\s*\(max\s+(\d+)\)$/);
          if (maxMatch) {
            links.push({
              kind: key as LinkKind,
              to: maxMatch[1]!.trim(),
              max: parseInt(maxMatch[2]!, 10),
              pos: { line: lineNum, col: colonIdx + 2 },
            });
          } else {
            links.push({
              kind: key as LinkKind,
              to: val,
              pos: { line: lineNum, col: colonIdx + 2 },
            });
          }
        } else {
          attrs[key] = val;
        }
      }
    }

    return { id: customId, promptLines, attrs, cards, links };
  }

  // Parse Step node
  function convertBlockToStep(block: ParsedBlock): Step {
    const kind = block.kindStr as StepKind;
    const { id: customId, promptLines, attrs, cards, links } = parseBlockLines(block);

    const step: Step = { id: '', kind, attrs, cards, links, pos: { line: block.lineNum, col: 1 } };

    const heading = NODES.get(kind)?.heading;
    let tookCond = false;
    if (heading && block.argStr) {
      tookCond = heading.parse(block.argStr, step, {
        line: block.lineNum,
        col: block.kindStr.length + 4,
        push: (d) => diagnostics.push(d),
      });
    }

    step.id = customId || defaultId(step, counters);

    if (promptLines.length > 0) {
      step.prompt = promptLines.join('\n');
    }

    // Parse conditions on heading or attrs
    if (!tookCond && attrs.until) {
      const condRes = parseCond(attrs.until, {
        line: block.lineNum,
        col: 1,
      });
      if (condRes.diag) diagnostics.push(condRes.diag);
      if (condRes.cond) step.cond = condRes.cond;
      delete attrs.until;
    }

    return step;
  }

  // 3. Tree assembly based on depth
  const rootSteps: Step[] = [];
  let blockIdx = 0;

  function parseStepList(targetDepth: number): Step[] {
    const list: Step[] = [];

    while (blockIdx < blocks.length) {
      const blk = blocks[blockIdx]!;
      if (blk.kindStr === 'whenever') {
        blockIdx++;
        // Parse auto card
        const condRes = parseCond(blk.argStr, {
          line: blk.lineNum,
          col: 'whenever '.length + 4,
        });
        if (condRes.diag) diagnostics.push(condRes.diag);

        const parsedLines = parseBlockLines(blk);
        const card = parsedLines.cards[0] || { kind: 'nudge', text: '' };
        autos.push({
          id: defaultId({ kind: 'auto' }, counters),
          cond: condRes.cond || { t: 'drift' },
          card,
        });
        continue;
      }

      if (blk.kindStr === 'else') {
        if (blk.depth === targetDepth) {
          // Return to caller so parent 'if' at targetDepth - 1 can handle else branch
          break;
        }
      }

      if (blk.depth < targetDepth) {
        break;
      }

      if (blk.depth > targetDepth) {
        // Nested under previous sibling if it's a container
        break;
      }

      if (!NODES.has(blk.kindStr)) {
        diagnostics.push({
          severity: 'error',
          message: `Unknown step kind "${blk.kindStr}"`,
          pos: { line: blk.lineNum, col: 1 },
        });
      }

      blockIdx++;
      const step = convertBlockToStep(blk);

      // A container node parses the blocks nested under it as its children
      const container = NODES.get(step.kind)?.container;
      if (container) {
        const kids = parseStepList(targetDepth + 1);
        if (kids.length > 0) {
          step.kids = kids;
        }

        if (
          container === 'kids+else' &&
          blockIdx < blocks.length &&
          blocks[blockIdx]!.kindStr === 'else' &&
          blocks[blockIdx]!.depth === targetDepth + 1
        ) {
          blockIdx++; // consume else
          const elseKids = parseStepList(targetDepth + 1);
          if (elseKids.length > 0) {
            step.else = elseKids;
          }
        }
      }

      list.push(step);
    }

    return list;
  }

  rootSteps.push(...parseStepList(2));

  const budget = fm.budget
    ? {
        turns: Number(fm.budget.turns ?? 0),
        minutes: Number(fm.budget.minutes ?? 0),
        ...(fm.budget.usd !== undefined ? { usd: Number(fm.budget.usd) } : {}),
      }
    : { turns: 0, minutes: 0 };

  const workflow: Workflow = {
    version: 1,
    name,
    budget,
    always: Array.isArray(fm.always) ? fm.always.map(String) : [],
    steps: rootSteps,
    autos,
    ...(fm.task ? { task: String(fm.task) } : {}),
    ...(fm.engine ? { engine: fm.engine } : {}),
    ...(fm.model ? { model: String(fm.model) } : {}),
    ...(fm.test ? { test: String(fm.test) } : {}),
    ...(fm.drift ? { drift: fm.drift } : {}),
    ...(isBlock ? { block: name } : {}),
  };

  return { workflow, diagnostics };
}
