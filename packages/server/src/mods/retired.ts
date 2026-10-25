/** Provider ids that were shipped once and are gone for good (spec 9.4): a session row that names one cannot be fixed by installing anything. */
export const retiredProviders: readonly string[] = ['claude'];

/** Provider ids that were renamed: `old -> new`. The store moves the session rows of an old id to the new one when it opens. */
export const renamedProviders: Readonly<Record<string, string>> = { claude: 'claude-code' };
