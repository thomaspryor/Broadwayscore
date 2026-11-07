'use strict';
/**
 * scoring-lane.js — which scoring work is urgent, and which runs are plain
 * catch-up (BRO-5047, owner decision 2026-10-11).
 *
 * Owner: routine catch-up scoring waits for the half-price vendor Batch API
 * runs (scheduled crons in llm-ensemble-score.yml); opening-night scoring
 * stays immediate. 992 of 1,000 scoring runs were workflow_dispatch at full
 * price, almost all corpus-wide catch-up from rebuild/collect/gather.
 *
 * - urgentScoringShowIds(): shows in or near their opening-night window. The
 *   same predicate as the opening-night orchestrator, broadened like the local
 *   monitor (untrusted dates, any status, fresh review evidence) and with a
 *   72h look-ahead, so it errs toward "urgent". Reviews for these shows are
 *   never put in a batch.
 * - isPlainBacklogDispatch(): a workflow_dispatch that names no show, no
 *   rescore reason and no action flag. Such a run scores ONLY urgent shows
 *   (and does nothing when there are none); the rest waits for the next cron.
 */
const { selectOpeningNightShows } = require('./opening-night-selection');

function urgentScoringShowIds(shows, { now = new Date(), evidence = null } = {}) {
  const list = Array.isArray(shows) ? shows : [];
  const selected = selectOpeningNightShows(list, {
    now,
    lookAheadHours: 72,
    includeUntrusted: true,
    ignoreStatus: true,
    evidence,
  });
  return new Set(selected.map((s) => s.id).filter(Boolean));
}

/**
 * @param {object} p
 * @param {string} p.eventName  github.event_name
 * @param {string} [p.showId]
 * @param {string} [p.rescoreReason]
 * @param {boolean|string} [p.forceRun]  check-needed's FORCE_RUN (any action flag set)
 * @param {boolean|string} [p.sync]      human escape hatch input
 * @param {object} [p.vars]              { DISABLE_BACKLOG_BATCH, DISABLE_BATCH_SCORING }
 */
function isPlainBacklogDispatch({ eventName, showId, rescoreReason, forceRun, sync, vars = {} } = {}) {
  const on = (v) => v === true || v === 'true' || v === '1';
  if (eventName !== 'workflow_dispatch') return false;
  if (showId || rescoreReason) return false;
  if (on(forceRun) || on(sync)) return false;
  // Kill switches: with batching off there is no cheaper lane to wait for.
  if (on(vars.DISABLE_BACKLOG_BATCH) || on(vars.DISABLE_BATCH_SCORING)) return false;
  return true;
}

/**
 * Is one show urgent right now, read from data/shows.json and the review
 * evidence file (BRO-6532: callers that may defer a show's work). The path is
 * resolved from the repo root, not the cwd. If the data cannot be read the
 * answer is false with a warning: every CI dispatcher has the data, and
 * answering true would switch the cap off for every show in a session or
 * worktree that lacks it.
 */
const DEFAULT_SHOWS_PATH = require('path').join(__dirname, '..', '..', 'data', 'shows.json');
function isUrgentShowId(showId, { showsPath = DEFAULT_SHOWS_PATH, now = new Date(), log = console.log } = {}) {
  try {
    const fs = require('fs');
    const { loadReviewEvidence } = require('./review-evidence');
    const raw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    const shows = Array.isArray(raw) ? raw : (raw.shows || []);
    return urgentScoringShowIds(shows, { now, evidence: loadReviewEvidence() }).has(showId);
  } catch (e) {
    log(`::warning::isUrgentShowId: could not read ${showsPath} (${String(e.message).split('\n')[0]}); treating ${showId} as not urgent`);
    return false;
  }
}

module.exports = { urgentScoringShowIds, isPlainBacklogDispatch, isUrgentShowId };

// CLI for the workflow: prints "true"/"false" from the env the step sets.
if (require.main === module) {
  require('./cli-help').exitOnHelp(module);
  console.log(String(isPlainBacklogDispatch({
    eventName: process.env.EVENT_NAME,
    showId: process.env.SHOW_ID,
    rescoreReason: process.env.RESCORE_REASON,
    forceRun: process.env.FORCE_RUN,
    sync: process.env.SYNC,
    vars: {
      DISABLE_BACKLOG_BATCH: process.env.DISABLE_BACKLOG_BATCH,
      DISABLE_BATCH_SCORING: process.env.DISABLE_BATCH_SCORING,
    },
  })));
}
