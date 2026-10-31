/**
 * Review cards show the critic's own published rating under the score badge.
 * reviews.json stores it as the extractor read it ("4/5 stars", "4/5", "B+",
 * "80%"), and older rows hold a bare number (a 0-100 value). This returns the
 * text to display, or null when the value is not unambiguously a rating. A bare
 * number is dropped: "4" may be 4 of 5 or a stray normalized score. Takes
 * `unknown` because the stored type is string | number.
 */
export function formatOriginalRating(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/[–—−]/g, '-');

  let m = s.match(/^(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+(?:\.\d+)?)(?:\s*stars?)?$/i);
  if (m) {
    const num = parseFloat(m[1]);
    const max = parseFloat(m[2]);
    if (!(max > 0) || num > max) return null;
    // "7/10" is not a star count; only small scales read as stars.
    return max <= 6 ? `${m[1]}/${m[2]} stars` : `${m[1]}/${m[2]}`;
  }

  m = s.match(/^(\d+(?:\.\d+)?)\s*stars?$/i);
  if (m) return `${m[1]} ${parseFloat(m[1]) === 1 ? 'star' : 'stars'}`;

  m = s.match(/^(\d{1,3}(?:\.\d+)?)\s*%$/);
  if (m) return parseFloat(m[1]) <= 100 ? `${m[1]}%` : null;

  // Capital letters only: a lone lowercase "a" is far more likely a stray word.
  m = s.match(/^([A-D][+-]?|F)$/);
  if (m) return m[1];

  return null;
}
