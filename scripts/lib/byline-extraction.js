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

const REVIEWER_LINE_RE = />\s*Reviewer:\s*([A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,3})\s*</;
const NOT_A_PERSON_RE = /\b(?:anonymous|staff|team|editor|editorial|desk|admin|guest|verified|customer|reviews?|hub|critics?|press|night|theatre|theater|magazine|news|online|london|uk)\b|^(?:the|our)\b/i;

/**
 * A "Reviewer: First Last" line (a visible element of its own, not prose)
 * names the critic on sites whose meta author is the house account (The
 * Reviews Hub: meta "The Reviews Hub - London", sub-title "Reviewer: Scott
 * Matthewman"; 58 files filed under the house name, BRO-4431). Two to four
 * capitalised words, no house/placeholder words, or null.
 */
function extractReviewerLine(html) {
  if (!html) return null;
  const m = REVIEWER_LINE_RE.exec(String(html).replace(/&nbsp;|&#160;|&#xa0;/gi, ' '));
  if (!m) return null;
  const name = decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
  if (NOT_A_PERSON_RE.test(name)) return null;
  if (name.split(' ').some((w) => w.replace(/[.'’-]/g, '').length < 2)) return null;
  return name;
}

// BRO-4475: BroadwayWorld's meta/author markup can carry the author PAGE URL
// (broadwayworld.com/author/...) as the value; a name is never an href.
const URL_LIKE_RE = /^(?:https?:)?\/\/|^www\.|^\/[a-z]|\.(?:com|co\.uk|org|net)\/|\/author\//i;

const DOMAIN_LIKE_RE = /\.(?:com|co\.uk|org|net)\b/i;

/**
 * Author name from schema.org JSON-LD (`"author": {"@type":"Person","name":..}`,
 * object, array or bare string). Only Person-typed (or untyped) authors; never
 * a URL, domain, organisation or house name (NOT_A_PERSON_RE).
 */
function extractJsonLdAuthor(html) {
  const blocks = String(html).match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const block of blocks) {
    let doc;
    try {
      doc = JSON.parse(block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, ''));
    } catch { continue; }
    const queue = [doc];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) { queue.push(...node); continue; }
      if (node.author) {
        for (const a of [].concat(node.author)) {
          if (a && typeof a === 'object' && a['@type'] && !/^Person$/i.test([].concat(a['@type'])[0])) continue;
          const raw = typeof a === 'string' ? a : a && a.name;
          if (typeof raw !== 'string') continue;
          const name = stripBylineSuffixes(decodeEntities(raw).trim());
          if (!name || name.length < 2 || name.length > 80 || !/[A-Za-z]/.test(name)) continue;
          if (URL_LIKE_RE.test(name) || DOMAIN_LIKE_RE.test(name) || NOT_A_PERSON_RE.test(name)) continue;
          return name;
        }
      }
      if (node['@graph']) queue.push(node['@graph']);
    }
  }
  return null;
}

function extractByline(html) {
  if (!html) return null;
  const reviewer = extractReviewerLine(html);
  if (reviewer) return reviewer;
  const jsonLd = extractJsonLdAuthor(html);
  if (jsonLd) return jsonLd;
  const candidates = [
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
      if (URL_LIKE_RE.test(name)) continue;
      // Capitalize lowercase author slugs from class="author-name" (e.g. "ross" → "Ross").
      if (/^[a-z][a-z\s.'’-]*$/.test(name)) {
        name = name.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      }
      return name;
    }
  }
  return null;
}

module.exports = {
  extractReviewerLine, extractByline, extractJsonLdAuthor, decodeEntities };
