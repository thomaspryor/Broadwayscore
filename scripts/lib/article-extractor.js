/**
 * article-extractor.js — Extract clean main-article text from outlet HTML.
 *
 * Replaces "store raw HTML in fullText" pattern that was leaving 200K+ chars of
 * navigation chrome in review-text files for NYT, NYer, Variety, NYSR, etc.
 *
 * Each outlet has a distinct main-content selector. Falls back to <article> /
 * <main> for unknown outlets. Returns null if no plausible body found
 * (caller should treat null as fetch failure, not store the raw HTML).
 *
 * Usage:
 *   const { extractArticleText } = require('./lib/article-extractor');
 *   const text = extractArticleText(html, hostname);
 *   if (text && text.length > 200) saveAsFullText(text);
 */

'use strict';

function stripHtml(s) {
  return (s || '')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/g, '')
    .replace(/<aside[\s\S]*?<\/aside>/g, '')
    .replace(/<figure[^>]*>[\s\S]*?<\/figure>/g, ' ')
    .replace(/<figcaption[^>]*>[\s\S]*?<\/figcaption>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;|&ldquo;|&rdquo;|&#8220;|&#8221;/g, '"')
    .replace(/&#8217;|&rsquo;|&lsquo;|&#8216;/g, "'")
    .replace(/&mdash;|&#8212;/g, '—')
    .replace(/&ndash;|&#8211;/g, '–')
    .replace(/&hellip;|&#8230;/g, '…')
    .replace(/&\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Per-outlet patterns. Order matters: most specific first.
 * Each entry: [hostnameMatch, regex, minLength].
 * minLength gates against accidental shell-match (e.g. matching 200 chars of nav).
 */
const PATTERNS = [
  // NYT — section[name="articleBody"] is the primary
  ['nytimes.com', /<section[^>]+name="articleBody"[^>]*>([\s\S]*?)<\/section>/, 500],
  ['nytimes.com', /<div[^>]+itemprop="articleBody"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/, 500],

  // New Yorker
  ['newyorker.com', /<div[^>]+class="[^"]*body__inner-container[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<aside/, 500],
  ['newyorker.com', /<div[^>]+data-testid="(?:BodyWrapper|ArticleBodyWrapper)"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/, 500],

  // Variety — c-content wrapper
  ['variety.com', /<div[^>]+class="[^"]*c-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/article>/, 500],
  ['variety.com', /<div[^>]+class="[^"]*a-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/article>/, 500],

  // NYSR (WordPress) — entry-content
  ['nystagereview.com', /<div[^>]+class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/article>/, 300],

  // newyorktheater.me (WordPress) — entry-content
  ['newyorktheater.me', /<div[^>]+class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/article>/, 300],

  // WSJ
  ['wsj.com', /<section[^>]+id="article-body"[^>]*>([\s\S]*?)<\/section>/, 500],
  ['wsj.com', /<div[^>]+class="[^"]*article-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<footer/, 500],

  // Hollywood Reporter
  ['hollywoodreporter.com', /<div[^>]+class="[^"]*lrv-a-wrapper[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/section>/, 500],

  // TheaterMania (Drupal-ish)
  ['theatermania.com', /<div[^>]+class="[^"]*article-body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/article>/, 300],

  // Vulture — article-body
  ['vulture.com', /<div[^>]+class="[^"]*article-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<aside/, 300],

  // Generic fallbacks (any host)
  [null, /<article[^>]*>([\s\S]*?)<\/article>/, 300],
  [null, /<main[^>]*>([\s\S]*?)<\/main>/, 500],
];

/**
 * Extract main article text from raw HTML.
 *
 * @param {string} html - Raw HTML from outlet page.
 * @param {string} hostname - Hostname (e.g. "www.nytimes.com" or "nytimes.com").
 *   Will have leading "www." stripped before matching.
 * @returns {string|null} Cleaned article text, or null if no plausible match.
 */
function extractArticleText(html, hostname) {
  if (!html || typeof html !== 'string') return null;
  const host = String(hostname || '').replace(/^www\./, '').toLowerCase();

  for (const [hostMatch, re, minLen] of PATTERNS) {
    if (hostMatch && !host.includes(hostMatch)) continue;
    const m = html.match(re);
    if (m && m[1] && m[1].length >= minLen) {
      const text = stripHtml(m[1]);
      if (text.length >= 100) return text;
    }
  }
  return null;
}

/**
 * Convenience: derive hostname from URL and call extractArticleText.
 */
function extractArticleTextFromUrl(html, url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* fall through with empty host */ }
  return extractArticleText(html, host);
}

module.exports = { extractArticleText, extractArticleTextFromUrl, stripHtml };
