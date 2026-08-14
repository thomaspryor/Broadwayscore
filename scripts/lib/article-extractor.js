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

// Common CMS body-container class names, ordered by real-world frequency
// across the per-outlet PATTERNS entries below (entry-content — WordPress —
// dominates). Last-resort fallback for domains with no dedicated pattern:
// see extractByCommonClass.
const GENERIC_CONTENT_CLASSES = [
  'entry-content', 'post-content', 'article-content', 'article-body',
  'content-body', 'story-body', 'articleBody', 'single-content',
  'main-content', 'td-post-content', 'post_content', 'page-content',
  'c-entry-content', 'article__body', 'post-body',
];

/**
 * Balanced-match a <div>'s inner HTML by class name — same depth-counting
 * tag walk as removeBalancedDivBlocks above, but capturing the inner HTML
 * instead of splicing it out. A naive non-greedy `[\s\S]*?</div>` regex
 * would truncate at the first NESTED div's close tag; unknown templates
 * can't be assumed div-shallow the way targeted per-outlet patterns can.
 * Returns the first match's raw inner HTML, or null.
 */
function extractBalancedDivByClass(html, classNeedle) {
  const openRe = new RegExp(
    '<div[^>]*class="[^"]*\\b' + classNeedle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b[^"]*"[^>]*>',
    'i'
  );
  const openM = html.match(openRe);
  if (!openM) return null;
  const start = openM.index + openM[0].length;
  const tagRe = /<div\b[^>]*>|<\/div>/g;
  tagRe.lastIndex = start;
  let depth = 1;
  let m;
  while ((m = tagRe.exec(html))) {
    if (m[0] === '</div>') {
      depth--;
      if (depth === 0) return html.slice(start, m.index);
    } else {
      depth++;
    }
  }
  return null; // unbalanced — bail rather than guess
}

/**
 * BRO-203: article-extractor had no true generic fallback — a domain with no
 * PATTERNS entry (and whose HTML doesn't happen to use <article>/<main>)
 * returned 0 chars, so genuinely-new outlets stayed uncollectable even after
 * ingest-review-from-url.js started auto-deriving a provisional outlet for
 * them (commit 514ed6ccd52). Almost every dedicated pattern added to
 * PATTERNS above turns out to be one of a handful of common CMS content-class
 * names once a human looks (WordPress entry-content overwhelmingly), so try
 * those directly — with balanced div matching — before giving up.
 */
function extractByCommonClass(html) {
  for (const cls of GENERIC_CONTENT_CLASSES) {
    const inner = extractBalancedDivByClass(html, cls);
    if (!inner) continue;
    const text = stripHtml(inner);
    if (text.length >= 300) return text;
  }
  return null;
}

/**
 * Absolute last resort (BRO-203): no known wrapper — dedicated or common-class
 * — matched anything. Strip obvious chrome blocks (nav/header/footer/form),
 * then collect every remaining <p> with real prose. Noisier than the
 * class-based passes above (can pull in a stray related-post teaser), but
 * this only fires for domains with zero prior signal, and downstream
 * scoreability checks (ensemble LLM / url_content_mismatch gate) already
 * treat any freshly-extracted new-outlet text as unverified — some noise
 * beats the current guaranteed 0 chars.
 */
function extractByParagraphDensity(html) {
  const trimmed = html
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ');
  const paras = [...trimmed.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripHtml(m[1]))
    .filter((t) => t.length > 40 && /[a-z]/i.test(t));
  const body = paras.join('\n\n');
  return body.length >= 300 ? body : null;
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
    /Related Articles|More from this Author|Login Register/i.test(t) ||
    // Newsletter-signup CTA — trailing paragraph, not part of the review, but
    // with no closing punctuation of its own it makes detectTruncationSignals()
    // misread a genuinely complete review as truncated (task #876, confirmed
    // live on archduke-west-end-2026 / burlesque-west-end-2026 recoveries).
    /sign up to The Stage.s weekly reviews newsletter/i.test(t);
  const paras = [...region.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
    .map((m) => stripHtml(m[1]))
    .filter((t) => t.length > 40 && /[a-z]/.test(t) && !isTrailingNoise(t));
  const body = paras.join('\n\n');
  return body.length >= 300 ? body : null;
}

/**
 * The Times / The Sunday Times (thetimes.com / thetimes.co.uk) — subscriber-only.
 * The article body sits inside `<article id="article-main">` as a flat run of
 * `<p id="{uuid}">` tags (WordPress block content, each block gets a real
 * v4-style UUID id) interleaved with unrelated chrome that does NOT carry a
 * UUID id: a sidebar "quizle" question (`id="article-quizle-question"`), a
 * cookie-consent placeholder (`class="times-embed-placeholder__message"`), a
 * newsletter-signup box (no id/class), and a "Promoted Content" block. Filtering
 * to `<p id="{uuid}">` alone cleanly isolates the review prose without any
 * content-based noise heuristics — verified live 2026-08-03 against
 * 1536-review-theatre-henry-viii-anne-boleyn-v6hg7frjb (logged in → 2799 chars,
 * 7 paragraphs, lede through star rating; logged out → 0 matches, correctly
 * flags a dead session).
 */
function extractTimesBody(html) {
  const startM = html.match(/<article[^>]*id="article-main"[^>]*>/);
  if (!startM) return null;
  const endM = html.slice(startM.index).match(/data-testid="article-comments"/);
  const region = html.slice(startM.index, startM.index + (endM ? endM.index : 60000));
  const uuidId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const paras = [...region.matchAll(/<p[^>]*\bid="([^"]*)"[^>]*>([\s\S]*?)<\/p>/g)]
    .filter((m) => uuidId.test(m[1]))
    .map((m) => stripHtml(m[2]))
    .filter((t) => t.length > 40 && /[a-z]/i.test(t));
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

/**
 * La Voce di New York (lavocedinewyork.com) — Jannah/JNews WordPress theme.
 * No DOM class is stable across templates (verified: no entry-content,
 * post-content, or jeg_inner_content wrapper on live pages), so every
 * generic pattern returned ~117 chars of nav/meta chrome and the review
 * saved as a silent stub (Hungry Women twi-ny/lavoce recovery, #1342). The
 * page DOES embed the full body in a JSON-LD Article entity's articleBody
 * field. Parse that block directly instead of regexing the HTML — safer
 * than a DOM guess since it's the site's own structured data. Verified
 * against 2 live reviews (Hungry Women 4098 chars, Blackout Songs 3900+
 * chars) — both matched cleanly with zero related-article bleed.
 *
 * Scoped like extractPublishDate's JSON-LD step (this file already hit the
 * "grabbed a different embedded article" bug once for dates — see the
 * canonical-URL comment below): only consider Article-type entities
 * (isArticleType/ARTICLE_LD_TYPES, declared later in this file but hoisted),
 * and only trust the result when exactly ONE such entity carries a body —
 * a page with a related-post Article block alongside the real one returns
 * null here rather than guessing which is which.
 */
function extractLaVoceBody(html) {
  const candidates = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let parsed;
    try { parsed = JSON.parse(m[1].trim()); } catch { continue; }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const entity of list) {
      if (entity && isArticleType(entity['@type']) && typeof entity.articleBody === 'string'
        && entity.articleBody.length >= 300) {
        candidates.push(entity.articleBody);
      }
    }
  }
  if (candidates.length !== 1) return null;
  const text = stripHtml(candidates[0]);
  return text.length >= 300 ? text : null;
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
  // Telegraph — never had an extractor pattern (task #720 added it to WE
  // discovery but extraction was never built), so every telegraph.co.uk
  // review silently saved as a stub even though the free cookie-plain fetch
  // returns full HTML with the full review text (verified live 2026-08-02:
  // plain fetchPage() returns 250K+ char pages, no paywall gate — the
  // subscription cancellation on 2026-07-21 did not break access to review
  // text, only the extraction pattern was missing). Stop at the literal
  // "Join the conversation" comments-section marker; any trailing
  // "Recommended…" promo-module chrome that leaks through is caught by
  // stripTrailingJunk() in the downstream collection/recovery pipeline,
  // same as every other outlet pattern below.
  ['telegraph.co.uk', /<div[^>]+class="[^"]*article-body-text[^"]*"[^>]*>([\s\S]*?)Join the conversation/i, 500],

  // NYT — section[name="articleBody"] is the primary
  ['nytimes.com', /<section[^>]+name="articleBody"[^>]*>([\s\S]*?)<\/section>/, 500],
  ['nytimes.com', /<div[^>]+itemprop="articleBody"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/, 500],

  // New Yorker
  ['newyorker.com', /<div[^>]+class="[^"]*body__inner-container[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<aside/, 500],
  ['newyorker.com', /<div[^>]+data-testid="(?:BodyWrapper|ArticleBodyWrapper)"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/, 500],

  // Variety — c-content wrapper
  ['variety.com', /<div[^>]+class="[^"]*c-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/article>/, 500],
  ['variety.com', /<div[^>]+class="[^"]*a-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/article>/, 500],

  // liamodell.com (WordPress.com) — entry-content; generic fallback got 122
  // chars on the 2026-07-31 Tao of Glass review (deaf culture + theatre
  // critic, cited in WE coverage). Same entry-content shape as NYSR below.
  // Chrome-aware pattern FIRST (first-match-wins loop; see newyorktheater.me
  // note above — the loose fallback would otherwise pull Jetpack share/related
  // chrome into the body).
  ['liamodell.com', /<div[^>]+class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<div[^>]+(?:id="jp-post-flair"|class="[^"]*(?:sharedaddy|jp-relatedposts|sd-sharing|sd-like)[^"]*")/, 300],
  ['liamodell.com', /<div[^>]+class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/article>/, 300],

  // NYSR (WordPress) — entry-content
  ['nystagereview.com', /<div[^>]+class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/article>/, 300],

  // on-magazine.co.uk (On: Yorkshire Magazine, WordPress + Bunyad theme) — body
  // lives in .article-content, NOT entry-content, so every generic fallback
  // returned 0 chars and the review landed as a silent stub (Car Man / Sheffield
  // Lyceum, task #874). Stop at the author-box / post-nav / related-posts chrome
  // so the "you may also like" teaser headlines don't get scored as review prose.
  ['on-magazine.co.uk', /<div[^>]+class="[^"]*article-content[^"]*"[^>]*>([\s\S]*?)<div[^>]+class="[^"]*(?:saboxplugin|s-post-nav|bk-related-posts)[^"]*"/, 300],
  ['on-magazine.co.uk', /<div[^>]+class="[^"]*article-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/article>/, 300],

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

  // jonathanbaz.com — Blogger/Blogspot: body lives in .post-body (single-quoted
  // class attrs), followed by .post-footer. Blogger templates share this shape,
  // so match either quote style.
  ['jonathanbaz.com', /<div[^>]+class=["'][^"']*post-body[^"']*["'][^>]*>([\s\S]*?)<div[^>]+class=["'][^"']*post-footer/, 300],

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
  // bachtrack.com — body (.pcm-walled-full > .article-body, 11+ <p>) renders only in a
  // real browser (registration-wall JS unlocks it; 5 free articles/session). bachtrack is
  // in PLAYWRIGHT_FIRST_DOMAINS so rendered HTML contains .article-body; try it first,
  // stopping at the trailing star-rating / social-share blocks. Class anchor must be
  // EXACT ("article-body") — a substring match also hits the outer
  // .article-body-wrapper, whose first <p> is the registration banner. Verified
  // 2026-07-13 (Madama Butterfly review → 11 paragraphs, ~4300 chars).
  ['bachtrack.com', /<div[^>]+class="article-body"[^>]*>([\s\S]*?)<div[^>]+class="[^"]*(?:article-rating|social-holder)/, 300],
  // Fallback for shell HTML (BD/SB fetches): meta description only. The S6
  // star-rating skip handles ensemble bypass for these stubs.
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

  // pagesonstages.com — WordPress.com (Jetpack), entry-content. Body is a run of
  // <p class="wp-block-paragraph"> blocks; a "<hr class="wp-block-separator">"
  // consistently marks the end of the review prose, right before the "Thank you
  // for reading…" sign-off and an inline Jetpack subscribe-block widget (itself
  // followed by more nested <div>s for the social-links paragraph). Stopping at
  // that <hr> avoids having to balance those nested divs. Verified against 3
  // live reviews (Birthright/Small/Ragtime, 2026-08-10) → 5494/3043/3270 chars,
  // clean start-to-"I attended this performance on a press pass" end, no bleed.
  ['pagesonstages.com', /<div[^>]+class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<hr[^>]+class="[^"]*wp-block-separator/, 300],
  // Fallback for posts without the press-pass disclosure hr (older/rare shape):
  // stop at the Jetpack subscribe widget div instead.
  ['pagesonstages.com', /<div[^>]+class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<div[^>]+class="[^"]*wp-block-jetpack-subscriptions/, 300],

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
// Hosts with dedicated non-PATTERNS extraction above (WSJ/Variety/LSA check-
// and-conditionally-fall-through; LaVoce/Stage/Times return unconditionally).
// BRO-203's new common-class/paragraph-density fallbacks below must NEVER
// run for these — they're a "known outlet whose extraction failed this
// specific fetch" (paywall logout, page-shape drift), not a "genuinely
// unknown domain" in the sense this task is scoped to. WSJ/Variety/LSA fall
// through their own conditional return into the PATTERNS loop by design (a
// dedicated PATTERNS entry may still match), but must stop there — same
// "dead session mistaken for a successful recovery" risk the Stage/Times
// unconditional-return fix above exists to prevent (ship-check task #919).
const DEDICATED_EXTRACTOR_HOSTS = [
  'wsj.com', 'variety.com', 'lavocedinewyork.com', 'thestage.co.uk',
  'thetimes.co.uk', 'thetimes.com', 'lightingandsoundamerica.com',
];

