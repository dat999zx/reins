// What the first-run screen offers (spec 7.3), from `GET /api/mods`. Pure: no network, no React.
export interface ChooserEntry {
  id: string; label: string; description: string; protocol: string; host: string;
  keyEnv: string[]; untested: boolean;
  /** A local program that answers right now: ticked from the start. */
  local: boolean;
}
export interface InstallResult { id: string; ok: boolean; error?: string }

export const BUILT_IN_LINE = 'Claude Code is built in and ready if it is installed.';

/** One mod of the default pack, as `GET /api/mods` lists it in `pack`. */
export interface PackRow { id: string; label: string; enabled: boolean; required: boolean }
export const PACK_LINE = 'The blocks Reins starts with are built in, as the default pack. Switch off the ones you do not want; a required one is always on.';
/** The rows of the pack line. A required mod is shown on and has no switch, whatever the server sent. */
export const packRows = (pack: PackRow[]): Array<PackRow & { locked: boolean }> => pack.map((p) => ({ ...p, enabled: p.required || p.enabled, locked: p.required }));

/** The cards to show. A built-in provider is already there and is never a card, whatever the server sent. */
export const cardsOf = (chooser: ChooserEntry[], builtIn: string[]): ChooserEntry[] => chooser.filter((c) => !builtIn.includes(c.id));

/** Ticked from the start: the local programs. */
export const preTicked = (cards: ChooserEntry[]): string[] => cards.filter((c) => c.local).map((c) => c.id);

/** "needs MY_KEY" style words for what a card asks of the user. */
export const needsLine = (c: ChooserEntry): string => (c.keyEnv.length ? `needs ${c.keyEnv.join(' or ')}` : 'needs no key');

/** The body of the install request: the ticked ids, in card order, only ones that are cards. */
export const installIds = (cards: ChooserEntry[], ticked: string[]): string[] => cards.filter((c) => ticked.includes(c.id)).map((c) => c.id);

export const resultLine = (r: InstallResult): string => (r.ok ? `${r.id}: installed.` : `${r.id}: ${r.error ?? 'could not be installed.'}`);
