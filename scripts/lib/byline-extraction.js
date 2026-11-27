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
const { parseJsonLd } = require('./jsonld');
const { decodeHtmlEntities } = require('./text-cleaning');
const { CMS_ADMIN_HANDLE_RE } = require('./byline-recovery');
const { extractBylineFromText, printedOutletByline, sameCriticName } = require('./byline-from-text');

function isCmsAccountName(name) {
  return CMS_ADMIN_HANDLE_RE.test(name) || /^(editor|staff|webmaster)$/i.test(name);
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
  const name = decodeHtmlEntities(m[1]).replace(/\s+/g, ' ').trim();
  if (NOT_A_PERSON_RE.test(name)) return null;
  if (name.split(' ').some((w) => w.replace(/[.'’-]/g, '').length < 2)) return null;
  return name;
}

// Reviews that name the critic in a "Reviewed on 20th October 2026 / by Jonathan Evans" heading pair
// (The Spy in the Stalls: meta author and rel=author are the site account "thespyinthestalls").
// The tags between "Reviewed on <date>" and "by <Name>" are collapsed so the credit may sit in one
// element or two. Credits that run on ("by Jonathan Evans Photography by Helen Maybanks") stop at
// the first photo/picture word.
const REVIEWED_BY_NAME = String.raw`[A-Z][A-Za-zÀ-ÿ'’-]+(?:\s+[A-Z][A-Za-zÀ-ÿ'’-]*\.?){1,2}`;
const REVIEWED_BY_RE = new RegExp(String.raw`(?:^|\|)\s*Reviewed(?:\s+on\s+(?:(?!\bby\b)[^|]){3,40}?)?\s*(?:\|[\s|]*|\s+)by\s+(${REVIEWED_BY_NAME}?)\s*(?=\||$|\s+(?:Photo|Picture|Image|Pic)s?(?:graphy)?\b)`);
function extractReviewedByLine(html) {
  if (!html) return null;
  const flat = decodeHtmlEntities(String(html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, '|')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/[ \t]+/g, ' '));
  const m = REVIEWED_BY_RE.exec(flat);
  if (!m) return null;
  const name = m[1].replace(/\s+/g, ' ').trim();
  if (NOT_A_PERSON_RE.test(name)) return null;
  return name;
}

// Musical Theatre Review signs each review with a right-aligned bold-italic name just before the
// share widget, while its page author is the shared "Admin" account:
//   <p style="text-align: right;"><strong><em>Scott Matthewman</em></strong></p>\nSHARE THIS POST:
const MTR_SIGN_OFF_RE = /<p\b[^>]*>\s*(?:<(?:strong|em|b|i)\b[^>]*>\s*){1,2}([A-Z][A-Za-zÀ-ÿ'’-]+(?:\s+[A-Z][A-Za-zÀ-ÿ'’-]+){1,2})\s*(?:<\/(?:strong|em|b|i)>\s*){1,2}<\/p>\s*SHARE THIS POST/i;
function extractSignOffBeforeShare(html) {
  if (!html) return null;
  const m = MTR_SIGN_OFF_RE.exec(String(html));
  if (!m) return null;
  const name = decodeHtmlEntities(m[1]).replace(/\s+/g, ' ').trim();
  if (NOT_A_PERSON_RE.test(name)) return null;
  return name;
}

// BRO-4475: BroadwayWorld's meta/author markup can carry the author PAGE URL
// (broadwayworld.com/author/...) as the value; a name is never an href.
const PUBLISHER_RE = /^(?:cond[eé] nast|the new yorker$|plasa media|dotdash meredith|vox media|penske media|gannett|hearst)\b/i;
// Prose-shaped candidates ("By Name", "<b>--Name</b>") also match nav and
// rating text ("By Date", "By The Numbers", "--Highly Recommended"), so their
// capture must look like a name: every word capitalised, no house words.
// Multi-author bylines ("By Meg Masseron, Logan Culwell-Block", "By A B &amp;
// C D", "By A B and C D") yield the FIRST full name: the lookahead accepts a
// following ',' or '&', and a captured " and " tail is cut in extractByline.
// Without the ',' / '&' stops the capture backtracked to the first word only
// ("Meg") because "<word> <Capital>" was the only shape the lookahead allowed.
const INLINE_BY_RE = />[Bb]y:?\s+([A-Z][A-Za-z](?:[A-Za-z .'’-]|&rsquo;|&#8217;){1,38})(?=\s*[<\/,&]|\s+(?:[A-Z]|—))/;
// A paragraph that is only the printed credit, "Review by Stuart Miller . . ." (Theater Pizzazz,
// Seven Guitars 2026-11-23: meta and RSS name the site account, so the record said Unknown). The
// whole element must be the credit (optional trailing ". . ." / "…"), so body prose that mentions
// "a review by X" mid-sentence never matches.
// Must open a <p> (a sidebar teaser is an <a>/<h3>), and every whitespace run is bounded so a long
// run of spaces with no closing tag cannot backtrack quadratically (ship-check of BRO-8242).
const REVIEW_BY_NAME_WORD = String.raw`[A-ZÀ-Þ](?:[A-Za-zÀ-ɏ'’-]|&#8217;|&#x2019;|&rsquo;|&#39;|\.(?=[A-Z]))*\.?`;
const REVIEW_BY_PARA_RE = new RegExp(String.raw`<p\b[^>]*>[ \t\n]{0,10}Review by[ \t\n]{1,5}(${REVIEW_BY_NAME_WORD}(?:[ \t\n]{1,5}${REVIEW_BY_NAME_WORD}){1,3}?)[ \t\n]{0,5}(?:(?:\.[ \t]{0,3}){2,5}|…|&#8230;|&hellip;)?[ \t\n]{0,10}<`);
const SIGN_OFF_RE = /<b>\s*(?:--|—)\s*([A-Z][A-Za-z.'’ -]{3,40}?)\s*<\/b>/;
const PROSE_NOT_A_NAME_RE = /\b(?:date|dates|numbers?|name|title|category|categories|price|popularity|rating|ratings|recommended|highly|stars?|sunday|monday|tuesday|wednesday|thursday|friday|saturday|january|february|march|april|june|july|august|september|october|november|december)\b/i;
function looksLikeProseName(name) {
  if (NOT_A_PERSON_RE.test(name) || PROSE_NOT_A_NAME_RE.test(name)) return false;
  const words = name.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 4 && words.every((w) => /^[A-Z]/.test(w));
}
const URL_LIKE_RE = /^(?:https?:)?\/\/|^www\.|^\/[a-z]|\.(?:com|co\.uk|org|net)\/|\/author\//i;

const DOMAIN_LIKE_RE = /\.(?:com|co\.uk|org|net)\b/i;

/**
 * Author name from schema.org JSON-LD (`"author": {"@type":"Person","name":..}`,
 * object, array or bare string). Only Person-typed (or untyped) authors; never
 * a URL, domain, organisation or house name (NOT_A_PERSON_RE).
 */
function extractJsonLdAuthor(html) {
  // Unquoted type attribute too: USA Today prints <script type=application/ld+json> (BRO-7780).
  const blocks = String(html).match(/<script[^>]+type=["']?application\/ld\+json["']?[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const block of blocks) {
    // Shared parser (scripts/lib/jsonld.js, required by audit-jsonld-graph.test.mjs): top-level
    // arrays AND @graph nodes, in document order. The walk below also descends into nested
    // objects, so this is the same answer as the hand parse it replaced.
    const items = parseJsonLd(block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, ''));
    if (!items.length) continue;
    // BRO-3414: Yoast's @graph gives the article `"author": {"@id": ...}`
    // and the Person (with its name) as a separate node. Resolve the
    // reference so the article's own author wins over page chrome (a
    // theaterscene "authors" sidebar credited its editor on every review).
    const byId = new Map();
    for (const n of items) if (n['@id']) byId.set(n['@id'], n);
    const queue = [...items];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) { queue.push(...node); continue; }
      if (node.author) {
        for (let a of [].concat(node.author)) {
          if (a && typeof a === 'object' && !a.name && a['@id'] && byId.has(a['@id'])) a = byId.get(a['@id']);
          if (a && typeof a === 'object' && a['@type'] && !/^Person$/i.test([].concat(a['@type'])[0])) continue;
          const raw = typeof a === 'string' ? a : a && a.name;
          if (typeof raw !== 'string') continue;
          const name = stripBylineSuffixes(decodeHtmlEntities(raw).trim());
          if (!name || name.length < 2 || name.length > 80 || !/[A-Za-z]/.test(name)) continue;
          if (URL_LIKE_RE.test(name) || DOMAIN_LIKE_RE.test(name) || NOT_A_PERSON_RE.test(name) || PUBLISHER_RE.test(name) || isPublicationName(name) || isCmsAccountName(name)) continue;
          return name;
        }
      }
      if (node['@graph']) queue.push(node['@graph']);
    }
  }
  return null;
}

// BRO-6716: a lowercase "by" right after an inline closing tag is body prose
// ("Splendidly <a>designed </a>by Hildegard Bechtler"), not a byline; skip it and
// keep looking, so a real "By Name" later in the page still counts.
function firstInlineByline(html) {
  const re = new RegExp(INLINE_BY_RE.source, INLINE_BY_RE.flags.replace('g', '') + 'g');
  for (const m of html.matchAll(re)) {
    const prose = /^>by\b/.test(m[0]) && /<\/(?:a|em|strong|i|b)\s*$/i.test(html.slice(Math.max(0, m.index - 12), m.index));
    if (!prose) return m;
  }
  return null;
}

/**
 * All That Dazzles (Wix) prints the critic as a bold "Review by Daz Gale" paragraph at the top of
 * the post body, while its JSON-LD author is the site itself ("All That Dazzles") and the stored
 * text drops that paragraph (BRO-5572: 195 files filed as "All That Dazzles", 49 as Unknown).
 * Read only inside the post body (data-hook="post-description" up to </article>), so a
 * related-post teaser elsewhere on the page can never supply the name, and only from the body's
 * first 600 characters, where the credit sits. The name check is the text reader's
 * (extractAllThatDazzlesByline), so page and text agree on what counts as a person.
 */
function extractAllThatDazzlesPageByline(html) {
  if (!html) return null;
  const s = String(html);
  const start = s.indexOf('data-hook="post-description"');
  if (start < 0) return null;
  const end = s.indexOf('</article>', start);
  const body = s.slice(start, end < 0 ? undefined : end)
    .replace(/^[^>]*>/, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(?:p|div|h[1-6]|li)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ');
  const flat = decodeHtmlEntities(body).replace(/[ \t]+/g, ' ').replace(/\n\s*/g, '\n').trimStart().slice(0, 600);
  const hit = extractBylineFromText('all-that-dazzles-uk', flat);
  return hit && hit.known ? hit.name : null;
}

function extractByline(html, { outletId, text } = {}) {
  if (!html) return null;
  // The printed credit beats the site-named JSON-LD author at All That Dazzles (see above).
  if (outletId === 'all-that-dazzles-uk' || outletId === 'all-that-dazzles') {
    const atd = extractAllThatDazzlesPageByline(html);
    if (atd) return atd;
  }
  const reviewer = extractReviewerLine(html) || extractReviewedByLine(html) || extractSignOffBeforeShare(html);
  if (reviewer) return reviewer;
  // TheaterMania's visible author tag beats its JSON-LD, which names the account that POSTED the
  // article (editor David Gordon, BRO-7745/BRO-7780). Read without a url: the id is TM's own.
  const tmTag = extractTheaterManiaAuthorTag(html);
  if (tmTag) return tmTag;
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
    // A class="author" wrapper holding "by&nbsp;<a href=/user/N>Name</a>" (The Arts Desk,
    // BRO-6716). Before INLINE_BY_RE, which read "designed </a>by Hildegard Bechtler" in the body.
    // Arts Desk only: elsewhere a bare class="author" link can be a teaser list or a comment.
    outletId === 'artsdesk' && /<(?:span|div|p)[^>]+class=["'](?:[^"']*\s)?author(?:\s[^"']*)?["'][^>]*>\s*(?:by(?:&nbsp;|\s|\u00a0)+)?<a[^>]*>([^<]+)<\/a>/i,
    // Condé Nast (verso) bylines: <span>By </span><a class="byline__name-link">
    // Name</a>. Its meta author is the publisher (BRO-3414).
    /<a[^>]+class=["'][^"']*byline__name-link[^"']*["'][^>]*>([^<]+)<\/a>/i,
    // Inline "By Name" prose near top of article — FMJ-style "By Ross" right
    // after the headline. Capture follows the literal "By " token. The name
    // class accepts the curly apostrophe (’) and its entity forms (&rsquo;,
    // &#8217;) so "Holly O’Mahony" is captured whole instead of stopping at
    // "Holly O" (audit S7-T4).
    // "By:" and a name closed straight by a tag ("By Isa Goldberg</p>",
    // theaterlife) are accepted; the old lookahead needed whitespace first,
    // so the capture backtracked to the first name only (BRO-3414).
    INLINE_BY_RE,
    // Scoped like the artsdesk rule: unscoped, a sidebar teaser "<a>Review by X</a>" on any outlet would
    // read as the byline (second-opinion review of BRO-8242).
    (outletId === 'theater-pizzazz' || outletId === 'theatre-pizzazz') && REVIEW_BY_PARA_RE,
    // <a rel="author"> — before the nested-author-name fallback below because
    // an explicit rel="author" is a stronger signal than a bare class name.
    /<a[^>]+rel=["']author["'][^>]*>([^<]+)<\/a>/i,
    // Lighting & Sound America signs off in bold: "<b>--David Barbour</b>";
    // its meta author is the publisher, PLASA Media (BRO-3414).
    SIGN_OFF_RE,
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
  ].filter(Boolean);
  for (const re of candidates) {
    const m = re === INLINE_BY_RE ? firstInlineByline(html) : html.match(re);
    if (m && m[1]) {
      let name = decodeHtmlEntities(m[1]).trim();
      // Strip Jetpack-style "View all posts by X" prefix that leaks through
      // some <a rel=author> matches.
      name = name.replace(/^(?:view\s+all|see\s+all|read\s+more|more)\s+(?:posts|articles|stories|reviews)\s+by\s+/i, '');
      // Strip what rides along with the name at capture time — ", Chief
      // Theatre Critic", "(she/her)", "<br>" / a stray ">" — so the stored
      // criticName is the person (audit S7-T4). Shared with
      // normalizeBylineCapture; one implementation.
      name = stripBylineSuffixes(name);
      if (!name || name.length < 2 || name.length > 80 || !/[A-Za-z]/.test(name)) continue;
      // The uploader account is not a critic. Continue to the printed credit
      // rather than letting meta/rel=author win (BRO-5317).
      if (isCmsAccountName(name)) continue;
      if (URL_LIKE_RE.test(name)) continue;
      // A publisher or house byline is not a critic (New Yorker meta author
      // "Condé Nast", house byline "The New Yorker", BRO-3414); fall through.
      if (PUBLISHER_RE.test(name) || isPublicationName(name)) continue;
      // A bare "By" preamble span read as the name (BRO-3414).
      if (/^by:?$/i.test(name)) continue;
      if (re === INLINE_BY_RE) {
        name = name.split(/\s+and\s+/)[0].trim();
        // A one-word capture that stopped at ',' / '&' is a sort or filter
        // widget ("By Relevance, Date", "By Newest, Oldest"), not a co-author list.
        if (!/\s/.test(name) && /^\s*[,&]/.test(html.slice(m.index + m[0].length))) continue;
      }
      // "Review by Stuart Miller..." leaves the first dot on the last word; an initial ("J.") keeps it.
      if (re === REVIEW_BY_PARA_RE) name = name.replace(/([A-Za-z\u00C0-\u024F'’-]{2,})\.$/, (m, w) => (/^(?:Jr|Sr)$/.test(w) ? m : w));
      if ((re === INLINE_BY_RE || re === SIGN_OFF_RE || re === REVIEW_BY_PARA_RE) && !looksLikeProseName(name)) continue;
      // Capitalize lowercase author slugs from class="author-name" (e.g. "ross" → "Ross").
      if (/^[a-z][a-z\s.'’-]*$/.test(name)) {
        name = name.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      }
      return name;
    }
  }
  const printed = extractBylineFromText(outletId, text);
  return printed && printed.known ? printed.name : null;
}

// TheaterMania's visible byline: <a id="article-author-tag" href=".../authors/<slug>">Name</a>
// inside <p class="author-name">. The id is TheaterMania's own, so this needs no url. Its JSON-LD
// author is the account that POSTED the article (often editor David Gordon), BRO-7745.
const TM_AUTHOR_TAG_RE = /<a\b[^>]*\bid=["']article-author-tag["'][^>]*>([^<]+)<\/a>/i;
function extractTheaterManiaAuthorTag(html) {
  if (!html) return null;
  const m = TM_AUTHOR_TAG_RE.exec(String(html));
  if (!m) return null;
  const name = stripBylineSuffixes(decodeHtmlEntities(m[1]).replace(/\s+/g, ' ').trim());
  return name && !NOT_A_PERSON_RE.test(name) ? name : null;
}

// The structured author the CMS declares: JSON-LD Person, meta author, or (TheaterMania) the
// WordPress author slug in the JSON-LD @id, returned as "theatermania-slug:<slug>".
function structuredAuthor(html) {
  const s = String(html || '');
  const ld = extractJsonLdAuthor(s);
  if (ld) return ld;
  const meta = /<meta\b[^>]*(?:name|property)=["'](?:author|article:author)["'][^>]*>/i.exec(s);
  const content = meta && /\bcontent=["']([^"']+)["']/i.exec(meta[0]);
  if (content) {
    const name = stripBylineSuffixes(decodeHtmlEntities(content[1]).trim());
    if (name && !URL_LIKE_RE.test(name) && !NOT_A_PERSON_RE.test(name) && !PUBLISHER_RE.test(name) && !isPublicationName(name) && !isCmsAccountName(name)) return name;
  }
  const slug = /"author"\s*:\s*\{\s*"@id"\s*:\s*"[^"]*?\\?\/author\\?\/([a-z0-9-]+)\\?\/?#author"/i.exec(s);
  return slug ? `theatermania-slug:${slug[1].toLowerCase()}` : null;
}

function sameAsStructured(chosen, structured) {
  if (!structured.startsWith('theatermania-slug:')) return sameCriticName(chosen, structured);
  const slug = structured.slice('theatermania-slug:'.length);
  const parts = require('./title-match').foldDiacritics(String(chosen)).toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean);
  return parts.length >= 2 && (slug === parts[0][0] + parts[parts.length - 1] || slug === parts[0]);
}

/**
 * Ingest guard (BRO-7745): the chosen critic is the page's structured author (JSON-LD / meta /
 * CMS slug) while the page prints a different per-article byline. That is the shape of the
 * TheaterMania editor bug: the poster was credited instead of the critic. Returns
 * {structured, visible} to flag, else null. House-account pages do not flag, because there the
 * chosen name already differs from the structured one.
 * @param {{html: string, text?: string, url?: string, outletId?: string, chosen?: string}} p
 */
function detectBylineConflict({ html, text, url, outletId, chosen } = {}) {
  if (!html || !chosen || /^unknown$/i.test(String(chosen).trim())) return null;
  const structured = structuredAuthor(html);
  if (!structured || !sameAsStructured(chosen, structured)) return null;
  let outlet = outletId;
  if (!outlet && url) {
    try { outlet = (require('./review-normalization').resolveOutletFromUrl(url) || {}).outletId; } catch { outlet = null; }
  }
  // Only the outlet's own printed-byline reader (BYLINE_EXTRACTORS), never the generic text-tail
  // credit: a closing "Photos: Joan Marcus" / quoted-name line is not the byline (BRO-7777).
  const printed = outlet && text ? printedOutletByline(outlet, text) : null;
  const visible = extractTheaterManiaAuthorTag(html)
    || (printed && printed.known ? printed.name : null)
    || extractReviewerLine(html);
  if (!visible) return null;
  return sameCriticName(visible, chosen) ? null : { structured, visible };
}

/**
 * True when a candidate byline is not a person: a URL or domain, a house / publisher / desk name,
 * or a CMS uploader account. The one filter extractByline applies, exported so page-byline.js
 * applies the same rules to the generic fallback (BRO-7780).
 */
function isNotACriticName(name) {
  const n = String(name || '').trim();
  return !n || URL_LIKE_RE.test(n) || DOMAIN_LIKE_RE.test(n) || NOT_A_PERSON_RE.test(n) || PUBLISHER_RE.test(n) || isCmsAccountName(n) || isPublicationName(n);
}

/**
 * BRO-7780: a tier 1-2 outlet's own name ("USA TODAY", "Variety", "New York Post") is the
 * publisher, never the critic. JSON-LD / meta author on wire and syndicated pages often names the
 * paper. Only tier 1-2 displayNames (publications, never one-person blogs: lower-tier personal
 * blogs are named after their critic, e.g. "Liam O'Dell") and never registry aliases (aliases list
 * critic names). Names shorter than 3 letters ("i", the i paper) are ignored.
 */
let PUBLICATION_NAMES = null;
const pubKey = (s) => String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
function loadPublicationNames(registry) {
  const set = new Set();
  const outlets = (registry && (registry.outlets || registry)) || {};
  for (const e of Object.values(outlets)) {
    if (!e || typeof e !== 'object' || !(Number(e.tier) <= 2) || !e.displayName) continue;
    const k = pubKey(e.displayName);
    if (k.length >= 3) set.add(k);
  }
  return set;
}
function isPublicationName(name, registry) {
  if (registry) return loadPublicationNames(registry).has(pubKey(name));
  if (!PUBLICATION_NAMES) {
    try { PUBLICATION_NAMES = loadPublicationNames(require('../../data/outlet-registry.json')); } catch { PUBLICATION_NAMES = new Set(); }
  }
  return PUBLICATION_NAMES.has(pubKey(name));
}

module.exports = {
  isNotACriticName, isPublicationName,
  extractReviewerLine, extractReviewedByLine, extractSignOffBeforeShare, extractByline, extractJsonLdAuthor,
  extractAllThatDazzlesPageByline,
  extractTheaterManiaAuthorTag, detectBylineConflict, decodeEntities: (s) => decodeHtmlEntities(s || '') };
