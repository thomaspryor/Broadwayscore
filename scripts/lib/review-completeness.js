'use strict';
/**
 * BRO-7196: what a review card needs before it may go live, in one place.
 *
 * On Wanted's opening night (2026-11-08) the opening-night lane published rows straight into reviews.json with the raw
 * outlet id as the outlet name, no pull quote on any card, and some rows with no critic or no date. The regular path
 * gets those from the rebuild (rebuild-all-reviews.js builds the reviews.json row); the lane skips the rebuild, and
 * nothing said what a publishable row must carry, so the two drifted apart.
 *
 * The contract: an outlet display name (not an id), a critic name, a publish date, and a pull quote. Every check that
 * decides whether a review card is ready reads it from here: the lane before it scores and before it publishes
 * (lane-runner.js), and the site check on opening-night shows (opening-night-checks/review-cards-complete.check.js).
 *
 * The quote is the rebuild's own: finalizePullQuote() in rebuild-all-reviews.js, so a lane card shows the same quote the
 * next full rebuild will. That file is loaded by a computed path on purpose: rehearsal.js laneCodeFiles() follows
 * literal require()s into the lane arm hash, and the whole rebuild graph in the hash would disarm the lane on every
 * rebuild edit. Quote selection only changes what text a card shows, never a score.
 */
const path = require('path');

const CARD_FIELDS = Object.freeze(['outlet', 'criticName', 'publishDate', 'pullQuote']);

// An outlet id, not a display name: lowercase letters/digits joined by hyphens ("chicagotribune", "one-minute-critic").
const OUTLET_ID_SHAPE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
// Bylines that name nobody. Same family the rebuild's displayCriticName() drops.
const PLACEHOLDER_CRITIC = /^(?:unknown|staff|null|undefined|n\/a|none|anonymous|archive|written by)$/i;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}/;

