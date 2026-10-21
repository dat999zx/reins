// One way to show text that somebody else wrote where a person has to decide something (an approval card, a terminal question, a picker line).
// Characters that change how text reads, or hide that they are there, are shown as <U+XXXX>; what EXECUTES is never passed through here.

// Matched with Unicode property escapes (the `u` flag; Node 22 supports all of these), so the set follows the Unicode data of the runtime instead of a
// list kept here: Cc (C0, DEL and C1 controls), Cf (format characters: soft hyphen, the Arabic letter mark, zero-width space, joiner and direction
// marks, the embedding, override and isolate controls, the word joiner and invisible operators, the byte order mark, the interlinear and
// shorthand format characters, the language tag), Cs (a lone surrogate; a real pair is one code point and is not matched), Zl and Zp (the line and
// paragraph separators), and Default_Ignorable_Code_Point (the combining grapheme joiner, the Hangul and Halfwidth Hangul fillers, the Khmer
// inherent vowels, the Mongolian free variation selectors, all variation selectors, the specials FFF0 to FFF8, the whole tag block E0000 to E0FFF).
const CLASS = '[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}]';
const HIDDEN = new RegExp(CLASS, 'u');
const HIDDEN_ALL = new RegExp(CLASS, 'gu');

/** The mark after a dollar figure that leaves something out because that part is not known ("$0.0200 + ?"). The one place; the app and the terminal use it. */
export const UNKNOWN_MARK = ' + ?';
/** The words of a dollar limit that cannot be held because what was spent is not known. The one place; the loop engine and the Run use it. */
export const USD_UNKNOWN = 'Reins cannot tell what this session has spent, so Allow cannot raise the dollar limit. Start a new session or remove the limit.';
/** The line under a total that leaves `n` replies out. */
export const unpricedWords = (n: number): string => (n === 1 ? '1 reply had no price; the total leaves it out' : `${n} replies had no price; the total leaves them out`);

/** True when `s` holds a character `showText` would escape (a line break or a tab included). For text that must never hold one, such as a model id. */
export const hasHiddenChars = (s: string): boolean => HIDDEN.test(s);

/**
 * `s` with every hidden character shown as `<U+XXXX>`. A line break and a tab are shown as `\n` and `\t` (one line stays one line), or, with
 * `lines`, kept as they are (a multi-line area that scrolls).
 */
export function showText(s: string, o: { lines?: boolean } = {}): string {
  return s.replace(HIDDEN_ALL, (c) => {
    if (c === '\n') return o.lines ? c : '\\n';
    if (c === '\t') return o.lines ? c : '\\t';
    return `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`;
  });
}
