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
 *  3. content-quality extractAuthorFromHtml with NO text (its meta / JSON-LD / byline-CSS chain),
 *     through the same isNotACriticName filter. A rejected answer is null, never a retry.
 *  4. The outlet's printed credit (PRINTED_BYLINE_OVERRIDES outlets: "Review by X" in the
 *     article), which beats the CMS author on those outlets, as the record writer does.
 *
 * Returns { criticName, bylineConflict, source }. bylineConflict is detectBylineConflict's
 * {structured, visible} when the chosen name is the structured author while the page prints
 * someone else, else null. source names the step that answered ('outlet-rule',
 * 'outlet-rule-none', 'markup', 'generic', 'printed-credit', or null). Never throws.
 */
'use strict';

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
      try { generic = cq.extractAuthorFromHtml(html, '', opts) || null; } catch { generic = null; }
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
  return { criticName, bylineConflict, source };
}

module.exports = { readPageByline };
