'use strict';

const { normalizeDate } = require('./date-utils');

// These are useful opening signals, but neither a review's publication date
// nor a second Playbill page independently confirms a press night (BRO-4998).
const SOURCES_TO_CHECK = new Set([
  'playbill', 'playbill-production-page', 'playbill-article',
  'inferred-from-reviews', 'inferred-from-reviews-reverse', 'inferred-from-reviews-mode',
  'review-derived-press-night', 'review-open-signal', 'discovery-open-signal',
  'aggregator-roundup', 'bww-roundup', 'wet-roundup', 'audit-review-evidence', 'guardian-review',
]);
const PRESS_SOURCE_BY_MARKET = {
  'west-end': 'theatremonkey',
  'off-west-end': 'theatremonkey',
  'off-broadway': 'lortel',
};

function needsPressNightCrossCheck(show) {
  return !!(show?.openingDate && PRESS_SOURCE_BY_MARKET[show.category] &&
    SOURCES_TO_CHECK.has(show.openingDateSource));
}

function day(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    normalizeDate(value) === value ? value : null;
}

/**
 * Called by both date writers after their production match, before accepting
 * a merged date. Evidence must be the original press-night listing, never a
 * merged Playbill fallback labelled as "both". No fetches or writes here.
 * Missing evidence is advisory; unsafe evidence vetoes opening writes. An exact
 * confirmation upgrades provenance; a bounded correction uses the independent
 * listing. Neither branch changes previews or re-infers a date from reviews.
 */
function crossCheckOpeningDate(show, evidence) {
  if (!needsPressNightCrossCheck(show)) return null;
  const result = { status: 'unverified', reason: 'independent-press-night-unavailable', changes: [] };
  if (!evidence || evidence.source !== PRESS_SOURCE_BY_MARKET[show.category] || !day(evidence.opening)) return result;
  const opening = evidence.opening;
  const current = day(show.openingDate);
  const previews = day(show.previewsStartDate);
  const externalPreviews = day(evidence.firstPreview);
  const closing = day(show.closingDate);
  // A schedule for a different engagement must not shift this production.
  const invalidBounds = !current ||
    (show.previewsStartDate && !previews) || (show.closingDate && !closing) ||
    (evidence.firstPreview && !externalPreviews) ||
    (previews && opening < previews) || (externalPreviews && opening < externalPreviews) ||
    (closing && opening > closing) ||
    Math.abs(Date.parse(opening) - Date.parse(current)) > 60 * 86400000 ||
    (previews && externalPreviews && Math.abs(Date.parse(previews) - Date.parse(externalPreviews)) > 60 * 86400000);
  if (invalidBounds) return { ...result, status: 'conflict', reason: 'press-night-outside-production-window' };
  const changes = [];
  if (opening !== current) changes.push({ field: 'openingDate', old: show.openingDate, new: opening });
  changes.push({ field: 'openingDateSource', old: show.openingDateSource, new: evidence.source });
  return { status: opening === current ? 'confirmed' : 'corrected', reason: 'independent-press-night', changes };
}

// Keep preview enrichment independent from the press-night verdict. An absent
// source is advisory; a conflict vetoes opening writes; a successful check
// replaces only opening fields. Never leave a preview after the final opening.
function mergePressNightChanges(show, proposed, check) {
  if (!check || check.status === 'unverified') return proposed;
  const opening = check.changes.find(c => c.field === 'openingDate')?.new || show.openingDate;
  return [...proposed.filter(c => c.field !== 'openingDate' && c.field !== 'openingDateSource' &&
    (c.field !== 'previewsStartDate' || (day(c.new) && c.new <= opening &&
      Math.abs(Date.parse(c.new) - Date.parse(opening)) <= 120 * 86400000))), ...check.changes];
}

function westEndOpeningSource(entry) {
  if (entry.source !== 'both') return entry.source;
  return day(entry.pressNightEvidence?.opening) ? 'theatremonkey' : 'playbill';
}

module.exports = { needsPressNightCrossCheck, crossCheckOpeningDate, mergePressNightChanges, westEndOpeningSource };
