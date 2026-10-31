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
const { decodeHtmlEntities } = require('./text-cleaning');
const { CMS_ADMIN_HANDLE_RE } = require('./byline-recovery');
const { extractBylineFromText } = require('./byline-from-text');

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
  const blocks = String(html).match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const block of blocks) {
    let doc;
    try {
      doc = JSON.parse(block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, ''));
    } catch { continue; }
    // BRO-3414: Yoast's @graph gives the article `"author": {"@id": ...}`
    // and the Person (with its name) as a separate node. Resolve the
    // reference so the article's own author wins over page chrome (a
    // theaterscene "authors" sidebar credited its editor on every review).
    const byId = new Map();
    for (const n of [].concat(doc && doc['@graph'] ? doc['@graph'] : [])) {
      if (n && typeof n === 'object' && n['@id']) byId.set(n['@id'], n);
    }
    const queue = [doc];
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
          if (URL_LIKE_RE.test(name) || DOMAIN_LIKE_RE.test(name) || NOT_A_PERSON_RE.test(name) || PUBLISHER_RE.test(name) || isCmsAccountName(name)) continue;
          return name;
        }
      }
      if (node['@graph']) queue.push(node['@graph']);
    }
  }
  return null;
}

function extractByline(html, { outletId, text } = {}) {
  if (!html) return null;
  const reviewer = extractReviewerLine(html) || extractReviewedByLine(html) || extractSignOffBeforeShare(html);
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
  ];
  for (const re of candidates) {
    const m = html.match(re);
    if (m && m[1]) {
      let name = decodeHtmlEntities(m[1]).trim();
      // Strip Jetpack-style "View all posts by X" prefix that leaks through
      // some <a rel=author> matches.
      name = name.replace(/^view\s+all\s+posts\s+by\s+/i, '');
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
      if (PUBLISHER_RE.test(name)) continue;
      // A bare "By" preamble span read as the name (BRO-3414).
      if (/^by:?$/i.test(name)) continue;
      if (re === INLINE_BY_RE) {
        name = name.split(/\s+and\s+/)[0].trim();
        // A one-word capture that stopped at ',' / '&' is a sort or filter
        // widget ("By Relevance, Date", "By Newest, Oldest"), not a co-author list.
        if (!/\s/.test(name) && /^\s*[,&]/.test(html.slice(m.index + m[0].length))) continue;
      }
      if ((re === INLINE_BY_RE || re === SIGN_OFF_RE) && !looksLikeProseName(name)) continue;
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

module.exports = {
  extractReviewerLine, extractReviewedByLine, extractSignOffBeforeShare, extractByline, extractJsonLdAuthor, decodeEntities: (s) => decodeHtmlEntities(s || '') };
