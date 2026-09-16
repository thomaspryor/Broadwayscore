/**
 * Best-effort byline extraction from raw article HTML — common <meta>/
 * <a rel=author>/class=author markers. Extracted from ingest-review-from-url.js
 * (CLAUDE.md rule 15: real logic under test, not copied into the test file).
 *
 * Defaults to null (caller maps that to 'Unknown') — backfill-unknown-bylines
 * style tooling recovers the real name later when a better source shows up.
 */

'use strict';

function decodeEntities(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&apos;|&lsquo;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function extractByline(html) {
  if (!html) return null;
  const candidates = [
    // OpenGraph / standard meta tags — most authoritative when present.
    /<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i,
    // class="author-name" / "author" / "byline" — common WordPress / blog patterns.
    // Run BEFORE rel="author" because Jetpack's "View all posts by X" link in the
    // footer also has rel="author" and pollutes the value.
    /<[a-z]+[^>]+class=["'][^"']*author-name[^"']*["'][^>]*>([^<]+)</i,
    // class="author-name" wrapping a nested <a> instead of raw text (e.g.
    // TheaterMania: <div class="author-name..."><a id="article-author-tag">Name</a></div>)
    // — the pattern above only captures direct text content, so it misses this
    // shape and the byline lands as "Unknown" (Basquiat 2026-09-16 postmortem).
    /<[a-z]+[^>]+class=["'][^"']*author-name[^"']*["'][^>]*>\s*<a[^>]*>([^<]+)<\/a>/i,
    /<span[^>]+class=["'][^"']*byline[^"']*["'][^>]*>(?:By\s+)?([^<]+)<\/span>/i,
    /<p[^>]+class=["'][^"']*byline[^"']*["'][^>]*>(?:By\s+)?([^<]+)<\/p>/i,
    // Inline "By Name" prose near top of article — FMJ-style "By Ross" right
    // after the headline. Capture follows the literal "By " token.
    />By\s+([A-Z][A-Za-z][A-Za-z .'-]{1,38})(?=\s+(?:[A-Z]|<|—))/,
    // <a rel="author"> — last because of the Jetpack footer issue above.
    /<a[^>]+rel=["']author["'][^>]*>([^<]+)<\/a>/i,
  ];
  for (const re of candidates) {
    const m = html.match(re);
    if (m && m[1]) {
      let name = decodeEntities(m[1]).trim();
      // Strip Jetpack-style "View all posts by X" prefix that leaks through
      // some <a rel=author> matches.
      name = name.replace(/^view\s+all\s+posts\s+by\s+/i, '');
      if (!name || name.length < 2 || name.length > 80 || !/[A-Za-z]/.test(name)) continue;
      // Capitalize lowercase author slugs from class="author-name" (e.g. "ross" → "Ross").
      if (/^[a-z][a-z\s.'-]*$/.test(name)) {
        name = name.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      }
      return name;
    }
  }
  return null;
}

module.exports = { extractByline, decodeEntities };
