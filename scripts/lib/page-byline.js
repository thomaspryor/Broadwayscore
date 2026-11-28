/**
 * BRO-7780: the ONE byline reader for a fetched review page. The opening-night lane
 * (inline-score.js extractMeta) and ingest (ingest-urls.js) both call it, so the two can't drift.
 *
 * Order (each step only when the one before found nobody):
 *  1. Outlet rules (content-quality outletBylineOverride): theaterlife, site-wide account hosts,
 *     The Stage, The Recs, TheaterMania's visible author tag / author area. A rule that says
 *     "this page names nobody" (null) ENDS the read: falling through would credit the account
 *     that posted the page (BRO-6518 site-wide accounts, BRO-7745 TheaterMania editor).
 *  2. byline-extraction extractByline: reviewer lines, TheaterMania tag, Person-only JSON-LD,
 *     meta, byline CSS, Condé Nast name link, sign-offs. It filters publishers, house names,
 *     desks and CMS accounts. No article text, so no text-tail credit (a photo credit is not a
 *     byline).
 *  3. content-quality extractAuthorFromHtml WITH the article text, as ingest called it before this
 *     reader existed: its text paths (CultureSauce's inline "Date: ... Author: X", the generic
 *     "By X" line) are the only byline some outlets print (ship-check: passing '' lost Slam Frank).
 *     Through the same isNotACriticName filter. A rejected answer is null, never a retry.
 *  4. The outlet's printed credit (PRINTED_BYLINE_OVERRIDES outlets: "Review by X" in the
 *     article), which beats the CMS author on those outlets, as the record writer does.
 *
 * Returns { criticName, bylineConflict, source }. bylineConflict is detectBylineConflict's
 * {structured, visible} when the chosen name is the structured author while the page prints
 * someone else, else null. source names the step that answered ('outlet-rule',
 * 'outlet-rule-none', 'markup', 'generic', 'printed-credit', or null). Never throws.
 */
'use strict';

// BRO-8255: a sentence-final period rides along with a name taken from prose ("Michela Smith.").
// Strip it after a 2+ letter word; an initial ("J.") and Jr./Sr. keep theirs. Lives here, the lowest
// reader, so ingest-urls, sweep-stored-bylines and the show-aware wrapper all get it.
function stripTrailingDot(name) {
  if (typeof name !== 'string') return name;
  return name.replace(/\s+$/, '').replace(/([A-Za-z\u00C0-\u024F'\u2019-]{2,})\.$/, (m, w) => (/^(?:Jr|Sr)$/i.test(w) ? m : w));
}

function readPageByline({ html, text = '', url, outletId } = {}) {
  if (!html) return { criticName: null, bylineConflict: null, source: null };
  const bx = require('./byline-extraction');
  const cq = require('./content-quality');
  const opts = { url, outletId };
  let criticName = null;
  let source = null;
  let override;
  try { override = cq.outletBylineOverride(html, text || '', opts); } catch { override = undefined; }
  if (override !== undefined) {
    criticName = override || null;
    source = override ? 'outlet-rule' : 'outlet-rule-none';
  } else {
    try { criticName = bx.extractByline(html, { outletId }) || null; } catch { criticName = null; }
    if (criticName) source = 'markup';
    else {
      let generic = null;
      try { generic = cq.extractAuthorFromHtml(html, text || '', opts) || null; } catch { generic = null; }
      if (generic && !bx.isNotACriticName(generic)) { criticName = generic; source = 'generic'; }
    }
  }
  if (text) {
    let printed = null;
    try { printed = cq.withPrintedCredit(criticName, text, opts); } catch { printed = criticName; }
    if (printed && printed !== criticName) { criticName = printed; source = 'printed-credit'; }
  }
  let bylineConflict = null;
  try { bylineConflict = bx.detectBylineConflict({ html, text, url, outletId, chosen: criticName }); } catch { bylineConflict = null; }
  return { criticName: stripTrailingDot(criticName), bylineConflict, source };
}

/**
 * BRO-7777 (c): does a byline conflict still stand once the name is written? The record writer
 * stores sanitizeCriticName(name) and keys critics by normalizeCritic (aliases: "Zach Stewart" is
 * zachary-stewart), so compare the same way, else ingest warns about a conflict the written
 * record does not have.
 */
function bylineConflictStands(writtenName, conflict) {
  if (!conflict || !conflict.visible) return false;
  const { sanitizeCriticName } = require('./byline-normalization');
  const { normalizeCritic } = require('./review-normalization');
  const { sameCriticName } = require('./byline-from-text');
  const a = sanitizeCriticName(writtenName) || 'Unknown';
  const b = sanitizeCriticName(conflict.visible) || conflict.visible;
  if (/^unknown$/i.test(a)) return false;
  return normalizeCritic(a) !== normalizeCritic(b) && !sameCriticName(a, b);
}

/**
 * Did a fetch return the article at all? A captcha, bot wall or consent page has no article text,
 * and a reader finding "nobody" on it says nothing about the page's byline. The drift check and the
 * stored-byline sweep both use this so neither reads an interstitial as "the page names nobody".
 * textLength undefined (caller did not measure) counts as read.
 */
const MIN_ARTICLE_CHARS = 500;
function articleWasRead(textLength) {
  return textLength == null || textLength >= MIN_ARTICLE_CHARS;
}

module.exports = { readPageByline, stripTrailingDot, bylineConflictStands, articleWasRead, MIN_ARTICLE_CHARS };
