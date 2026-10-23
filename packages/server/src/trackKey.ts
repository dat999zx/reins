/**
 * The step to show the user for a track key or a slice step. A block that starts a track under a key of its own writes `<step>#<word>` (the own playbook: `<step>#own`),
 * so the key cannot meet a fork branch; the user knows the step, not the key. The rule is only the shape `#<lowercase word>` at the end, so this file names no block and
 * imports no mod: a removed or customized mod changes nothing here. Every line that shows a key goes through here.
 */
export const shownStep = (key: string): string => key.replace(/(?<=.)#[a-z]+$/, '');
