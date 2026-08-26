'use strict';

const { isIncludableForRebuild } = require('./review-guards');

/**
 * express-retry-decision.js — pure decision logic for the Opening Night
 * Express same-night retry (card #1889).
 *
 * opening-night-express.yml auto-fires once, immediately, on a show's
 * previews->open transition (dispatched by update-show-status.yml's daily
 * 8am UTC cron). For an evening-opening show that fire lands hours before
 * curtain — real reviews don't publish until ~10pm-1am ET the same night
 * (see opening-night-reviews.yml's own doc comment) — so the run finds next
 * to nothing and, with no retry, the show's full-text upgrade waits on the
 * weekly recollect-for-scores.yml cron (up to 6 days of every T1/T2 critic
 * scored off a cherry-picked aggregator excerpt instead of their actual
 * review). shouldRetryExpress() is the "did this run find enough to skip a
 * retry?" call; the rest are the queue's pure state transitions. The CLI
 * wrapper (scripts/express-retry-queue.js) does the actual disk I/O and
 * workflow dispatch around these.
 */

// Below this fraction of scoreable review records having real body text,
// Express is treated as having landed too early to trust — same threshold
// for "zero found" and "mostly stubs/excerpts", since both leave critics
// scored off aggregator fragments instead of their actual review.
const RETRY_RATIO_THRESHOLD = 0.34;

// Early auto-fire happens ~5-9am ET (8am UTC daily cron + the 0-3h GHA cron
// delay documented in memory/feedback_github_cron_delays.md). Real evening
// reviews land ~10pm-1am ET the same night. +16h from a ~5-9am ET fire lands
// ~9pm-1am ET — inside that window without needing per-show curtain-time
// data. Exposed as a workflow input so it can be tuned without a code change.
const DEFAULT_RETRY_DELAY_HOURS = 16;

// One same-night retry per show is the intent (card #1889 asks for "an early
// one + a same-night retry", not an open-ended loop) — enforced by
// shouldRetryExpress() always refusing to re-enqueue when isRetry is true,
// not by a counter here.
const MAX_RETRY_ATTEMPTS = 1;

const DEFAULT_MAX_QUEUE_AGE_DAYS = 3;

function hasRealText(r) {
  return Boolean(r) && (r.contentTier === 'complete' || r.contentTier === 'truncated');
}

/**
 * Should this Express run enqueue a same-night retry?
 *
 * "Scoreable" is deferred to the canonical `isIncludableForRebuild()` guard
 * (scripts/lib/review-guards.js) rather than a hand-rolled flag check — that
 * guard has ~15 exclusion branches (wrongProduction w/ 3 clear overrides,
 * wrongShow w/ stale-flag override, duplicateOf cycles, isRoundupArticle,
 * bwwAggregatorAmbiguous, rejectedBy, contentTier==='invalid', ...) and
 * reimplementing a subset here would silently diverge from what actually
 * reaches reviews.json (memory/feedback_includability_predicates_must_be_canonical.md).
 *
 * @param {object} args
 * @param {Array<object>} args.reviewFiles parsed review-text JSON records for
 *   one show, as collected by THIS run (data/review-texts/{showId}/*.json).
 * @param {object} [args.show] the show's shows.json entry (enables
 *   isIncludableForRebuild's wrongShow stale-flag override) — defaults to {}.
 * @param {boolean} args.isRetry true when this run is itself a queued retry.
 * @returns {{retry: boolean, thin: boolean, reason: string}} `thin` is the
 *   raw "coverage looks too thin to trust" verdict regardless of isRetry —
 *   the CLI uses it to tell "found enough" apart from "still thin after the
 *   one retry" (the latter should alert, not silently re-enqueue).
 */