function extractArticleText(html, hostname) {
  if (!html || typeof html !== 'string') return null;
  const host = String(hostname || '').replace(/^www\./, '').toLowerCase();
  const isDedicatedHost = DEDICATED_EXTRACTOR_HOSTS.some((d) => host.includes(d));

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

  // La Voce di New York: no stable DOM wrapper across templates; pull the
  // JSON-LD articleBody instead (see extractLaVoceBody above). Returns null
  // explicitly on failure — same reasoning as Stage/Times below: falling
  // through to the generic <article>/<main> patterns risks saving page
  // chrome or a related-post card as a plausible 300+ char "body".
  if (host.includes('lavocedinewyork.com')) {
    return extractLaVoceBody(html);
  }

  // The Stage: requires subscriber auth; body lives in <p> across multiple
  // aos-DS32-WYSEdit blocks with mid-article promo widgets. Logged-out HTML
  // has no body, so this returns null and the verifier still flags logout.
  // Returns null explicitly (not falls through to the generic <article>/<main>
  // patterns below) — ship-check adversarial review (task #919, 2026-08-03)
  // found that falling through lets the generic pattern grab non-review page
  // chrome (headline/standfirst/nav) that clears its own 300-char floor,
  // silently defeating the "logout returns null" guarantee this comment
  // claims and letting a dead session look like a successful recovery.
  if (host.includes('thestage.co.uk')) {
    const stageText = extractStageBody(html);
    return stageText && stageText.length >= 300 ? stageText : null;
  }

  // The Times / Sunday Times: requires subscriber auth; body paragraphs carry
  // a UUID id, unlike surrounding chrome (quizle, newsletter box, promoted
  // content). Logged-out HTML has zero UUID-id paragraphs. Returns null
  // explicitly for the same reason as thestage above — verified live: the
  // generic <article> fallback returns 316 chars of headline+quizle text on
  // a real logged-out thetimes.com page, which clears its 300-char floor and
  // would otherwise be mistaken for a successful recovery.
  if (host.includes('thetimes.co.uk') || host.includes('thetimes.com')) {
    const timesText = extractTimesBody(html);
    return timesText && timesText.length >= 300 ? timesText : null;
  }

  // Lighting & Sound America: table-based layout, no container div — prose lives
  // in sibling <p><font face="Arial…"> paragraphs (see extractLsaBody).
  if (host.includes('lightingandsoundamerica.com')) {
    const lsaText = extractLsaBody(html);
    if (lsaText && lsaText.length >= 300) return lsaText;
  }

  let matchedDedicatedPattern = false;
  for (const [hostMatch, re, minLen] of PATTERNS) {
    if (hostMatch && !host.includes(hostMatch)) continue;
    if (hostMatch) matchedDedicatedPattern = true;
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

  // Nothing above matched — try the common-CMS-class and paragraph-density
  // fallbacks (BRO-203) before giving up, but ONLY for genuinely unknown
  // domains: no dedicated extractor branch (isDedicatedHost) and no matching
  // PATTERNS entry (matchedDedicatedPattern). Known outlets whose dedicated
  // extraction failed this fetch (WSJ paywall logout, a page-shape drift on
  // an outlet with a PATTERNS entry) must still return null here — same
  // "dead session mistaken for a successful recovery" risk the Stage/Times
  // unconditional-return fix above exists to prevent (ship-check task #919,
  // adversarial review 2026-08-14 caught this falling-through for WSJ).
  if (isDedicatedHost || matchedDedicatedPattern) return null;
  const commonClassText = extractByCommonClass(html);
  if (commonClassText) return commonClassText;
  return extractByParagraphDensity(html);
}

/**
 * Convenience: derive hostname from URL and call extractArticleText.
 */
function extractArticleTextFromUrl(html, url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* fall through with empty host */ }
  return extractArticleText(html, host);
}

