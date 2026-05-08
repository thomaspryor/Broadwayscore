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

  // newyorktheater.me (WordPress + Jetpack) — entry-content. Jetpack injects
  // sharedaddy share buttons + jp-relatedposts INSIDE entry-content, before
  // </article>. Stop at the first chrome marker to avoid pulling related-post
  // chrome ("Reading Broadway: The Books behind the 2025-2026 Season…",
  // unrelated cast lists from older shows) into the body. Without this, the
  // ensemble scoreability LLM correctly rejects the page as "not_a_review"
  // (Joe Turner / Jonathan Mandell 2026-04-26 incident).
  // Symmetric with the DOM extractor's CHROME_SELECTORS in
  // collect-review-texts.js.
  // ⚠️ DO NOT REVERT — a parallel session's merge wiped this once already
  // (commit 9c19b5afda). If git blame shows this getting "reverted" in a
  // merge, the fix is to re-add it, not delete it.
  ['newyorktheater.me', /<div[^>]+class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<div[^>]+(?:id="jp-post-flair"|class="[^"]*(?:sharedaddy|jp-relatedposts|wpcnt|sd-sharing|sd-like)[^"]*")/, 300],
  // Fallback for older posts without Jetpack chrome
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

  // NY Sun (Next.js) — main body lives in `article-wrapper` inside <main>.
  // The 8 <article class="group/article-teaser"> tags on the page are sidebar
  // teaser cards, NOT the review — without this NY Sun-specific pattern the
  // generic <article> fallback used to grab the first teaser and we'd reject
  // the whole page as url_content_mismatch (Joe Turner 2026-04-26 incident).
  ['nysun.com', /<div[^>]+class="[^"]*article-wrapper[^"]*"[^>]*>([\s\S]*?)<\/main>/, 300],

  // Opera outlets — added when SERP discovery for opera shows landed (Innocence
  // Met Opera 2026-04-27). Each is a WordPress install with a distinct theme.
  // newyorkclassicalreview.com — el-clasico theme uses id="post-body" (not class)
  ['newyorkclassicalreview.com', /<div[^>]+id="post-body"[^>]*>([\s\S]*?)<div[^>]+id="content-post-footer"/, 300],
  // classicalvoiceamerica.org — WordPress, entry-content
  ['classicalvoiceamerica.org', /<div[^>]+class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<(?:footer|aside|div[^>]+class="[^"]*sharedaddy)/, 300],
  // parterre.com — WordPress, entry-content
  ['parterre.com', /<div[^>]+class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<(?:footer|aside|div[^>]+class="[^"]*(?:sharedaddy|jp-relatedposts))/, 300],
  // operawire.com — WordPress, entry-content (similar pattern)
  ['operawire.com', /<div[^>]+class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<(?:footer|aside|div[^>]+class="[^"]*(?:sharedaddy|jp-relatedposts))/, 300],
  // bachtrack.com — paywalled; .ar-main contains carousel + meta + (paywalled body).
  // Best-effort: capture meta description as fullText since body itself isn't free.
  // The S6 star-rating skip handles ensemble bypass for these.
  ['bachtrack.com', /<meta[^>]+name="description"[^>]+content="([^"]+)"/, 100],
  // seenandheard-international.com — WordPress, entry-content
  ['seenandheard-international.com', /<div[^>]+class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<(?:footer|aside|div[^>]+class="[^"]*(?:sharedaddy|jp-relatedposts))/, 300],
  // newcriterion.com — uses div.dispatch-body or entry-content depending on template
  ['newcriterion.com', /<div[^>]+class="[^"]*(?:dispatch-body|entry-content|article-body)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<(?:footer|aside)/, 300],

  // Front Mezz Junkies — WordPress.com hosted, entry-content with Jetpack chrome.
  // Same pattern as newyorktheater.me: stop at sharedaddy / jp-relatedposts to
  // avoid pulling related-post titles into the article body.
  ['frontmezzjunkies.com', /<div[^>]+class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<div[^>]+(?:id="jp-post-flair"|class="[^"]*(?:sharedaddy|jp-relatedposts|wpcnt|sd-sharing|sd-like)[^"]*")/, 300],
  ['frontmezzjunkies.com', /<div[^>]+class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/article>/, 300],

  // Generic fallbacks (any host) — see extractGeneric below for largest-match logic.
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
    // Generic fallbacks (hostMatch === null) pick the LARGEST match, not the
    // first — sidebar teaser cards on Next.js/SPA sites use <article> too, and
    // the first <article> on the page is often a teaser (Joe Turner 2026-04-26
    // NY Sun incident: 8 sidebar teasers shadowed the real story). For
    // host-specific patterns we trust the selector to be unique enough.
    const reGlobal = hostMatch == null ? new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g') : null;
    let best = null;
    if (reGlobal) {
      for (const m of html.matchAll(reGlobal)) {
        if (m[1] && m[1].length >= minLen && (!best || m[1].length > best.length)) best = m[1];
      }
    } else {
      const m = html.match(re);
      if (m && m[1] && m[1].length >= minLen) best = m[1];
    }
    if (best) {
      const text = stripHtml(best);
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
