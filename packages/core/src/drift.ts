import type { RunEventRecord } from './run.js';

export interface DriftFinding {
  rule: 'repeated_action' | 'stagnation' | 'edit_before_plan' | 'skip_validation' | 'same_error';
  card?: string;
  details?: string;
}

export function repeatedAction(
  events: RunEventRecord[],
  threshold = 3
): DriftFinding | null {
  const counts = new Map<string, number>();

  for (const ev of events) {
    if (ev.type === 'tool_call') {
      const key = `${ev.data.tool}:${JSON.stringify(ev.data.input || {})}`;
      const c = (counts.get(key) || 0) + 1;
      counts.set(key, c);
      if (c >= threshold) {
        return {
          rule: 'repeated_action',
          card: `You've run the same thing ${threshold} times. Stop and read the output.`,
          details: `Repeated tool: ${ev.data.tool}`,
        };
      }
    }
  }

  return null;
}

export function stagnation(
  events: RunEventRecord[],
  threshold = 25
): DriftFinding | null {
  let callsWithoutChange = 0;

  for (const ev of events) {
    if (ev.type === 'tool_call') {
      const tool = ev.data.tool;
      const isFileChange = ['Edit', 'Write', 'Patch'].includes(tool);
      if (isFileChange) {
        callsWithoutChange = 0;
      } else {
        callsWithoutChange++;
        if (callsWithoutChange > threshold) {
          return {
            rule: 'stagnation',
            card: `${threshold} steps with no change. Summarise where you are and what's blocking you.`,
            details: `${callsWithoutChange} tool calls without modifying any files.`,
          };
        }
      }
    }
  }

  return null;
}

export function editBeforePlan(events: RunEventRecord[]): DriftFinding | null {
  for (const ev of events) {
    if (ev.type === 'refusal' && ev.data?.reason?.includes('read-only')) {
      return {
        rule: 'edit_before_plan',
        details: 'Attempted to edit during a read-only phase before plan approval.',
      };
    }
  }
  return null;
}

export function skipValidation(
  events: RunEventRecord[],
  stepTextOrTitle = ''
): DriftFinding | null {
  const isTestStep = /test|verify|spec/i.test(stepTextOrTitle);
  if (!isTestStep) return null;

  let ranTest = false;
  for (const ev of events) {
    if (ev.type === 'tool_call') {
      const tool = ev.data.tool;
      const cmd = ev.data.input?.command || ev.data.input?.cmd || '';
      if (/test/i.test(tool) || /test|vitest|jest|npm test/i.test(cmd)) {
        ranTest = true;
      }
    }
  }

  if (!ranTest) {
    return {
      rule: 'skip_validation',
      card: "You haven't run the tests in this step.",
      details: 'Step requested testing but no test command was executed.',
    };
  }

  return null;
}

export function sameError(events: RunEventRecord[]): DriftFinding | null {
  const failures: string[] = [];
  const norm = (s: string) =>
    s
      .replace(/\/[^:\s]+/g, '')
      .replace(/\d+/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  for (const ev of events) {
    if (ev.type === 'tool_call' && ev.data?.exitCode !== undefined) {
      if (ev.data.exitCode !== 0) {
        failures.push(norm(ev.data.output || ''));
      } else {
        failures.length = 0; // Success resets
      }
    }
  }

  if (failures.length >= 2) {
    const f1 = failures[failures.length - 1]!;
    const f2 = failures[failures.length - 2]!;
    if (f1 === f2 && f1.length > 0) {
      return {
        rule: 'same_error',
        card: 'Same error again. Read it before retrying.',
        details: 'Two consecutive failures with matching error signatures.',
      };
    }
  }

  return null;
}
