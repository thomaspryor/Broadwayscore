/**
 * Decide whether an ensemble scoring run uses the vendor Batch APIs (BRO-5047).
 *
 * Batch bills at 50% but returns in minutes to 24h. Only a run that targets a
 * show in its opening-night window needs a score on the site within minutes;
 * every other run (schedule, backlog, rescore drains, chained backlog) takes
 * the discount. Before this, only `schedule` did, and 992 of the last 1,000
 * runs were workflow_dispatch, so nearly all scoring paid full price.
 *
 * Pure decision (CLAUDE.md rule 15); llm-ensemble-score.yml calls the CLI at
 * the bottom. Kill switch: DISABLE_BATCH_SCORING=1 forces sync.
 */
'use strict';

const OPENING_WINDOW_DAYS_BEFORE = 1; // previews already reviewed / opening tomorrow
const OPENING_WINDOW_DAYS_AFTER = 3;  // reviews keep landing for ~3 days

function parseShowIds(showId) {
  return String(showId || '').split(/[\s,]+/).filter(Boolean);
}

/** True when any targeted show opens within [-3d, +1d] of `now`. */
function targetsOpeningWindow({ showId, shows, now = new Date() }) {
  const ids = new Set(parseShowIds(showId));
  if (!ids.size || !Array.isArray(shows)) return false;
  const day = 86400000;
  for (const s of shows) {
    if (!ids.has(s.id) || !s.openingDate) continue;
    const t = Date.parse(s.openingDate);
    if (Number.isNaN(t)) continue;
    const deltaDays = (now.getTime() - t) / day; // positive = already opened
    if (deltaDays >= -OPENING_WINDOW_DAYS_BEFORE && deltaDays <= OPENING_WINDOW_DAYS_AFTER) return true;
  }
  return false;
}

/**
 * @returns {{mode: 'batch'|'sync', reason: string}}
 */
function decideBatchMode({ eventName, showId, shows, now = new Date(), disableBatch = false, dryRun = false }) {
  if (disableBatch) return { mode: 'sync', reason: 'DISABLE_BATCH_SCORING kill switch' };
  if (dryRun) return { mode: 'sync', reason: 'dry run' };
  if (eventName !== 'schedule' && targetsOpeningWindow({ showId, shows, now })) {
    return { mode: 'sync', reason: 'targets a show in its opening-night window' };
  }
  return { mode: 'batch', reason: eventName === 'schedule' ? 'scheduled run' : 'non-urgent dispatch' };
}

module.exports = { decideBatchMode, targetsOpeningWindow, parseShowIds };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  let shows = [];
  try { shows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'shows.json'), 'utf8')).shows; } catch { /* no data: window unknown, falls to batch */ }
  const e = process.env;
  const d = decideBatchMode({
    eventName: e.EVENT_NAME, showId: e.SHOW_ID, shows,
    disableBatch: e.DISABLE_BATCH_SCORING === '1', dryRun: e.DRY_RUN === 'true',
  });
  console.error(`[scoring-batch-mode] ${d.mode}: ${d.reason}`);
  console.log(d.mode);
}
