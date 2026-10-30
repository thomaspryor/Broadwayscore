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

// BRO-6653: the 'scored' stage row is telemetry, committed by a late always() step that a
// cancelled or timed-out poller run never reaches (Showstopper! The Kids Show: review
// scored llm-v6/93 and live in reviews.json, no row). A show whose published reviews carry an
// LLM score was scored, so the missing row is not the stalled-scorer failure this alert is for.
function llmScoredShowIds(reviewsData) {
  const list = Array.isArray(reviewsData) ? reviewsData : (reviewsData && reviewsData.reviews) || [];
  const set = new Set();
  for (const r of list) {
    if (r && r.showId && /^(llm|anchored)/.test(r.scoreSource || '')) set.add(r.showId);
  }
  return set;
}

function findMissingScored(openingShows, scoredSet) {
  return openingShows.filter((s) => !scoredSet.has(s.id));
}

// Shows the review pipeline has actually collected text for (BRO-5975): a show with no
// reviews yet has nothing to score, and that gap belongs to the coverage gates.
function reviewedShowIds(latencyLines) {
  const set = new Set();
  const collected = new Map();
  const excluded = new Map();
  const bump = (m, id) => m.set(id, (m.get(id) || 0) + 1);
  for (const line of latencyLines) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.stage === 'scored'
        || (e.stage === 'rebuilt' && e.metadata && e.metadata.reviewCount > 0)) set.add(e.showId);
      else if (e.stage === 'review-text-collected' || e.stage === 'review-first-seen') bump(collected, e.showId);
      else if (e.stage === 'excluded') bump(excluded, e.showId);
    } catch { /* skip malformed line */ }
  }
  // Collected text that never reached a rebuild is the stalled-scorer signature this alert
  // exists for, unless exclusions account for it (jest-to-impress: 2 collected, 9 excluded).
  for (const [id, n] of collected) if (n > (excluded.get(id) || 0)) set.add(id);
  return set;
}

// The alert is for scoring that is overdue, not scoring still in flight: the cron fires
// ~1 PM ET, hours before a same-day press night's reviews exist (7 of 8 runs red on
// openings that scored later that night), so a show that opened today is not yet due,
// and a show with no collected reviews has nothing to score.
function findOverdueMissingScored(openingShows, scoredSet, reviewedSet, today) {
  return findMissingScored(openingShows, scoredSet)
    .filter((s) => s.openingDate !== today && reviewedSet.has(s.id));
}

module.exports = {
  llmScoredShowIds,
  reviewedShowIds,
  findOverdueMissingScored,
  COVERED_CATEGORIES,
  etDateToday,
  etDateYesterday,
  selectOpeningWindowShows,
  scoredShowIds,
  findMissingScored,
};