function outletDisplayName(outletId) {
  if (!outletId) return null;
  const { getOutletDisplayName } = require('./review-normalization');
  const name = getOutletDisplayName(outletId);
  return name && !OUTLET_ID_SHAPE.test(name) ? name : null;
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

let registryCache = null;
const outletRegistry = () => (registryCache = registryCache || require('../../data/outlet-registry.json'));

/**
 * The byline the site will show for this row: the rebuild's own rule (critic-display-name.js displayCriticName, which
 * drops "Staff Writer", an outlet name such as "Talkin' Broadway", a URL), so a lane card never shows a byline the next
 * rebuild erases. null when the row names nobody.
 */
function displayCritic(row) {
  const r = row || {};
  const raw = str(r.criticName);
  if (!raw || PLACEHOLDER_CRITIC.test(raw) || /^https?:\/\//i.test(raw)) return null;
  try {
    const { displayCriticName } = require('./critic-display-name');
    const entry = r.outletId && (outletRegistry().outlets || {})[r.outletId];
    return displayCriticName(raw, outletDisplayName(r.outletId) || r.outlet || null, entry ? { id: r.outletId, ...entry } : undefined) || null;
  } catch {
    return raw;
  }
}

/**
 * The card fields a row is missing. Pure apart from the outlet registry read.
 * @param {object} row a review row (reviews.json shape; a review file works for the first three)
 * @param {{quote?: boolean}} opts quote:false skips the pull quote (a row not scored yet has none to give)
 * @returns {string[]} subset of CARD_FIELDS, in that order
 */
function missingCardFields(row, { quote = true } = {}) {
  const r = row || {};
  const missing = [];
  const outlet = str(r.outlet);
  if (!outlet || OUTLET_ID_SHAPE.test(outlet) || (r.outletId && outlet === r.outletId)) missing.push('outlet');
  if (!displayCritic(r)) missing.push('criticName');
  if (!DATE_SHAPE.test(str(r.publishDate))) missing.push('publishDate');
  if (quote && str(r.pullQuote).length < 20) missing.push('pullQuote');
  return missing;
}

/**
 * Whether the row carries any text a pull quote could come from: its own page text or an aggregator's excerpt. A row
 * without (a paywall scored from an aggregator's thumb alone) has nothing to quote until the review is re-collected.
 */
function hasQuotableText(row) {
  const r = row || {};
  if (str(r.fullText).length >= 100) return true;
  return Object.entries(r).some(([k, v]) => /Excerpt$/.test(k) && str(v).length >= 20);
}

let rebuildLib = null;
function loadRebuild() {
  // Computed path: see the header (keeps the rebuild out of the lane arm hash).
  // Its top level reads process.argv (exits on --help or a bare --show=), so it loads with a clean argv.
  if (!rebuildLib) {
    const argv = process.argv;
    process.argv = argv.slice(0, 2);
    try { rebuildLib = require(path.join(__dirname, '..', ['rebuild-all-reviews', 'js'].join('.'))); } finally { process.argv = argv; }
  }
  return rebuildLib;
}

/**
 * The pull quote the rebuild would ship for this review file, or null. Never throws.
 * @param {object} data review file
 * @param {{title?: string, status?: string}} show
 */
function cardPullQuote(data, show = {}) {
  if (!data) return null;
  try {
    const q = loadRebuild().finalizePullQuote({ ...data }, show.title || '', show.status || 'open');
    return typeof q === 'string' && q.trim() ? q.trim() : null;
  } catch {
    return null;
  }
}

// A review page that opens on its own byline ("Theatre Review by Howard Miller - November 8, 2026": Talkin' Broadway).
const OPENING_BYLINE = /^\s*(?:[A-Za-z' ]{0,24}\s)?review(?:ed)?\s+by\s+/i;
const OPENING_CHARS = 120;

/**
 * The critic the row's own evidence names: its byline, else a critic the outlet registry lists for the outlet printed
 * at the head of the text (printed-byline-conflict.js, the regular collector's fill rule), else a byline the text opens
 * with ("Review by <Name>"). null when nothing names one; the caller holds the review rather than guess.
 */
function cardCriticName(row) {
  const r = row || {};
  const own = displayCritic(r);
  if (own) return own;
  const text = str(r.fullText);
  if (text.length < 50) return null;
  try {
    const pb = require('./printed-byline-conflict');
    const knownCritics = pb.knownCriticsForOutlet(pb.buildKnownCriticsIndex(outletRegistry()), r.outletId);
    const hit = pb.decidePrintedByline({ criticName: null, outletId: r.outletId, fullText: text, knownCritics });
    const found = (hit && hit.printedName) || (OPENING_BYLINE.test(text.slice(0, OPENING_CHARS)) && pb.extractHeaderByline(text.slice(0, OPENING_CHARS)));
    if (found) return displayCritic({ ...r, criticName: found });
  } catch { /* no byline is a hold, never a crash */ }
  return null;
}

/**
 * The best publish date the row's own evidence gives: the date it carries, else the rebuild's URL/text backfill
 * (backfill-publish-date.js). Never the opening date (memory/feedback_no_opening_date_fallback.md). null when none.
 */
function cardPublishDate(row) {
  if (row && DATE_SHAPE.test(str(row.publishDate))) return row.publishDate;
  try {
    const { resolveBackfillPublishDate } = require('./backfill-publish-date');
    const b = resolveBackfillPublishDate(row || {});
    return b && DATE_SHAPE.test(b.date) ? b.date : null;
  } catch {
    return null;
  }
}

/**
 * The reviews.json row for a scored review file: the file plus the display fields the rebuild would add (outlet display
 * name, pull quote). The file itself never gets `pullQuote`: on a review file that field is a human editor's choice and
 * always wins (rebuild-all-reviews.js selectBestExcerpt).
 */
function toCardRow(data, show = {}) {
  const row = { ...data };
  const name = outletDisplayName(row.outletId);
  if (name && (!str(row.outlet) || OUTLET_ID_SHAPE.test(str(row.outlet)) || row.outlet === row.outletId)) row.outlet = name;
  if (row.criticName) row.criticName = displayCritic(row);
  if (!row.publishDate) { const d = cardPublishDate(row); if (d) row.publishDate = d; }
  if (!str(row.pullQuote)) { const q = cardPullQuote(data, show); if (q) row.pullQuote = q; }
  return row;
}

module.exports = { CARD_FIELDS, OUTLET_ID_SHAPE, missingCardFields, hasQuotableText, outletDisplayName, cardCriticName, cardPullQuote, cardPublishDate, toCardRow };
