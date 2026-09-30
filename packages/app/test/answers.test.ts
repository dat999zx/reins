// Every button's answer goes through the real server parser, so a drift in drive.ts fails here.
import { describe, it, expect } from 'vitest';
import { askTool, parseAnswer, type DriveIo } from '../../server/src/drive.js';
import { actionsFor } from '../src/questions.js';

const pick = (kind: string, label: string) => actionsFor(kind).find((a) => a.label === label)!;
const io = (answer: string): DriveIo => ({ ask: async () => answer, say: () => {}, write: () => {} });

describe('question answers parse on the server', () => {
  it('gate, budget and resume words', () => {
    expect(parseAnswer('gate', pick('gate', 'Approve').build('')!)).toEqual({ t: 'approve' });
    expect(parseAnswer('gate', pick('gate', 'Request changes').build('rename it')!)).toEqual({ t: 'changes', note: 'rename it' });
    expect(parseAnswer('gate', pick('gate', 'Stop').build('')!)).toEqual({ t: 'stop' });
    expect(parseAnswer('budget', pick('budget', 'Allow').build('3')!)).toEqual({ t: 'allow', n: 3 });
    expect(parseAnswer('budget', pick('budget', 'Stop').build('')!)).toEqual({ t: 'stop' });
    expect(parseAnswer('resume', pick('resume', 'Resume').build('')!)).toEqual({ t: 'resume', note: '' });
    expect(parseAnswer('resume', pick('resume', 'Resume').build('go on')!)).toEqual({ t: 'resume', note: 'go on' });
    expect(parseAnswer('resume', pick('resume', 'Stop').build('')!)).toEqual({ t: 'stop' });
  });

  it('tool allow and deny', async () => {
    const req = { tool: 'Edit', input: { file_path: 'a' } };
    expect(await askTool(io(pick('tool', 'Allow').build('')!), req)).toEqual({ behavior: 'allow' });
    expect(await askTool(io(pick('tool', 'Deny').build('too risky')!), req)).toEqual({ behavior: 'deny', message: 'The user said no: too risky' });
    expect(await askTool(io(pick('tool', 'Deny').build('')!), req)).toEqual({ behavior: 'deny', message: 'The user said no.' });
  });
});
