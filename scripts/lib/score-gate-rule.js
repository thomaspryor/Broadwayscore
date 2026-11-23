'use strict';
/**
 * BRO-8163 standing rule (owner, 2026-11-23): every special and every short Broadway / West End run shows a Critic
 * Score at STANDING_MIN_REVIEWS (3) scored reviews, never asked again. Pure functions over plain data (CLAUDE.md rule 15).
 *
 * scoreGateReason() classifies; standingMinReviews() applies the precedence. Precedence in both readers
 * (scoreGateArg in src/config/scoring.ts, scripts/lib/should-hide-reviews.js):
 *   1. data/score-gate-overrides.json shows.<id>.minReviews (explicit number)
 *   2. data/score-gate-overrides.json keptMarketMinimum.<id> with approvedBy (explicit "keep the market minimum")
 *   3. this rule (3)
 *   4. curated historical (boolean)
 * src/config/scoring.ts carries a TS copy of the classifier; tests/unit/score-gate-overrides-parity.test.ts locks them
 * together over every show in data/shows.json.
 */

const SHORT_RUN_DAYS = 56; // 8 weeks
const STANDING_MIN_REVIEWS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const GATED_SHORT_RUN_CATEGORIES = new Set(['broadway', 'west-end']);

const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(`${d}T00:00:00Z`));
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/** 'special' / 'short run (N days)' for a show the standing rule covers, else null. */
function scoreGateReason(show) {
  if (!show) return null;
  if (String(show.type || '').toLowerCase() === 'special') return 'special';
  if (GATED_SHORT_RUN_CATEGORIES.has(show.category) && isDay(show.openingDate) && isDay(show.closingDate)) {
    const run = daysBetween(show.openingDate, show.closingDate);
    if (run >= 0 && run <= SHORT_RUN_DAYS) return `short run (${run} days)`;
  }
  return null;
}

/**
 * The rule's minimum for a show (3), or null when it does not apply: not a special/short run, or the owner recorded
 * keptMarketMinimum for it. `keptMarketMinimum` is the parsed overrides file's map.
 */
function standingMinReviews(show, keptMarketMinimum) {
  if (!show || !show.id || !scoreGateReason(show)) return null;
  const kept = keptMarketMinimum && keptMarketMinimum[show.id];
  if (kept && typeof kept === 'object' && kept.approvedBy) return null;
  return STANDING_MIN_REVIEWS;
}

module.exports = { scoreGateReason, standingMinReviews, SHORT_RUN_DAYS, STANDING_MIN_REVIEWS, isDay, daysBetween };
