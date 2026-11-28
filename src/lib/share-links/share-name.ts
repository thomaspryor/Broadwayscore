/**
 * The name an owner prints on a share link (plans, diary). Pure; the iOS app
 * ports the same rules.
 */

export const SHARE_NAME_MAX = 30;

/**
 * The name printed on a branded preview card. The database only checks
 * length; this also keeps people from posing as the site itself.
 * Returns an error message, or null when the name is fine.
 */
export function validateShareName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return 'Add the name your friends know you by.';
  if (name.length > SHARE_NAME_MAX) return `Keep it to ${SHARE_NAME_MAX} characters.`;
  if (/scorecard|broadway\s*score/i.test(name)) return 'Please use your own name.';
  return null;
}

/** First word of the profile name (never the full name unless they type it). */
export function defaultShareName(profileName: string | null | undefined): string {
  const first = (profileName ?? '').trim().split(/\s+/)[0] ?? '';
  return first.slice(0, SHARE_NAME_MAX);
}
