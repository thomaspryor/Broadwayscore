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
 * Remove balanced <div>…</div> blocks whose opening tag's class contains any of
 * the given needles. Regex can't match nested divs, so we walk the tag stream and
 * splice out each target block by depth-counting to its matching close.
 */
function removeBalancedDivBlocks(html, classNeedles) {
  let out = html;
  for (const needle of classNeedles) {
    const openRe = new RegExp(
      '<div[^>]*class="[^"]*' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^"]*"[^>]*>',
      'i'
    );
    let guard = 0;
    let idx;
    while ((idx = out.search(openRe)) > -1 && guard++ < 50) {
      const tagRe = /<div\b[^>]*>|<\/div>/g;
      tagRe.lastIndex = idx;
      let depth = 0;
      let end = -1;
      let m;
      while ((m = tagRe.exec(out))) {
        if (m[0] === '</div>') {
          depth--;
          if (depth === 0) { end = m.index + 6; break; }
        } else {
          depth++;
        }
      }
      if (end === -1) break; // unbalanced — leave as-is rather than corrupt
      out = out.slice(0, idx) + ' ' + out.slice(end);
    }
  }
  return out;
}

/**
 * The Stage (thestage.co.uk) — paywalled subscription site. Until the cookie
 * auth was restored (2026-05-31) every fetch returned a registration wall with
 * 0 body, so there was no point having an extractor. With valid USERSECURE
 * cookies, the full review body comes through in <p> tags spread across
 * multiple `aos-DS32-WYSEdit` (CMS rich-text) blocks, with an inline
 * `aos-Article-RelatedContent` widget injected mid-article (so a tight end
 * marker truncates). The trailing author bio / subscribe pitch / copyright
 * are also <p> tags and need content-based filtering.
 *
 * Strategy: from the IntroText (standfirst) onward, collect substantial <p>
 * prose and drop the known trailing-noise paragraph shapes (author bio,
 * subscribe CTA, copyright). Verified against the a-dolls-house review:
 * logged-in → 2959 chars (10 paragraphs, matches on-disk 3300); logged-out
 * → 0 (so the verifier still flags a dead session correctly).
 */