/** Normalize a raw date string to YYYY-MM-DD (or null). */
function normalizeDate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Most sources are ISO 8601 (2026-05-27T02:00:00+00:00) — take the date part
  // verbatim (do NOT UTC-convert; the source's local calendar date is what we want).
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  // Fall back to Date parsing for non-ISO formats (e.g. "June 19, 2026 11:15 AM").
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

/** Canonicalize a URL for loose equality: drop protocol/query/fragment/www, trailing slash, lowercase. */
function normalizeUrlForMatch(u) {
  if (!u || typeof u !== 'string') return null;
  return u
    .replace(/[#?].*$/, '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '')
    .toLowerCase() || null;
}

/**
 * The page's own canonical URL, so JSON-LD entities can be matched against it.
 * Prefers an explicitly-passed fetch URL, then <link rel="canonical">, then og:url.
 */
function pageCanonicalUrl(html, url) {
  const fromLink = (html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i) || [])[1];
  const fromOg = (html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i) || [])[1];
  return normalizeUrlForMatch(url) || normalizeUrlForMatch(fromLink) || normalizeUrlForMatch(fromOg);
}

const ARTICLE_LD_TYPES = new Set([
  'article', 'newsarticle', 'reportagenewsarticle', 'analysisnewsarticle',
  'reviewnewsarticle', 'review', 'blogposting', 'liveblogposting',
]);

