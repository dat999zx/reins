export interface Span { cls: string; text: string }
export interface HighlightedLine { line: number; spans: Span[] }

export const lineOffset = (text: string, line: number) =>
  text.split('\n').slice(0, Math.max(0, line - 1)).reduce((n, l) => n + l.length + 1, 0);

const KEY =/^([A-Za-z][\w-]*:)(\s.*)?$/;

export function highlight(text: string): HighlightedLine[] {
  let fm = false;
  return text.split('\n').map((raw, i) => {
    const one = (cls: string): Span[] => [{ cls, text: raw }];
    let spans: Span[];
    if (raw === '') spans = [];
    else if (i === 0 && raw === '---') { fm = true; spans = one('fm'); }
    else if (fm) { if (raw === '---') fm = false; spans = one('fm'); }
    else if (/^\s*>/.test(raw)) spans = one('prompt');
    else if (/^#{1,6}\s/.test(raw)) spans = one('heading');
    else {
      const k = KEY.exec(raw);
      spans = k ? [{ cls: 'key', text: k[1]! }, { cls: 'value', text: raw.slice(k[1]!.length) }] : one('plain');
    }
    return { line: i + 1, spans };
  });
}
