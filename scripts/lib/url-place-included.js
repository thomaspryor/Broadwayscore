'use strict';
/**
 * BRO-8449 class fix: included reviews whose url path stages the show somewhere else.
 *
 * verifiedPlaceSignal (other-production-signal.js) only fires when the content verifier
 * said "another production". A review with NO verdict, or a verdict on an older copy of
 * the body, never reaches it, so a tour or regional review sat in the corpus unjudged
 * (15 on the card, 46 on 2026-11-28). This module finds every INCLUDED review whose url
 * names another place (census-other-place's matcher) and says whether anything has
 * judged it:
 *   unjudged     no verdict, or a verdict on an older body (stale)  -> re-verify queue
 *   contradicted a fresh verdict says "right production" but the url names another place
 *                (the BRO-8440 thestage--matt-barton case)          -> listed, needs a look
 *   flagged      verdict says another production (the rebuild excludes it) -> not a leak
 *   acked        a reviewer judged it a transfer / same production  -> data/audit/url-place-judged.json
 * Pure selectors take the loaded reviews; the file readers only join review-text files.
 * Rows carry file paths, outlet ids and place names, never review text.
 */
const fs = require('fs');
const path = require('path');
const { urlStagedElsewhere } = require('./census-other-place');
const { showMarket } = require('./other-production-signal');
const { computeCvIsStale } = require('./review-guards');

const ACK_FILE = path.join(__dirname, '..', '..', 'data', 'audit', 'url-place-judged.json');

function loadAcks(file = ACK_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).judged || {}; } catch { return {}; }
}

/**
 * State of one review-text file against its show, or null when its url names no other place.
 * @returns {{place:string, state:'unjudged'|'contradicted'|'flagged'}|null}
 */
function classifyUrlPlaceFile(d, show) {
  if (!d || !show || !d.url) return null;
  const market = showMarket(show);
  if (!market) return null;
  const place = urlStagedElsewhere(d.url, show, market);
  if (!place) return null;
  // Already carries an exclusion flag: the rebuild drops it, nothing to judge or queue.
  if (d.wrongProduction === true || d.wrongShow === true || d.isNonReview === true) return { place, state: 'flagged' };
  const cv = d.contentVerification;
  if (!cv || computeCvIsStale(d)) return { place, state: 'unjudged' };
  return { place, state: cv.wrongProduction === true ? 'flagged' : 'contradicted' };
}

/**
 * Join included reviews (data/reviews.json rows) to their review-text files and classify.
 * @param {{reviews: Array<{showId:string,url?:string}>, shows: object[], reviewTextsDir: string, acks?: object}} o
 * @returns {Array<{showId:string,file:string,outletId:string|null,place:string,state:string,acked:boolean}>}
 */
function collectUrlPlaceHits({ reviews, shows, reviewTextsDir, acks = {} }) {
  const showById = new Map(shows.map((s) => [s.id, s]));
  const includedUrls = new Map();
  for (const r of reviews) {
    if (!r || !r.showId || !r.url) continue;
    if (!includedUrls.has(r.showId)) includedUrls.set(r.showId, new Set());
    includedUrls.get(r.showId).add(r.url);
  }
  const out = [];
  for (const [showId, urls] of includedUrls) {
    const show = showById.get(showId);
    if (!show || !showMarket(show)) continue;
    let files;
    try { files = fs.readdirSync(path.join(reviewTextsDir, showId)).filter((f) => f.endsWith('.json')).sort(); } catch { continue; }
    for (const file of files) {
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(reviewTextsDir, showId, file), 'utf8')); } catch { continue; }
      if (!d.url || !urls.has(d.url)) continue;
      const c = classifyUrlPlaceFile(d, show);
      if (!c) continue;
      out.push({ showId, file, outletId: d.outletId || null, place: c.place, state: c.state, acked: Object.prototype.hasOwnProperty.call(acks, `${showId}/${file}`) });
    }
  }
  return out;
}

/** Hits still needing a verdict (the daily check's "unjudged" count). */
const unjudged = (hits) => hits.filter((h) => h.state === 'unjudged' && !h.acked);
/** Fresh "right production" verdicts that disagree with the url place. */
const contradicted = (hits) => hits.filter((h) => h.state === 'contradicted' && !h.acked);

/** Findings in the shape reverify-stale-cv-promoted.js's --file mode takes. */
function selectUrlPlaceUnjudged(opts) {
  return unjudged(collectUrlPlaceHits(opts)).map((h) => ({ showId: h.showId, file: h.file }));
}

/**
 * --url-place may store a verdict that newly excludes a live review only when the verifier says
 * "another production" at high confidence. The verdict's own isValid is false in that case, so it is
 * not part of the test (BRO-8449 did-it-work: requiring it blocked every real exclusion).
 */
function urlPlaceMayStoreExclusion(result) {
  return Boolean(result && result.wrongProduction === true && result.confidence === 'high' && !result.wrongArticle && !result.isFilmTv);
}

module.exports = { urlPlaceMayStoreExclusion, ACK_FILE, loadAcks, classifyUrlPlaceFile, collectUrlPlaceHits, unjudged, contradicted, selectUrlPlaceUnjudged };
