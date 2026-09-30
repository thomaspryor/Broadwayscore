/**
 * Best-effort byline extraction from raw article HTML — common <meta>/
 * <a rel=author>/class=author markers. Extracted from ingest-review-from-url.js
 * (CLAUDE.md rule 15: real logic under test, not copied into the test file).
 *
 * Defaults to null (caller maps that to 'Unknown') — backfill-unknown-bylines
 * style tooling recovers the real name later when a better source shows up.
 */

'use strict';

const { stripBylineSuffixes } = require('./byline-normalization');

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
    // An explicit "Reviewer: Name" line under the headline names the person;
    // the meta author on those sites is the house account (The Reviews Hub:
    // meta author "The Reviews Hub - London", sub-title "Reviewer: Scott
    // Matthewman", 58 files filed under the house name, BRO-4431).
    />\s*Reviewer:\s*([A-Z][A-Za-z .'’-]{1,60}?)\s*</,
    // OpenGraph / standard meta tags — most authoritative when present.
    /<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i,
    // class="author-name" / "author" / "byline" — common WordPress / blog patterns.
    // Run BEFORE rel="author" because Jetpack's "View all posts by X" link in the
    // footer also has rel="author" and pollutes the value.
    /<[a-z]+[^>]+class=["'][^"']*author-name[^"']*["'][^>]*>([^<]+)</i,
    // A <br> between the name and the closing tag ("Michael Sommers<br></span>")
    // is tolerated so the capture is the name, not a miss (audit S7-T4).
    /<span[^>]+class=["'][^"']*byline[^"']*["'][^>]*>(?:By\s+)?([^<]+?)\s*(?:<br\s*\/?>\s*)*<\/span>/i,
    /<p[^>]+class=["'][^"']*byline[^"']*["'][^>]*>(?:By\s+)?([^<]+?)\s*(?:<br\s*\/?>\s*)*<\/p>/i,
    // Inline "By Name" prose near top of article — FMJ-style "By Ross" right
    // after the headline. Capture follows the literal "By " token. The name
    // class accepts the curly apostrophe (’) and its entity forms (&rsquo;,
    // &#8217;) so "Holly O’Mahony" is captured whole instead of stopping at
    // "Holly O" (audit S7-T4).
    />By\s+([A-Z][A-Za-z](?:[A-Za-z .'’-]|&rsquo;|&#8217;){1,38})(?=\s+(?:[A-Z]|<|—))/,
    // <a rel="author"> — before the nested-author-name fallback below because
    // an explicit rel="author" is a stronger signal than a bare class name.
    /<a[^>]+rel=["']author["'][^>]*>([^<]+)<\/a>/i,
    // class="author-name" wrapping a nested <a> instead of raw text (e.g.
    // TheaterMania: <div class="author-name..."><a id="article-author-tag">Name</a></div>)
    // — the direct-text pattern above only captures immediate text content, so
    // it misses this shape and the byline lands as "Unknown" (Basquiat
    // 2026-09-16 postmortem). Kept LAST and scoped to an <a> that carries
    // rel="author" or an id/class containing "author" — an unscoped version
    // matched the first nested anchor found anywhere inside any author-name-
    // classed ancestor (e.g. a "Share"/related-article link), which could
    // outrank a real .byline/rel=author match earlier in the same page
    // (2026-09-16 adversarial review, BRO-3658 follow-up).
    /<[a-z]+[^>]+class=["'][^"']*author-name[^"']*["'][^>]*>\s*<a[^>]*(?:rel=["']author["']|(?:id|class)=["'][^"']*author[^"']*["'])[^>]*>([^<]+)<\/a>/i,
  ];
  for (const re of candidates) {
    const m = html.match(re);
    if (m && m[1]) {
      let name = decodeEntities(m[1]).trim();
      // Strip Jetpack-style "View all posts by X" prefix that leaks through
      // some <a rel=author> matches.
      name = name.replace(/^view\s+all\s+posts\s+by\s+/i, '');
      // Strip what rides along with the name at capture time — ", Chief
      // Theatre Critic", "(she/her)", "<br>" / a stray ">" — so the stored
      // criticName is the person (audit S7-T4). Shared with
      // normalizeBylineCapture; one implementation.
      name = stripBylineSuffixes(name);
      if (!name || name.length < 2 || name.length > 80 || !/[A-Za-z]/.test(name)) continue;
      // Capitalize lowercase author slugs from class="author-name" (e.g. "ross" → "Ross").
      if (/^[a-z][a-z\s.'’-]*$/.test(name)) {
        name = name.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      }
      return name;
    }
  }
  return null;
}

module.exports = { extractByline, decodeEntities };