function extractStageBody(html) {
  const startM = html.match(/<div[^>]*class="[^"]*aos-Article-IntroText[^"]*"[^>]*>/);
  if (!startM) return null;
  const region = html.slice(startM.index);
  const isTrailingNoise = (t) =>
    // Author bio: "Firstname [Lastname] is a (culture|theatre|freelance)? journalist/critic/..."
    // First-name-only bylines (e.g. "Holly is a culture journalist…") slipped the
    // multi-word-name pattern, so allow zero additional name parts.
    /^[A-Z][a-z]+(?:\s+[A-Z][a-z'-]+)*\s+is\s+(?:a|an|the|freelance|theatre)\s+(?:culture\s+|theatre\s+|freelance\s+|theater\s+)?(?:journalist|critic|writer|editor|reviewer)/i.test(t) ||
    // Subscribe pitch
    /subscription\s+starting|Invest in The Stage|Subscribe\s+Start a subscription/i.test(t) ||
    // Copyright
    /^©\s*Copyright/.test(t) ||
    // Related-articles widget link clusters
    /Related Articles|More from this Author|Login Register/i.test(t);
  const paras = [...region.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
    .map((m) => stripHtml(m[1]))
    .filter((t) => t.length > 40 && /[a-z]/.test(t) && !isTrailingNoise(t));
  const body = paras.join('\n\n');
  return body.length >= 300 ? body : null;
}

/**
 * Variety (variety.com) — the review body lives in a single `div.a-content`, but
 * the current layout injects promo modules MID-ARTICLE: `injected-related-story`
 * ("Related Stories") and `pmc-contextual-player` ("Popular on Variety"). The old
 * DOM patterns stopped at the first `</div></article>` and returned ~600–840 chars
 * (the lede + bled-in promo link text), silently truncating every Variety review.
 * Static HTML, so the production fetch path (cookie-plain / SB render_js=false)
 * hits the same truncation. (2026-05-29 incident — rocky-horror/beaches/balusters
 * all extracted <840 chars while the full review is ~6.3–6.9K chars.)
 *
 * Strategy: slice from `a-content` open to the first post-body marker, strip the
 * two promo containers by balanced-div removal, then collect review <p> prose.
 * Verified against 3 fixtures → 6254 / 6401 / 6919 chars, zero promo bleed.
 */
function extractVarietyBody(html) {
  const openM = html.match(/<div[^>]*class="[^"]*\ba-content\b[^"]*"[^>]*>/);
  if (!openM) return null;
  const open = openM.index;
  let end = html.length;
  for (const mk of ['Read More About', 'Jump to Comments', 'More from Variety', 'Sign Up for Variety']) {
    const i = html.indexOf(mk, open);
    if (i > -1 && i < end) end = i;
  }
  let region = html.slice(open, end);
  region = removeBalancedDivBlocks(region, ['injected-related-story', 'pmc-contextual-player']);
  const paras = [...region.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
    .map((m) => stripHtml(m[1]))
    .filter((t) => t.length > 40 && /[a-z]/.test(t));
  const body = paras.join('\n\n');
  return body.length >= 300 ? body : null;
}

/**
 * Lighting & Sound America (lightingandsoundamerica.com) — an old table-based
 * site with NO body container div. The review prose is a run of sibling
 * <p><font face="Arial,Helvetica,Geneva,Swiss,SunSans-Regular">…</p> paragraphs;
 * the nav/footer use other fonts. Because its story.asp?ID=… URLs carry no title
 * in the path, L&SA reviews were both filtered out of discovery AND saved as
 * stubs (no extractor pattern) — it recurred as the dominant Show Score gap
 * across shows (Receptionist/Animal Wisdom/Jerome/Indian Princesses, 2026-06-06).
 * Strategy: collect the Arial-font review paragraphs, drop trailing chrome.
 */
function extractLsaBody(html) {
  const paras = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .filter((m) => /<font[^>]+face="Arial,Helvetica,Geneva,Swiss/i.test(m[1]))
    .map((m) => stripHtml(m[1]))
    .filter((t) => t.length > 40 && /[a-z]/.test(t)
      && !/^©|All rights reserved|PLASA Media|Subscribe to (?:News|LSA)|Back to|Today's News/i.test(t)
      // Contact/address footer block ("Lighting&Sound America, 372 Central Park
      // West… Tel:… lsamedia.com") shares the Arial review font, so drop by content.
      && !/Lighting\s*&\s*Sound America\s*,|Central Park West|Tel:\s*\d|lsamedia\.com/i.test(t));
  const body = paras.join('\n\n');
  return body.length >= 300 ? body : null;
}

// L&SA signs every review with a trailing "--David Barbour" sign-off. Its
// <meta name="author"> is the publisher ("PLASA Media Inc - Lighting & Sound
// America"), so a meta-first byline extractor mis-attributes every L&SA review
// to the publisher. Pull the real critic from the body's trailing "--Name".
// Pass the extracted body text (extractLsaBody output) or raw prose.
// Title-Case tails that fit the "Firstname Lastname" shape but are not critics
// (place names, venue/section labels). A false byline is worse than the publisher
// fallback, so reject these — ingest then falls back to extractByline/Unknown.
const LSA_NON_NAME_TAIL = /\b(?:New York|Los Angeles|City|Street|Avenue|Road|Theatre|Theater|Broadway|Off Broadway|The End|Curtain Call|Company|Center|Centre|Hall|Square|Park|Press|Media|Productions?|Inc|LLC|USA|America)\b/i;

function extractLsaByline(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.trim().match(/[—–-]{1,2}\s*([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,2})\s*$/);
  if (!m) return null;
  const name = m[1].trim();
  if (LSA_NON_NAME_TAIL.test(name)) return null;
  return name;
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

  // TheaterMania — current Bootstrap layout (2026): review body lives in
  // <div class="news-content">, ending at <section class="featured-in-this-story">.
  // The old Drupal `article-body` pattern (kept below as fallback) stopped
  // matching after a site redesign — returned 0 chars and silently left
  // reviews as stubs (Bedlam's Othello 2026-05-27 incident, 6 OB reviews
  // stranded). Verified against /news/review-bedlam-gives-its-trademark-
  // innovative-touch-to-a-top-notch-othello_1835344 → 4386 chars clean.
  ['theatermania.com', /<div[^>]+class="[^"]*news-content[^"]*"[^>]*>([\s\S]*?)<section[^>]+class="[^"]*featured-in-this-story/, 300],
  // Fallback: pre-2026 Drupal-ish layout
  ['theatermania.com', /<div[^>]+class="[^"]*article-body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/article>/, 300],

  // 1minutecritic.com — WordPress, entry-content. Body is followed (still
  // inside entry-content) by inline "related article" teasers shaped like
  // <p><strong>Category &#8211; </strong><a href="https://1minutecritic.com/…">
  // and then the AddToAny share block. Stop at the first related-teaser OR
  // share block. Without this pattern the generic fallback returned ~112 chars
  // (meta description) → every 1minutecritic review saved as a stub and was
  // never scored — missed for Heated Rivalry AND The Maids (2026-05-28).
  // Verified against /heated-rivalry-parody-review → 3110 chars clean.
  // Boundary uses en-dash ONLY (&#8211; / –) — the related-teaser category
  // labels are always en-dash separated. A bare hyphen-minus would over-match
  // a legitimate review paragraph like "<strong>Cast - </strong><a 1mc-link>"
  // and truncate the body to 0 chars (code-review 2026-05-28).
  ['1minutecritic.com', /<div[^>]+class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)(?:<p><strong>[^<]*(?:&#8211;|–)\s*<\/strong>\s*<a href="https:\/\/1minutecritic\.com|<div[^>]+class="[^"]*(?:addtoany_share|related-posts)|<article[^>]+class="[^"]*post-author-area)/, 300],

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

  // Theatrely (theatrely.com) — Webflow CMS. Review body is the Finsweet
  // rich-text block: <div fs-richtext-element="rich-text" class="rich-text-block
  // w-richtext">. Author/meta sit in a separate "post-content-text" box, and a
  // "div-block-34 w-condition-invisible" tickets/related block follows the body.
  // Inline images are <figure><div><img></div></figure>, so a naive "first
  // </div>" boundary truncates mid-article (stopped at 3063 of 5631 chars). The
  // figure's inner </div> is followed by <figcaption>, never <div>, so bounding
  // at "</div> <div" lands exactly on the block's own close — template-agnostic
  // (doesn't depend on the Webflow-numbered div-block-34 class). Before this,
  // theatrely.com returned 0 chars and reviews saved as un-scoreable stubs
  // (Encores! La Cage / Juan A. Ramirez 2026-06-21 — had to be ingested
  // manually). Verified against the La Cage review → 5631 chars clean.
  ['theatrely.com', /<div[^>]+class="[^"]*rich-text-block[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div/, 300],

  // WhatsOnStage (whatsonstage.com) — major West End outlet. Review body lives
  // in <div class="news-content">. Trailing social-share icons, the
  // "featured in this story" section, and article-tags all sit AFTER the body
  // (some inside the same container), so stop at the first of those markers.
  // Without this pattern the generic <article> fallback returned nav chrome /
  // empty text, which made the collector flag real War Horse / etc. reviews as
  // wrongShow ("not a review") — the 2026-06-04 War Horse contamination incident.
  ['whatsonstage.com', /<div[^>]+class="[^"]*news-content[^"]*"[^>]*>([\s\S]*?)<(?:section[^>]+class="[^"]*(?:article-tags|featured-in-this-story)|div[^>]+class="[^"]*social-share-news-icons)/, 300],

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

  // WSJ: modern articles serve full body via __NEXT_DATA__ JSON for
  // authenticated sessions. Plain DOM patterns only catch the lede teaser
  // (~800 chars). Mirror scripts/recover-wsj-subscriber.js extraction.
  if (host.includes('wsj.com')) {
    const wsjText = extractWsjNextData(html);
    if (wsjText && wsjText.length >= 300) return wsjText;
  }

  // Variety: promo modules injected mid-article break the DOM patterns (truncate
  // to ~800 chars). Dedicated extractor strips them and collects review prose.
  if (host.includes('variety.com')) {
    const varietyText = extractVarietyBody(html);
    if (varietyText && varietyText.length >= 300) return varietyText;
  }

  // The Stage: requires subscriber auth; body lives in <p> across multiple
  // aos-DS32-WYSEdit blocks with mid-article promo widgets. Logged-out HTML
  // has no body, so this returns null and the verifier still flags logout.
  if (host.includes('thestage.co.uk')) {
    const stageText = extractStageBody(html);
    if (stageText && stageText.length >= 300) return stageText;
  }

  // Lighting & Sound America: table-based layout, no container div — prose lives
  // in sibling <p><font face="Arial…"> paragraphs (see extractLsaBody).
  if (host.includes('lightingandsoundamerica.com')) {
    const lsaText = extractLsaBody(html);
    if (lsaText && lsaText.length >= 300) return lsaText;
  }

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

/**
 * Extract a review's publish date from page metadata, normalized to
 * YYYY-MM-DD. Tries the standard CMS sources in priority order:
 *   1. <meta property="article:published_time" content="...">  (OpenGraph,
 *      emitted by WordPress + most CMSs)
 *   2. JSON-LD "datePublished"
 *   3. <time datetime="...">  (HTML5 semantic, theme-dependent)
 *
 * Added 2026-05-28: ingest-review-from-url.js previously had NO page-date
 * extraction — it only used the --publish-date CLI arg, so every URL-ingested
 * review without an explicit date got publishDate:undefined (1minutecritic
 * HR + Maids incident). A missing publishDate fails-open through the
 * anticipatory-pre-opening gate and weakens temporal wrong-production
 * detection. These two tags are present on essentially every WordPress/CMS
 * review page, so this one helper fixes the date gap for all outlets ingested
 * via this path.
 *
 * Returns YYYY-MM-DD string or null.
 */
function extractPublishDate(html) {
  if (!html || typeof html !== 'string') return null;
  const candidates = [
    html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i),
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i),
    html.match(/["']datePublished["']\s*:\s*["']([^"']+)["']/),
    html.match(/<time[^>]+datetime=["']([^"']+)["']/i),
    // Theatrely (Webflow) exposes no date meta/time tag — only a visible
    // <div class="publish-date">June 19, 2026 11:15 AM</div>. Last-resort
    // fallback; harmless to other outlets (only fires when all tags above miss).
    html.match(/<div[^>]+class=["'][^"']*publish-date[^"']*["'][^>]*>([^<]+)</i),
  ];
  for (const m of candidates) {
    if (!m || !m[1]) continue;
    // Most sources are ISO 8601 (2026-05-27T02:00:00+00:00) — take the date part.
    const iso = m[1].match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    // Fall back to Date parsing for non-ISO formats.
    const d = new Date(m[1]);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

function extractWsjNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let nextData;
  try { nextData = JSON.parse(m[1]); } catch { return null; }
  const articleData = nextData?.props?.pageProps?.articleData;
  const flattenedBody = articleData?.flattenedBody;
  if (!Array.isArray(flattenedBody)) return null;

  const extractNode = (node) => {
    if (typeof node === 'string') return node;
    if (node && node.content) return node.content.map(extractNode).join('');
    if (node && node.text) return node.text;
    return '';
  };

  let text = '';
  for (const item of flattenedBody) {
    if (item && item.content) {
      const paragraph = item.content.map(extractNode).join('');
      if (paragraph.trim()) text += paragraph.trim() + '\n\n';
    }
  }
  return text.trim() || null;
}

module.exports = { extractArticleText, extractArticleTextFromUrl, extractPublishDate, stripHtml, extractLsaByline };