function shouldRetryExpress({ reviewFiles, show, isRetry }) {
  const scoreable = (reviewFiles || []).filter((r) => isIncludableForRebuild(r, show || {}));
  let thin;
  let reason;
  if (scoreable.length === 0) {
    thin = true;
    reason = 'zero scoreable review records found';
  } else {
    const realTextCount = scoreable.filter(hasRealText).length;
    const ratio = realTextCount / scoreable.length;
    thin = ratio < RETRY_RATIO_THRESHOLD;
    reason = `${realTextCount}/${scoreable.length} scoreable reviews have real text (${Math.round(ratio * 100)}%)`;
  }
  if (isRetry) {
    return { retry: false, thin, reason: thin ? `still thin after retry — ${reason}` : reason };
  }
  return { retry: thin, thin, reason };
}

/** UTC ISO instant `delayHours` after `nowIso`. */
function computeDueAt(nowIso, delayHours = DEFAULT_RETRY_DELAY_HOURS) {
  return new Date(new Date(nowIso).getTime() + delayHours * 3600 * 1000).toISOString();
}

/**
 * Merge a new retry request into the queue's entry list. Idempotent per
 * showId while one un-attempted retry is already outstanding — a show that
 * finds near-zero coverage on two consecutive evaluate calls (e.g. gather +
 * re-evaluate on a manual re-run) does not get two queued retries.
 *
 * @param {Array<object>} entries current queue entries
 * @param {{showId: string, market: string, nowIso: string, delayHours?: number}} req
 * @returns {{entries: Array<object>, changed: boolean}}
 */
function enqueueRetry(entries, { showId, market, nowIso, delayHours = DEFAULT_RETRY_DELAY_HOURS }) {
  const list = Array.isArray(entries) ? entries : [];
  const alreadyOutstanding = list.some((e) => e.showId === showId && !e.attempted);
  if (alreadyOutstanding) {
    return { entries: list, changed: false };
  }
  const next = list.concat([
    {
      showId,
      market,
      queuedAt: nowIso,
      dueAt: computeDueAt(nowIso, delayHours),
      attempted: false,
    },
  ]);
  return { entries: next, changed: true };
}

/** Entries due for dispatch as of `nowIso` (un-attempted, dueAt <= now). */
function selectDueRetries(entries, nowIso) {
  const nowMs = new Date(nowIso).getTime();
  return (Array.isArray(entries) ? entries : []).filter(
    (e) => !e.attempted && new Date(e.dueAt).getTime() <= nowMs
  );
}

/**
 * Mark one entry (identified by showId + queuedAt, so a show with more than
 * one historical queue entry is disambiguated) attempted.
 *
 * @param {object} [extra] extra fields to merge in (e.g. {skipped: true,
 *   skipReason: 'coverage-already-complete'} when dispatch-due decides a
 *   retry run isn't needed after all rather than actually dispatching one).
 */
function markAttempted(entries, showId, queuedAt, nowIso, extra = {}) {
  return (Array.isArray(entries) ? entries : []).map((e) =>
    e.showId === showId && e.queuedAt === queuedAt
      ? { ...e, ...extra, attempted: true, attemptedAt: nowIso }
      : e
  );
}

/** Drop entries queued more than maxAgeDays ago (attempted or not). */
function pruneStale(entries, nowIso, maxAgeDays = DEFAULT_MAX_QUEUE_AGE_DAYS) {
  const cutoffMs = new Date(nowIso).getTime() - maxAgeDays * 86400000;
  return (Array.isArray(entries) ? entries : []).filter(
    (e) => new Date(e.queuedAt).getTime() >= cutoffMs
  );
}

module.exports = {
  RETRY_RATIO_THRESHOLD,
  DEFAULT_RETRY_DELAY_HOURS,
  MAX_RETRY_ATTEMPTS,
  DEFAULT_MAX_QUEUE_AGE_DAYS,
  hasRealText,
  shouldRetryExpress,
  computeDueAt,
  enqueueRetry,
  selectDueRetries,
  markAttempted,
  pruneStale,
};
