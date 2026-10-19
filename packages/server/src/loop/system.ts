// ponytail: a placeholder. The real prompt (tools, working and safety rules, card note, AGENTS.md) is written with the tools.
export const systemPrompt = (cwd: string): string => `You are a coding agent working in ${cwd}.`;
