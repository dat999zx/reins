// The one place the app writes "this figure leaves something out because it is not known". The app imports only core's types, so the mark is
// written here; a test holds it equal to core's `UNKNOWN_MARK` (the terminal's).
export const UNKNOWN_MARK = ' + ?';

/** A dollar figure as text, with the mark when part of what it sums is not known. */
export const dollars = (usd: number, digits: number, unknown?: boolean): string => `$${usd.toFixed(digits)}${unknown ? UNKNOWN_MARK : ''}`;

/** What a row says where a reply's cost is not known and there is no figure at all. */
export const UNKNOWN_COST = 'cost not known';

/** The title (hover text) of a total that leaves a reply out. */
export const UNKNOWN_TITLE = 'At least this much: one or more replies had no cost, so the total leaves them out.';
