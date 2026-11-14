/**
 * Remove what a wrong-production Show Score page put on a show (BRO-5866).
 *
 * One routine for the three places that find such a page: the scraper (on
 * scrape), merge-show-score-shards.js (applying a shard's finding) and
 * purge-wrong-production-show-score.js (the corpus sweep). Pure: mutates only
 * the objects passed in; callers load and save the files.
 */
'use strict';

const { removeSourceWithTombstone } = require('./reconcile-audience-buzz');
const { calculateCombinedScore, getDesignation } = require('./audience-weighting');
const { recordProductionMismatch } = require('./show-score-url-map');
const { normalizeCacheValue } = require('./cache-collision');
const { checkShowScoreProduction, extractPageDates, exemptionFor } = require('./show-score-production-window');

/**
 * Every mapped show whose Show Score page is another production's.
 * Evidence, in order: the extractor's recorded rejection for this URL
 * (show-score.json _meta.wrongProduction), the page's critic dates in
 * show-score.json, then (when the private archive is present) the dates in
 * the archived page.
 * @param {{urlMap: object, showScoreData?: object, showsById: object, readArchive?: (id: string) => string|null}} args
 * @returns {{showId: string, url: string, reason: string, evidence: string}[]}
 */
function findWrongProductionMappings({ urlMap, showScoreData, showsById, readArchive }) {
  const hits = [];
  const recorded = (showScoreData && showScoreData._meta && showScoreData._meta.wrongProduction) || {};
  const entries = (showScoreData && showScoreData.shows) || {};
  for (const [showId, url] of Object.entries(urlMap || {})) {
    const show = showsById[showId];
    if (!show || !url) continue;
    const rec = recorded[showId];
    if (rec && rec.url && normalizeCacheValue(rec.url) === normalizeCacheValue(url)) {
      if (!exemptionFor(show, url)) hits.push({ showId, url, reason: rec.reason, evidence: 'extractor rejection' });
      continue;
    }
    let dates = ((entries[showId] && entries[showId].criticReviews) || []).map((r) => r.date).filter(Boolean);
    let evidence = 'show-score.json critic dates';
    if (dates.length < 3 && readArchive) {
      const html = readArchive(showId);
      if (html) { dates = extractPageDates(html); evidence = 'archived page dates'; }
    }
    const check = checkShowScoreProduction(dates, show, url);
    if (!check.ok) hits.push({ showId, url, reason: check.reason, evidence });
  }
  // show-score.json entries with no mapping (an old mapping since dropped):
  // extract-show-score-reviews.js rebuilds them from the archive, so judge
  // them by the same dates.
  for (const [showId, entry] of Object.entries(entries)) {
    const show = showsById[showId];
    if (!show || (urlMap && urlMap[showId]) || !entry) continue;
    const url = entry.showScoreUrl || null;
    const dates = (entry.criticReviews || []).map((r) => r.date).filter(Boolean);
    const check = checkShowScoreProduction(dates, show, url);
    if (!check.ok) hits.push({ showId, url, reason: check.reason, evidence: 'unmapped show-score.json entry' });
  }
  return hits;
}

/**
 * @param {object} args
 * @param {string} args.showId
 * @param {string|null} args.url       the wrong page (null: an unmapped entry that kept no URL)
 * @param {object} [args.urlData]      show-score-urls.json
 * @param {object} [args.showScoreData] show-score.json
 * @param {object} [args.audienceBuzz] audience-buzz.json
 * @param {object} [args.show]         shows.json row (for the recompute)
 * @returns {{mappingRemoved: boolean, criticsRemoved: boolean, audienceRemoved: boolean, combinedScore?: number|null}}
 */
function removeWrongProductionShowScore({ showId, url, urlData, showScoreData, audienceBuzz, show }) {
  const out = { mappingRemoved: false, criticsRemoved: false, audienceRemoved: false };
  const current = urlData && urlData.shows && urlData.shows[showId];
  // A different page mapped since (the right one, found later) keeps its data.
  const stillWrong = !current || normalizeCacheValue(current) === normalizeCacheValue(url);
  if (urlData) {
    recordProductionMismatch(urlData, showId, url);
    if (current && stillWrong) {
      delete urlData.shows[showId];
      out.mappingRemoved = true;
    }
  }
  if (!stillWrong) return out;

  if (showScoreData && showScoreData.shows && showScoreData.shows[showId]) {
    delete showScoreData.shows[showId];
    out.criticsRemoved = true;
  }

  const rec = audienceBuzz && audienceBuzz.shows && audienceBuzz.shows[showId];
  if (rec && rec.sources && rec.sources.showScore) {
    removeSourceWithTombstone(rec, 'showScore', `Show Score page ${url || '(unmapped)'} is another production's page (BRO-5866)`);
    const info = show ? { status: show.status, closingDate: show.closingDate, category: show.category } : undefined;
    const { score } = calculateCombinedScore(rec.sources, info);
    rec.combinedScore = score ?? null;
    rec.designation = score == null ? null : getDesignation(score);
    out.audienceRemoved = true;
    out.combinedScore = rec.combinedScore;
  }
  return out;
}

/**
 * Pure planner: [{showId, url, reason, evidence}] for the sweep's hits plus
 * every recorded mismatch whose show still has something to remove.
 */
function planWrongProductionPurge({ urlData, showScoreData, audienceBuzz, showsById, readArchive }) {
  const plan = findWrongProductionMappings({ urlMap: (urlData && urlData.shows) || {}, showScoreData, showsById, readArchive });
  const seen = new Set(plan.map((p) => p.showId));
  for (const [showId, recorded] of Object.entries((urlData && urlData._productionMismatch) || {})) {
    if (seen.has(showId)) continue;
    // A mapped show is the sweep's call above: a page that passes the date
    // check now (a remount reviewed since) keeps its data.
    if (urlData.shows && urlData.shows[showId]) continue;
    const urls = [].concat(recorded);
    const hasData = !!((showScoreData && showScoreData.shows && showScoreData.shows[showId])
      || (audienceBuzz && audienceBuzz.shows && audienceBuzz.shows[showId] && audienceBuzz.shows[showId].sources && audienceBuzz.shows[showId].sources.showScore));
    if (!hasData) continue;
    plan.push({ showId, url: urls[urls.length - 1], reason: 'recorded as another production\'s page', evidence: '_productionMismatch' });
  }
  return plan.sort((a, b) => a.showId.localeCompare(b.showId));
}

function applyWrongProductionPurge(plan, { urlData, showScoreData, audienceBuzz, showsById }) {
  return plan.map((p) => ({ ...p, ...removeWrongProductionShowScore({ showId: p.showId, url: p.url, urlData, showScoreData, audienceBuzz, show: showsById[p.showId] }) }));
}

module.exports = { removeWrongProductionShowScore, findWrongProductionMappings, planWrongProductionPurge, applyWrongProductionPurge };
