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

// Covered window: shows that opened today OR yesterday (accounts for late-evening ET
// openings where reviews don't stage-latency-log until the next UTC day).
function selectOpeningWindowShows(shows, { today, yesterday }) {
  return shows.filter(
    (s) => (s.openingDate === today || s.openingDate === yesterday)
      && COVERED_CATEGORIES.has(s.category),
  );
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

function findMissingScored(openingShows, scoredSet) {
  return openingShows.filter((s) => !scoredSet.has(s.id));
}

module.exports = {
  COVERED_CATEGORIES,
  etDateToday,
  etDateYesterday,
  selectOpeningWindowShows,
  scoredShowIds,
  findMissingScored,
};
