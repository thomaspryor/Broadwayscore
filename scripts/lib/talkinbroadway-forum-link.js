/**
 * talkinbroadway-forum-link.js — BRO-3788
 *
 * Pure HTML-parsing helpers for recovering a Talkin' Broadway review whose
 * stored url is the allthatchat_new/d.php forum ANNOUNCEMENT thread rather
 * than the real review page. The forum thread only ever holds a short
 * teaser + a "Link" anchor pointing at the actual review
 * (talkinbroadway.com/page/{ob,bwaybway,westend}/{MM_DD_YY}.html) — no
 * re-fetch of the stored URL can ever recover full text (BRO-2605,
 * BRO-3788). Kept fetch-free per the test-extraction rule so
 * scripts/recover-talkinbroadway-forum-links.js and its unit test share the
 * exact same logic instead of the test re-implementing it.
 */

'use strict';

// Forum announcement thread — the dead-end URL this module exists to route
// around. Never the real review page.
const FORUM_URL_RE = /allthatchat_new\/d\.php/;

// TB's forum "reply" row: `<b>Link </b></td><td ...><a ... href="URL">Title</a>`.
// The anchor immediately follows the literal "Link" label. Takes the FIRST
// match in the page — verified against one real announcement thread (BRO-3788
// dev session), not against a thread with multiple replies reusing this same
// markup (e.g. a second critic's link further down); if that shape exists on
// TB, this would silently pick the wrong link. No corpus fixture has
// surfaced that case yet.
const LINK_MARKER_RE = /<b>\s*Link\s*<\/b>\s*<\/td>\s*<td[^>]*>\s*<a[^>]+href="([^"]+)"/i;

// Same byline shape TB_BYLINE_SHAPE in article-extractor.js validates
// against ("{Critic Name} - {Month Day, Year}"), narrowed here to just
// capture the name (which may be wrapped in a mailto <a> tag). The name is
// delimited from the date by " - " (hyphen with a space on BOTH sides,
// required via \s+-\s+) rather than by excluding hyphens from the capture
// entirely — a bare hyphen-exclusion would also reject a hyphenated name
// like "Anne-Marie Duff" (no space around that hyphen, so \s+-\s+ never
// matches inside it).
const CRITIC_RE = /Theatre Review by\s*(?:<a[^>]*>)?\s*([^<\n]+?)\s*(?:<\/a>)?\s+-\s+[A-Za-z]+\.?\s+\d{1,2},?\s+\d{4}/i;

function isForumThreadUrl(url) {
  return !!url && FORUM_URL_RE.test(url);
}

function extractReviewPageUrl(html) {
  if (!html) return null;
  const m = html.match(LINK_MARKER_RE);
  return m ? m[1] : null;
}

function extractCriticName(html) {
  if (!html) return null;
  const m = html.match(CRITIC_RE);
  return m ? m[1].trim() : null;
}

module.exports = { isForumThreadUrl, extractReviewPageUrl, extractCriticName, FORUM_URL_RE };
