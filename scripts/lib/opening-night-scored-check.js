/**
 * Pure logic for the opening-night-scored alert (scripts/check-opening-night-scored.js).
 * Extracted per CLAUDE.md §15 so production behavior is locked in by a real test,
 * not re-implemented in a fixture.
 *
 * Category coverage matches opening-night-selection.js's marketMatches(): the
 * broadway market includes off-broadway, and the west-end market includes
 * off-west-end. Those shows flow through the same 'scored' stage-latency
 * pipeline (data/audit/stage-latency.jsonl has 89 off-broadway + 270
 * off-west-end 'scored' entries), so excluding them here was an oversight,
 * not a structural gap — see task #1737.
 */

const COVERED_CATEGORIES = new Set(['broadway', 'off-broadway', 'west-end', 'off-west-end']);

function etDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// ET calendar day is what "opening night" means — not UTC.
function etDateToday(now = new Date()) {
  return etDateParts(now);
}

function etDateYesterday(now = new Date()) {
  const d = new Date(now.getTime());
  d.setUTCHours(d.getUTCHours() - 24);
  return etDateParts(d);
}

// Covered window: shows that opened yesterday (ET). The cron runs at 9 AM ET,
// so a show opening today has not had its curtain yet and its reviews cannot
// exist; checking it flagged every evening opening as a failure (BRO-5975:
// Benjamin Button failed at 13:42 ET on 10-21, its reviews scored at 23:18 ET).
// `today` is accepted so a caller passing both keeps working; it never selects.
function selectOpeningWindowShows(shows, { yesterday }) {
  return shows.filter(
    (s) => s.openingDate === yesterday && COVERED_CATEGORIES.has(s.category),
  );
}

// Shows with at least one collected review that was not later excluded. The
// alert's signature (bucket D) is reviews that arrived but never scored; an
// off-Broadway or off-West-End show whose only rows are a ticket listing or a
// wrong-production hit, or that no critic reviewed, has nothing to score
// (BRO-5975: Jest to Impress, a donyc listing page). Broadway and West End
// openings are always reviewed, so for them no score by the next morning
// stays an alert even with nothing collected (a collection lag is stale data
// too). Review keys differ in author case between stages, so compare
// lowercased.
const COLLECTED_STAGES = new Set(['review-first-seen', 'review-text-collected', 'scored']);
const EVIDENCE_REQUIRED_CATEGORIES = new Set(['off-broadway', 'off-west-end']);

function reviewEvidenceShowIds(latencyLines) {
  const collected = new Map();
  const excluded = new Set();
  for (const line of latencyLines) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (!e.showId || !e.reviewKey) continue;
      const key = `${e.showId}|${String(e.reviewKey).toLowerCase()}`;
      if (e.stage === 'excluded') excluded.add(key);
      else if (COLLECTED_STAGES.has(e.stage)) collected.set(key, e.showId);
    } catch { /* skip malformed line */ }
  }
  const ids = new Set();
  for (const [key, showId] of collected) if (!excluded.has(key)) ids.add(showId);
  return ids;
}

function scoredShowIds(latencyLines, cutoffMs) {
  const scoredSet = new Set();
  for (const line of latencyLines) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.stage !== 'scored') continue;
      if (!e.at || new Date(e.at).getTime() < cutoffMs) continue;
      scoredSet.add(e.showId);
    } catch { /* skip malformed line */ }
  }
  return scoredSet;
}

// With no evidence set every unscored show counts (the original behaviour).
function needsEvidence(show, evidenceSet) {
  return !!evidenceSet && EVIDENCE_REQUIRED_CATEGORIES.has(show.category) && !evidenceSet.has(show.id);
}

function findMissingScored(openingShows, scoredSet, evidenceSet = null) {
  return openingShows.filter((s) => !scoredSet.has(s.id) && !needsEvidence(s, evidenceSet));
}

module.exports = {
  COVERED_CATEGORIES,
  etDateToday,
  etDateYesterday,
  selectOpeningWindowShows,
  scoredShowIds,
  reviewEvidenceShowIds,
  needsEvidence,
  findMissingScored,
};
