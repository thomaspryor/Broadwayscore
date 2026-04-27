/**
 * Post-extraction byline cleanup (Lost Boys 2026-04-26 Issue #11).
 *
 * Three real failures from one opening night:
 *   - Variety: "Frank Rizzo" arrived as "Frank Rizzo\n\nPlus Icon" — an SVG
 *     button token adjacent to the byline got captured into the name. Strip
 *     trailing social/share/page-chrome tokens.
 *   - NY Sun: "ELYSA GARDNER" rendered all-caps in the source page; pipeline
 *     stored that literally. Title-case names that are entirely upper-case.
 *   - Cititour case ("Brian Scott Lipton" truncated to "Scott Lipton") is an
 *     under-capture upstream of this helper — the regex itself doesn't see
 *     "Brian", so this normalizer can't recover it. Fixed via filename
 *     rename + manual criticName edit.
 *
 * Extracted out of src/lib/admin-ingest-detect.ts so the rule can be tested
 * via `require()` per CLAUDE.md rule 15 (TS+server-only files can't be
 * imported from a node test runner).
 *
 * @param {string} raw - The byline capture from a regex match group.
 * @returns {string} - Normalized critic name.
 */
function normalizeBylineCapture(raw) {
  if (!raw) return raw;
  let cleaned = String(raw).trim();

  // Strip trailing social / share / page-chrome tokens that may fall inside
  // the capture group when the byline is followed by an SVG button or link
  // list. Tokens are matched as exact words (case-insensitive). Anchor on
  // optional separators (newlines, em-dash, middle-dot, pipe) so we don't
  // trim part of a real name.
  const trailingChrome = /\s*(?:\n|—|–|·|\|)?\s*(?:Plus\s*Icon|Share|Copy\s*Link|Twitter|Facebook|Email|Print|Comments?|Save)\b.*$/i;
  cleaned = cleaned.replace(trailingChrome, '').trim();

  // Collapse internal newlines / runs of whitespace introduced by inline
  // chrome that wasn't matched by the trailing-chrome regex above.
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Title-case ALL-CAPS names. A name written entirely in upper case (no
  // lowercase letters) is almost always a stylesheet artifact, not the
  // critic's preferred capitalization. Mixed-case (McDonald, O'Brien) names
  // stay untouched — only fully upper-case strings trip this.
  if (cleaned.length > 0 && /^[A-Z][A-Z\s.'’\-]+$/.test(cleaned)) {
    cleaned = cleaned
      .toLowerCase()
      .split(/\s+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  return cleaned;
}

module.exports = { normalizeBylineCapture };
