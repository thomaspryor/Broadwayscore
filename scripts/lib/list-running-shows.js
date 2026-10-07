/**
 * Single source of truth for "currently running shows in Broadway + West End
 * markets" — used by the Social Pulse weekly/monthly workflow.
 *
 * A show is "running" if its status is 'open' or 'previews'.
 * A show is in scope for Social Pulse if its category is 'broadway' or
 * 'west-end'. Shows with null category default to 'broadway' (matches
 * src/lib/market-utils.ts#getMarketLabel behavior — many Broadway shows in
 * the dataset have not yet had their category field backfilled).
 *
 * Off-Broadway and Off-West-End shows are OUT of scope for Social Pulse:
 * social chatter on those markets is too sparse to produce a meaningful
 * tier, and including them would blow the Apify free-tier spend cap.
 */

const fs = require('fs');
const path = require('path');

const SHOWS_PATH = path.join(__dirname, '..', '..', 'data', 'shows.json');

const RUNNING_STATUSES = new Set(['open', 'previews']);
const IN_SCOPE_CATEGORIES = new Set(['broadway', 'west-end']);

/**
 * Resolve a show's effective market category. Matches market-utils.ts#getMarketLabel:
 * a null/missing category defaults to 'broadway'.
 */
function resolveCategory(show) {
  return show.category || 'broadway';
}

/**
 * Returns an array of { id, title, category, status, openingDate, previewsStartDate, venue }
 * for every currently-running Broadway or West End show.
 *
 * Sorted by category, then by id, so the output is stable across runs —
 * important for diffing scheduled workflow output.
 */
function listRunningShows({ showsPath = SHOWS_PATH } = {}) {
  const raw = JSON.parse(fs.readFileSync(showsPath, 'utf-8'));
  if (!raw || !Array.isArray(raw.shows)) {
    throw new Error(`Expected ${showsPath} to contain { shows: [...] }`);
  }

  return raw.shows
    .filter((s) => RUNNING_STATUSES.has(s.status))
    .map((s) => ({
      id: s.id,
      title: s.title,
      category: resolveCategory(s),
      status: s.status,
      openingDate: s.openingDate || null,
      previewsStartDate: s.previewsStartDate || null,
      venue: s.venue || null,
    }))
    .filter((s) => IN_SCOPE_CATEGORIES.has(s.category))
    .sort((a, b) => {
      if (a.category !== b.category) return a.category < b.category ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
}

/**
 * Classifies a show into a cadence bucket for the weekly workflow:
 *   - 'critical' = weekly cadence (new shows, opening windows)
 *   - 'baseline' = monthly cadence (long-runners in Steady tier)
 *
 * Critical windows — a show is 'critical' if either:
 *   1. status === 'previews' (pre-opening buzz building)
 *   2. opened within the last 8 weeks (post-opening settle period)
 *
 * Cold-start handling lives in the workflow (T6), NOT here. The workflow
 * reads data/social-pulse/{id}.json and overrides any show without a
 * mature 8-week baseline to 'critical' until its baseline stabilizes.
 * This helper stays stateless and purely date-deterministic.
 *
 * `now` is passed in (not read from Date.now()) so this function remains
 * pure and unit-testable.
 */
function classifyCadence(show, now) {
  if (show.status === 'previews') return 'critical';

  const eightWeeksAgo = new Date(now);
  eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);

  if (show.openingDate) {
    const opened = new Date(show.openingDate);
    if (!Number.isNaN(opened.getTime()) && opened >= eightWeeksAgo) {
      return 'critical';
    }
  }

  return 'baseline';
}

module.exports = {
  listRunningShows,
  classifyCadence,
  resolveCategory,
  RUNNING_STATUSES,
  IN_SCOPE_CATEGORIES,
};

// CLI entry point: print counts when run directly
if (require.main === module) {
  const shows = listRunningShows();
  const now = new Date();
  const byCategory = {};
  const byCadence = { critical: 0, baseline: 0 };
  for (const s of shows) {
    byCategory[s.category] = (byCategory[s.category] || 0) + 1;
    byCadence[classifyCadence(s, now)]++;
  }
  console.log(`Total running Broadway + West End shows: ${shows.length}`);
  console.log('By category:', byCategory);
  console.log('By cadence:', byCadence);
  const estMonthly = byCadence.critical * 4 * 0.028 + byCadence.baseline * 0.028;
  console.log(`Estimated monthly Apify cost: $${estMonthly.toFixed(2)}`);
}