/** True if a JSON-LD @type (string or array) names an article-like entity. */
function isArticleType(type) {
  const list = Array.isArray(type) ? type : [type];
  return list.some((t) => typeof t === 'string' && ARTICLE_LD_TYPES.has(t.toLowerCase()));
}

/** Recursively collect article-like entities (with a datePublished) from parsed JSON-LD. */
function collectArticleEntities(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const el of node) collectArticleEntities(el, out); return; }
  if (Array.isArray(node['@graph'])) collectArticleEntities(node['@graph'], out);
  if (isArticleType(node['@type']) && node.datePublished) out.push(node);
}

/** The URL(s) a JSON-LD entity claims to be the main entity of / located at. */
function entitySelfUrls(entity) {
  const urls = [];
  const push = (v) => { if (typeof v === 'string') urls.push(v); else if (v && typeof v === 'object') { if (typeof v['@id'] === 'string') urls.push(v['@id']); if (typeof v.url === 'string') urls.push(v.url); } };
  push(entity.mainEntityOfPage);
  push(entity.url);
  push(entity['@id']);
  return urls.map(normalizeUrlForMatch).filter(Boolean);
}

/**
 * Extract a review's publish date from page metadata, normalized to YYYY-MM-DD.
 * Priority (deliberately scoped to the MAIN article — see 2026-07-11 fix below):
 *   1. <meta property="article:published_time">  (OpenGraph — always page-level,
 *      never a related article; highest trust)
 *   2. JSON-LD: parse ALL ld+json blocks and prefer the article-like entity
 *      (NewsArticle/Review/Article/…) whose mainEntityOfPage/url/@id matches the
 *      page's own canonical URL. This is the fix for the related-article bug.
 *   3. First-match fallback (document-wide datePublished / <time datetime>) —
 *      ONLY when the document carries a single distinct candidate date, so an
 *      embedded related article's date can never win by document order.
 *   4. Visible <div class="publish-date"> (Theatrely/Webflow, no meta/time tag).
 *
 * Added 2026-05-28: ingest-review-from-url.js previously had NO page-date
 * extraction — it only used the --publish-date CLI arg, so every URL-ingested
 * review without an explicit date got publishDate:undefined (1minutecritic
 * HR + Maids incident). A missing publishDate fails-open through the
 * anticipatory-pre-opening gate and weakens temporal wrong-production detection.
 *
 * Scoped 2026-07-11: the old step 2/3 took the FIRST document-wide datePublished
 * / <time> match. Aggregator + outlet pages embed related-article JSON-LD, so
 * when og:published_time is absent that first match could be a DIFFERENT
 * article's date. Two safety systems consume this: the gap-audit production-
 * identity gate (a misdate marks a current article priorRun, permanently
 * blocking its URLs) and publishDate stamping feeding flag-wrong-production-by-
 * date (care-west-end-2026 false flag). `url` is the page's fetch URL when the
 * caller has it (self-derived from <link canonical>/og:url otherwise).
 *
 * Returns YYYY-MM-DD string or null.
 */
