// What the import dialog says about a mod file (spec 7.7), from the server's preview. Pure: no network, no React.
// Every string here is shown as text, never as HTML: a label or a file name may hold any characters.
export interface PreviewSummary {
  id: string; label: string; kind: string; protocol: string | null;
  replaces: 'your' | 'builtin' | null;
  replacesLine?: string;
  /** Where prompts go, a key already saved for the id, key variables set now. From the server; absent in an older reply. */
  reach?: string[];
  keys: Array<{ name: string; host: string; plainHttp: boolean; line: string }>;
  headers: string[];
  hasCode: boolean;
  /** The second prompt, from the server, word for word. */
  codePrompt?: string;
  /** One more line under the code prompt: the block may run several sessions at once and spend money on them. From the server. */
  tracksLine?: string;
  files: Array<{ name: string; bytes: number }>;
  warnings: string[];
}

/** Every line of the summary, in reading order. */
export function summaryLines(s: PreviewSummary): string[] {
  return [
    `Id: ${s.id}`,
    `Label: ${s.label}`,
    `Kind: ${s.kind}`,
    ...(s.protocol ? [`Protocol: ${s.protocol}`] : []),
    ...(s.replaces ? [s.replacesLine ?? (s.replaces === 'your' ? `replaces your ${s.id}` : `replaces the built-in ${s.id}`)] : []),
    ...(s.reach ?? []),
    ...s.keys.map((k) => k.line),
    ...(s.headers.length ? [`Adds headers: ${s.headers.join(', ')}`] : []),
    `Files: ${s.files.map((f) => `${f.name} (${f.bytes} bytes)`).join(', ')}`,
    ...(s.hasCode ? ['Has code: it runs inside Reins.'] : []),
    ...s.warnings,
  ];
}

export interface ImportPlan {
  /** False while there is a refusal, or a code mod whose warning the server did not send. */
  canImport: boolean;
  /** The two-button choice of the code prompt. */
  trustChoice: boolean;
  /** A mod that shadows a built-in one is asked about before anything is written. */
  confirmBuiltin: boolean;
  codePrompt?: string;
  tracksLine?: string;
}

export function planOf(s: PreviewSummary | undefined, problems: string[]): ImportPlan {
  const prompt = s?.hasCode && typeof s.codePrompt === 'string' && s.codePrompt ? s.codePrompt : undefined;
  return {
    canImport: !!s && problems.length === 0 && (!s.hasCode || prompt !== undefined),
    trustChoice: !!s?.hasCode,
    confirmBuiltin: s?.replaces === 'builtin',
    ...(prompt !== undefined ? { codePrompt: prompt } : {}),
    ...(prompt !== undefined && s?.tracksLine ? { tracksLine: s.tracksLine } : {}),
  };
}

/** The body of the apply request. Trust is sent only when the user chose "Trust and import". */
export const applyBody = (file: string, o: { trust: boolean; replaceBuiltin: boolean }) => ({
  file,
  ...(o.trust ? { trust: true } : {}),
  ...(o.replaceBuiltin ? { replaceBuiltin: true } : {}),
});

/** The refusal words of an answer: the server's list, or its one error line. */
export const problemsFrom = (body: any, fallback: string): string[] => (Array.isArray(body?.problems) && body.problems.length ? body.problems.map(String) : [fallback]);

export const TRUST_BUTTON = 'Trust and import';
export const NO_CODE_BUTTON = 'Import without running its code';
