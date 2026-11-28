'use strict';
/**
 * rebuild-target.js: which rebuild a finished scoring run dispatches (BRO-7747).
 *
 * llm-ensemble-score.yml used to pick rebuild-fast.yml only when its caller
 * passed fast_rebuild=true. Most callers never did (ingest-urls via
 * land-ingested-reviews, press-night-watchdog, dispatch-ingest-batch, hand
 * dispatches), so a press-night review was scored and then waited on the
 * full ~15-min rebuild-reviews.yml. On 2026-11-17 (Blue Man Group,
 * TheaterMania) that run was cancelled by hand and rebuild-fast dispatched
 * by hand. Now a run whose show list holds an urgent show (in or near its
 * opening-night window, scoring-lane.js) takes the fast lane on its own.
 *
 * Pure: the caller injects isUrgent. An empty show list is not urgent (a
 * corpus-wide catch-up run keeps the full rebuild), except a plain backlog
 * dispatch, which scores ONLY urgent shows (onlyUrgent, scoring-lane.js).
 * "Urgent" is broad on purpose: it errs toward urgent (72h look-ahead, fresh
 * review evidence), so some non-press-night shows take the fast lane too.
 */

function parseShowIds(raw) {
  return String(raw || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {object} p
 * @param {boolean|string} [p.fastRebuild]  the workflow's fast_rebuild input
 * @param {string|string[]} [p.showIds]     the workflow's show_id input (comma list)
 * @param {(id: string) => boolean} [p.isUrgent]
 * @returns {{ workflow: 'rebuild-fast.yml'|'rebuild-reviews.yml', reason: string, urgentShows: string[] }}
 */
function pickRebuildTarget({ fastRebuild, showIds, onlyUrgent, isUrgent = () => false } = {}) {
  if (fastRebuild === true || fastRebuild === 'true') {
    return { workflow: 'rebuild-fast.yml', reason: 'fast_rebuild input', urgentShows: [] };
  }
  const ids = Array.isArray(showIds) ? showIds.filter(Boolean) : parseShowIds(showIds);
  const urgentShows = ids.filter((id) => {
    try { return Boolean(isUrgent(id)); } catch { return false; }
  });
  if (!ids.length && (onlyUrgent === true || onlyUrgent === 'true')) {
    return { workflow: 'rebuild-fast.yml', reason: 'plain backlog run (urgent shows only)', urgentShows: [] };
  }
  if (urgentShows.length) {
    return { workflow: 'rebuild-fast.yml', reason: `press-night show(s): ${urgentShows.join(',')}`, urgentShows };
  }
  return { workflow: 'rebuild-reviews.yml', reason: 'no urgent show', urgentShows: [] };
}

module.exports = { pickRebuildTarget, parseShowIds };

// CLI for llm-ensemble-score.yml: prints the workflow file on stdout line 1 and
// the reason on line 2. Reads FAST_REBUILD, SHOW_IDS and ONLY_URGENT from the env.
if (require.main === module) {
  require('./cli-help').exitOnHelp(module);
  const { isUrgentShowId } = require('./scoring-lane');
  const res = pickRebuildTarget({
    fastRebuild: process.env.FAST_REBUILD,
    showIds: process.env.SHOW_IDS,
    onlyUrgent: process.env.DISABLE_URGENT_FAST_REBUILD === '1' ? false : process.env.ONLY_URGENT,
    // Kill switch (repo variable DISABLE_URGENT_FAST_REBUILD=1): back to the
    // fast_rebuild-input-only rule without a code change.
    isUrgent: process.env.DISABLE_URGENT_FAST_REBUILD === '1'
      ? () => false
      : (id) => isUrgentShowId(id, { log: (m) => console.error(m) }),
  });
  console.log(res.workflow);
  console.log(res.reason);
}
