/**
 * Review cards show the critic's own published rating beside the byline.
 * reviews.json stores it as the extractor read it ("4/5 stars", "4/5", "B+",
 * "80%", a bare "82"); this returns the text to display, or null when the
 * value is not unambiguously a rating. A bare number is dropped: "4" may be
 * 4 of 5 or a stray normalized score.
 */
export function formatOriginalRating(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(/[–—−]/g, '-');

  let m = s.match(/^(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+(?:\.\d+)?)(?:\s*stars?)?$/i);
  if (m) {
    // "7/10" is not a star count; only small scales read as stars.
    return parseFloat(m[2]) <= 6 ? `${m[1]}/${m[2]} stars` : `${m[1]}/${m[2]}`;
  }

  m = s.match(/^(\d+(?:\.\d+)?)\s*stars?$/i);
  if (m) return `${m[1]} ${parseFloat(m[1]) === 1 ? 'star' : 'stars'}`;

  m = s.match(/^(\d{1,3}(?:\.\d+)?)\s*%$/);
  if (m) return `${m[1]}%`;

  m = s.match(/^([A-D][+-]?|F)$/i);
  if (m) return m[1].toUpperCase();

  return null;
}
