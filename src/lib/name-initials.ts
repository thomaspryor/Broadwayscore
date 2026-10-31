/**
 * Two-letter avatar initials for a person/creator name.
 *
 * Takes the first letter or digit of each word, so punctuation-led words
 * ("Tyler (@tyvid5)", "\"Weird Al\"") don't produce "T(" or "\"W". Shared by
 * every avatar-initials badge (critics, video critics, cast, creatives) so the
 * fix lives in one place.
 */
export function getInitials(name: string): string {
  const letters = (name || '')
    .split(/\s+/)
    .map((word) => word.match(/[\p{L}\p{N}]/u)?.[0] ?? '')
    .filter(Boolean)
    .join('');
  return letters.slice(0, 2).toUpperCase();
}