function extractPublishDate(html, url) {
  if (!html || typeof html !== 'string') return null;

  // 1. OpenGraph published_time — page-level, never a related article.
  const og = normalizeDate((html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i) || [])[1]);
  if (og) return og;

  // 2. JSON-LD scoped to the main article by canonical-URL match.
  const canonical = pageCanonicalUrl(html, url);
  const entities = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let parsed;
    try { parsed = JSON.parse(m[1].trim()); } catch { continue; }
    collectArticleEntities(parsed, entities);
  }
  if (entities.length) {
    if (canonical) {
      const main = entities.find((e) => entitySelfUrls(e).includes(canonical));
      if (main) { const d = normalizeDate(main.datePublished); if (d) return d; }
    }
    // No canonical, or no entity self-identifies with it: only trust JSON-LD when
    // every article entity agrees on one date (an unambiguous single-article page).
    const ldDates = [...new Set(entities.map((e) => normalizeDate(e.datePublished)).filter(Boolean))];
    if (ldDates.length === 1) return ldDates[0];
  }

  // 3. First-match fallback — safe only when the document has ONE distinct date.
  const rawDates = [];
  for (const re of [/["']datePublished["']\s*:\s*["']([^"']+)["']/g, /<time[^>]+datetime=["']([^"']+)["']/gi]) {
    for (const m of html.matchAll(re)) { const d = normalizeDate(m[1]); if (d) rawDates.push(d); }
  }
  const distinct = [...new Set(rawDates)];
  if (distinct.length === 1) return distinct[0];

  // 4. Theatrely (Webflow) exposes no date meta/time/JSON-LD — only a visible
  // <div class="publish-date">June 19, 2026 11:15 AM</div>. Inherently single.
  const divDate = normalizeDate((html.match(/<div[^>]+class=["'][^"']*publish-date[^"']*["'][^>]*>([^<]+)</i) || [])[1]);
  if (divDate) return divDate;

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
