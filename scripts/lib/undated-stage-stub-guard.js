'use strict';

/**
 * undated-stage-stub-guard.js (BRO-7084; BRO-6320, BRO-5759).
 *
 * The Stage's old /reviews/<slug> URLs carry no year, and its pages are
 * paywalled, so a SERP/listing stub has neither a URL year nor a body to date
 * it. Such a stub attached to a current production on a title match alone
 * although it could be a review of an earlier staging. The fix is to date it
 * from the page HTML (article:published_time / JSON-LD, via
 * discovery-prefetch) before attaching, and to park it when no date can be
 * found. This module is the park decision, applied at the shared review writer.
 */

const STAGE_OUTLET_IDS = new Set(['thestage']);
const URL_YEAR_RE = /(?:^|[/_-])(?:19|20)\d{2}(?=$|[/_.?#-])/;

function hasText(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function urlPathHasYear(url) {
  let path = String(url || '');
  try { path = new URL(path).pathname; } catch { /* keep raw */ }
  return URL_YEAR_RE.test(path);
}

/**
 * @param {{outletId?: string, url?: string, publishDate?: string|null, fullText?: string, excerpt?: string}} args
 * @returns {{ park: boolean, reason: string|null }}
 */
function evaluateUndatedStageStub({ outletId, url, publishDate, fullText, excerpt }) {
  const no = { park: false, reason: null };
  if (!STAGE_OUTLET_IDS.has(String(outletId || '').toLowerCase())) return no;
  if (!url || !/thestage\.co\.uk/i.test(url)) return no;
  if (hasText(fullText) || hasText(excerpt)) return no;
  if (hasText(publishDate)) return no;
  if (urlPathHasYear(url)) return no;
  return { park: true, reason: 'thestage-undated-stub: no publish date, no URL year, no body' };
}

module.exports = { evaluateUndatedStageStub, urlPathHasYear, STAGE_OUTLET_IDS };
