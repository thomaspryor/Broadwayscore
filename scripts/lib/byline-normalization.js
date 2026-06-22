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

/**
 * URL-as-critic-name cleanup. Some scrapers (NYT, Observer, LA Times, Guardian,
 * SunTimes, BroadwayWorld, Londonist, Facebook) captured the byline LINK href
 * instead of the byline TEXT, so `criticName` ended up as e.g.
 * "https://www.nytimes.com/by/laura-collins-hughes". That URL then renders as
 * the critic name (surfaced in the newsletter Outlier of the Week, 2026-06-21).
 *
 * This derives a clean name from known byline-URL slug patterns:
 *   nytimes.com/by/<slug>, /author/<slug>, /people/<slug>, /profile/<slug>,
 *   /contributors/<slug>, chicagosuntimes.com/<slug>[-for-the-sun-times],
 *   facebook.com/<first.last>.
 *
 * Conservative by design: only derives when the slug splits into 2+ word
 * tokens on a separator (-, ., _). A single concatenated token
 * (guardian profile "ryangilbey") or an org page handle
 * (facebook.com/entertainmentweekly, /peoplemag, /showbiz411) is NOT a usable
 * personal name, so it returns null — the review then shows the outlet with no
 * bogus critic line, which is strictly better than printing a URL.
 *
 * @param {*} raw - stored criticName (may be a real name, a URL, or falsy).
 * @returns {string|null} cleaned name, the original (if already a clean name),
 *   or null when a URL can't yield a usable personal name.
 */
function normalizeCriticName(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  const s = raw.trim();
  // Not URL-shaped → leave as-is (still run the standard byline cleanup).
  if (!/https?:\/\/|\bwww\.|\.com\b/i.test(s)) return normalizeBylineCapture(s);

  // Extract the name-bearing slug from a known byline-URL pattern.
  let slug = null;
  let m = s.match(/\/(?:by|author|people|profile|contributors)\/([a-z0-9._-]+)/i);
  if (m) slug = m[1];
  if (!slug) {
    const su = s.match(/chicagosuntimes\.com\/([a-z0-9-]+)/i);
    if (su) slug = su[1].replace(/-for-the-sun-times$/i, '');
  }
  if (!slug) {
    const fb = s.match(/facebook\.com\/([a-z0-9._-]+)/i);
    if (fb && fb[1].includes('.')) slug = fb[1]; // first.last handle only
  }
  if (!slug) return null; // URL we can't resolve to a person → drop the name

  const words = slug.replace(/[._-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return null; // need a real multi-token name
  const name = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return /^[A-Za-z][A-Za-z'’ .-]+$/.test(name) ? name : null;
}

module.exports = { normalizeBylineCapture, normalizeCriticName };
