/**
 * Shared title-normalization for matching external audience-source titles
 * (Mezzanine, Theatr, etc.) to our shows.json entries.
 *
 * Why a shared lib: each scraper used to have its own normalize() with subtly
 * different regexes. When Mezzanine's "What Happened Was…" failed to match our
 * "What Happened Was" in 2026-04, the bug was a missing U+2026 in one scraper.
 * Drift across scrapers = recurring class of bugs. One implementation, tested.
 *
 * Design choices:
 *   - Joiners (apostrophes, hyphens) → empty so "Grown-Ups" stays distinct from
 *     "Grown Ups" (different plays).
 *   - Separators (slash, ellipsis, period, comma) → space so "foo/bar" matches
 *     "foo / bar" and "Master Harold...and the Boys" matches the U+2026 form.
 *   - Type designators in TRAILING parens "(Play)" / "(Musical)" preserved as
 *     plain text so Redwood (Play) ≠ Redwood (Musical). Mid-string parens and
 *     bracket content are stripped (codex review caught: bracketed year tags
 *     like "[2024] Show" used to bleed into title tokens).
 *   - Trailing " (the )?musical" stripped so Burlesque ≡ Burlesque the Musical.
 *
 * See scripts/scrape-mezzanine-audience.js for the matching strategies that
 * consume normalize(): exact match, prefix match, sibling year-proximity.
 */

// Type designators that disambiguate revivals/adaptations and MUST be
// preserved. Only matched at end-of-string — mid-string `(Musical)` is venue
// noise (codex caught: "Foo (Musical) Bar" used to bleed "musical" mid-token).
const TYPE_DESIGNATOR_RE = /\s*\((play|musical|comedy|drama|dance|opera|new musical|new play)\)\s*$/i;

function normalizeTitle(s) {
  if (!s) return '';
  return s.toLowerCase()
    // & → "and" so "Bonnie & Clyde" === "Bonnie and Clyde"
    .replace(/&/g, ' and ')
    // Trailing type designator: keep as plain text so it survives parens-strip
    // and the trailing-musical strip can normalize it consistently.
    .replace(TYPE_DESIGNATOR_RE, ' $1 ')
    // Strip remaining parenthesized content (venues, composers, season tags).
    // "Cable Street (59e59)" → "Cable Street", "Cinderella (Andrew Lloyd Webber)"
    // → "Cinderella". "Foo (Musical) Bar" — already handled above if trailing,
    // otherwise mid-string parens are noise and get dropped here.
    .replace(/\([^)]*\)/g, ' ')
    // Strip bracketed content the same way: "[2024] Show" → " Show"
    .replace(/\[[^\]]*\]/g, ' ')
    // Joiners → empty (apostrophes, quotes, hyphens, em/en dash). Words don't
    // split: "Grown-Ups" → "grownups" stays distinct from "Grown Ups".
    .replace(/['‘’"“”\-–—]/g, '')
    // Separators/terminators → space. Includes period, comma, slash, ellipsis,
    // brackets etc. Different than joiners — these create token boundaries.
    .replace(/[!?:,.;+*…/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the\s+/g, '')
    // Trailing " (the )?musical" so "Urinetown" ≡ "Urinetown The Musical" and
    // "Redwood" ≡ "Redwood (Musical)" (the kept type designator just got
    // stripped to plain "musical" by the parens-text-keep above).
    .replace(/\s+(the\s+)?musical$/, '');
}

// Token set for jaccard-style similarity. Stop words exclude language fillers
// but KEEP 'play' and 'musical' — those are type discriminators and dropping
// them collapses "Redwood (Play)" ≡ "Redwood (Musical)" ≡ "Redwood" to the
// same {redwood} bag (claude review caught: defeats type disambiguation).
const STOP_WORDS = new Set(['the','and','for','with','from','your','our','a','an','of','to','at','in','on']);

function titleTokens(s) {
  return new Set(
    normalizeTitle(s)
      .split(' ')
      .filter(t => t.length >= 3 && !STOP_WORDS.has(t))
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  const inter = [...a].filter(x => b.has(x)).length;
  return inter / new Set([...a, ...b]).size;
}

module.exports = { normalizeTitle, titleTokens, jaccard, TYPE_DESIGNATOR_RE, STOP_WORDS };
