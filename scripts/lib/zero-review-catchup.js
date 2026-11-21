/**
 * Pure selection logic for update-show-status.yml's catchup-zero-review-shows
 * job (BRO-3389). Extracted from an inline `node -e` block that had no upper
 * age bound and no attempt memory — it re-dispatched the same handful of
 * long-open zero-review shows every day forever (four Off-Broadway shows sat
 * in the batch for 7-19 months, each dispatch burning a gather-reviews run
 * that timed out finding nothing, because the underlying reviews genuinely
 * don't exist to find).
 *
 * Three independent reasons a zero-review open show is excluded from the
 * dispatch batch, so callers can log/warn on each separately instead of the
 * show just silently never appearing:
 *   - exempt:  show.noReviewsExpected is set (e.g. a Spanish-language
 *              rotating-repertory production with no English-press coverage)
 *   - tooOld:  opened before the age bound — an old zero-review show is a
 *              status/data problem, not something re-dispatching will fix
 *   - givenUp: attempt memory shows this show has already been retried past
 *              the give-up threshold
 *
 * Closed rows (BRO-4290): a row that goes upcoming/previews -> closed without
 * ever sitting in 'open' during a daily run (Off-West End status flips lag the
 * run; a one-week fringe run can open and close inside the grace window) used
 * to be skipped forever, so it never got a single gather. A closed zero-review
 * row now gets exactly ONE dispatch ever: it must have no attempt-memory entry,
 * be inside the age bound, and fill at most closedPerBatch slots after the
 * open rows. One try means a gather that times out burns the only attempt;
 * that is the price of keeping closed-show spend bounded (<=2 per run; the
 * job has a daily and a weekly cron). Closed slots are reserved, so a full
 * open queue cannot starve them.
 * Closed rows past the age bound are skipped silently (an old closed run is
 * not a status/data problem, so they are not reported as tooOld).
 *
 * Closed rows the OWE promoter built from audit review evidence
 * (promote-owe-venue-candidates.js, discoverySource 'audit-review-evidence',
 * evidenceUrls = the review that proved the show exists) are NOT in this
 * batch: selectEvidenceSeedCandidates() picks them for
 * scripts/seed-evidence-review-stubs.js instead, which fetches only the
 * evidence URL under a hard monthly cap (scripts/lib/evidence-catchup-spend.js).
 *
 * The guard: rows the selector cannot dispatch (no openingDate,
 * previewsStartDate or closingDate) come back as `undated`; open rows still waiting past
 * grace + strandedDays, and closed rows the capped queue will not reach before
 * they pass the age bound, come back as `stranded`, so
 * find-zero-review-catchup-gaps.js can warn (or fail with --fail-on-stranded)
 * instead of a row silently never being gathered.
 */
'use strict';

const { isRecentlyLive } = require('./show-liveness');

// Liveness for the OPEN half of catch-up candidacy: status=open only,
// reproducing the job's historical inline filter by construction (audit
// S7-T7; tests/unit/show-liveness.test.mjs pins the equivalence). Previews
// have no reviews to catch up yet. Closed rows take the separate one-try
// branch in selectCatchupCandidates (BRO-4290).
const CATCHUP_LIVENESS = Object.freeze({ liveStatuses: Object.freeze(['open']), allowClosed: false });

const DEFAULT_AGE_BOUND_DAYS = 90;
const DEFAULT_GRACE_DAYS = 3;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_ATTEMPT_DAYS = 30;
const DEFAULT_BATCH_SIZE = 10;
// Closed backfill: at most 2 closed shows per run (same per-job
// ceiling as the evidence seeder), never more than 5 even when asked.
const DEFAULT_CLOSED_BACKFILL_PER_BATCH = 2;
const MAX_CLOSED_BACKFILL_PER_BATCH = 5;
// An open eligible row still left out of the batch this many days past the
// grace window is reported as stranded.
const DEFAULT_STRANDED_DAYS = 14;
// Evidence seeder: at most 2 closed shows per job (board triage 2026-10-10),
// and never more than 5 even when asked (the CLAUDE.md §8 five-show E2E).
const DEFAULT_EVIDENCE_PER_BATCH = 2;
const MAX_EVIDENCE_PER_BATCH = 5;
// Same literal as AUDIT_EVIDENCE_SOURCE in scripts/promote-owe-venue-candidates.js.
const AUDIT_EVIDENCE_SOURCE = 'audit-review-evidence';

function isEvidencePromoted(s) {
  return s.discoverySource === AUDIT_EVIDENCE_SOURCE
    && Array.isArray(s.evidenceUrls) && s.evidenceUrls.length > 0;
}

function daysSince(iso, nowMs) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return (nowMs - t) / 86400000;
}

/**
 * Give-up decision for one attempt-memory entry: true once EITHER the
 * attempt count or the age of the first attempt crosses its threshold.
 * @param {{attempts?: number, firstAt?: string}} entry
 * @param {number} nowMs
 */
function hasGivenUp(entry, nowMs, opts = {}) {
  if (!entry) return false;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxAttemptDays = opts.maxAttemptDays ?? DEFAULT_MAX_ATTEMPT_DAYS;
  if ((entry.attempts || 0) >= maxAttempts) return true;
  const ageDays = daysSince(entry.firstAt, nowMs);
  return ageDays != null && ageDays >= maxAttemptDays;
}

// Age anchor: openingDate, else previewsStartDate (many Off-West End and
// Off-Broadway rows carry only a first-performance date), else closingDate
// (short fringe runs often list only an end date; gather-reviews.js copes
// with a missing openingDate via productionYear()). An open row anchored on a
// future closingDate waits until it closes and takes the closed branch.
function catchupAnchorDate(s) {
  return s.openingDate || s.previewsStartDate || s.closingDate || null;
}

// Run length in days, for ordering closed candidates (a longer run is more
// likely to have drawn press). Unknown = 0.
function runLengthDays(s) {
  const a = new Date(catchupAnchorDate(s)).getTime();
  const b = new Date(s.closingDate).getTime();
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? (b - a) / 86400000 : 0;
}

/**
 * @param {object[]} shows shows.json entries
 * @param {object[]} reviews reviews.json entries
 * @param {object} attempts attempt-memory map {showId: {attempts, firstAt, lastAt}}
 * @param {object} opts {now, ageBoundDays, graceDays, maxAttempts, maxAttemptDays,
 *   batchSize, closedPerBatch, strandedDays}
 * @returns {{batch: string[], closedBackfill: string[], closedEligible: string[],
 *   tooOld: string[], exempt: string[], givenUp: string[], undated: string[],
 *   stranded: string[]}}
 *   batch = open rows first, then up to closedPerBatch closed rows (closedBackfill);
 *   closedEligible = every closed row that qualifies, before the cap.
 */
function selectCatchupCandidates(shows, reviews, attempts, opts = {}) {
  const now = opts.now ?? Date.now();
  const ageBoundDays = opts.ageBoundDays ?? DEFAULT_AGE_BOUND_DAYS;
  const graceDays = opts.graceDays ?? DEFAULT_GRACE_DAYS;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const closedPerBatch = Math.max(0, Math.min(
    opts.closedPerBatch ?? DEFAULT_CLOSED_BACKFILL_PER_BATCH, MAX_CLOSED_BACKFILL_PER_BATCH));
  const strandedAfterDays = graceDays + (opts.strandedDays ?? DEFAULT_STRANDED_DAYS);
  const attemptMap = attempts || {};

  const reviewCounts = {};
  for (const r of (reviews || [])) {
    if (r && r.showId) reviewCounts[r.showId] = (reviewCounts[r.showId] || 0) + 1;
  }

  const eligible = [];
  const closed = [];
  const tooOld = [];
  const exempt = [];
  const givenUp = [];
  const undated = [];
  const ageOf = {};

  for (const s of (shows || [])) {
    if (!s || reviewCounts[s.id]) continue;
    const isOpen = isRecentlyLive(s, CATCHUP_LIVENESS);
    const isClosed = s.status === 'closed' && !isEvidencePromoted(s);
    if (!isOpen && !isClosed) continue;

    const anchor = catchupAnchorDate(s);
    if (!anchor) {
      if (s.noReviewsExpected) exempt.push(s.id);
      else undated.push(s.id);
      continue;
    }
    // Give initial pipeline discovery a grace window before treating a show
    // as a catch-up candidate at all (unchanged from the original job).
    const ageDays = daysSince(anchor, now);
    if (ageDays == null || ageDays < graceDays) continue;

    if (isClosed) {
      if (ageDays > ageBoundDays) continue;
      if (s.noReviewsExpected) { exempt.push(s.id); continue; }
      if (attemptMap[s.id]) continue; // one dispatch ever
      ageOf[s.id] = ageDays;
      closed.push(s);
      continue;
    }

    if (s.noReviewsExpected) { exempt.push(s.id); continue; }
    if (ageDays > ageBoundDays) { tooOld.push(s.id); continue; }
    if (hasGivenUp(attemptMap[s.id], now, opts)) { givenUp.push(s.id); continue; }
    ageOf[s.id] = ageDays;
    eligible.push(s.id);
  }

  closed.sort((a, b) => runLengthDays(b) - runLengthDays(a));
  const closedEligible = closed.map((s) => s.id);
  const closedTake = Math.min(closedPerBatch, closedEligible.length, batchSize);
  const openBatch = eligible.slice(0, batchSize - closedTake);
  const closedBackfill = closedEligible.slice(0, closedTake);
  const batch = [...openBatch, ...closedBackfill];
  const inBatch = new Set(batch);
  // Closed: stranded when, at closedPerBatch a run (one run a day), the queue
  // reaches the row only after it has passed the age bound. Measured from
  // queue position, not opening age, since a closed row's opening is usually
  // weeks back by the time its status flips.
  const closedStranded = closedPerBatch === 0 ? closedEligible : closedEligible.filter((id, i) =>
    Math.floor(i / closedPerBatch) > ageBoundDays - ageOf[id]);
  const stranded = [
    ...eligible.filter((id) => !inBatch.has(id) && !attemptMap[id] && ageOf[id] > strandedAfterDays),
    ...closedStranded,
    ...undated,
  ];

  return { batch, closedBackfill, closedEligible, tooOld, exempt, givenUp, undated, stranded };
}

/**
 * Closed evidence-promoted rows that still have zero reviews and whose
 * evidence URL has never been fetched by the seeder (BRO-4290). Aged from
 * discoveredAt (these rows often have no openingDate); past the age bound
 * they are dropped silently, since a closed run is not a status/data problem.
 * @param {object[]} shows shows.json entries
 * @param {object[]} reviews reviews.json entries
 * @param {Set<string>} alreadyFetched show ids the seeder has fetched before
 * @param {object} opts {now, ageBoundDays, limit}
 * @returns {{batch: {id: string, url: string}[], exempt: string[], eligible: number}}
 */
function selectEvidenceSeedCandidates(shows, reviews, alreadyFetched, opts = {}) {
  const now = opts.now ?? Date.now();
  const ageBoundDays = opts.ageBoundDays ?? DEFAULT_AGE_BOUND_DAYS;
  const limit = Math.max(0, Math.min(opts.limit ?? DEFAULT_EVIDENCE_PER_BATCH, MAX_EVIDENCE_PER_BATCH));
  const fetched = alreadyFetched || new Set();
  const reviewed = new Set((reviews || []).filter((r) => r && r.showId).map((r) => r.showId));
  const eligible = [];
  const exempt = [];
  for (const s of (shows || [])) {
    if (!s || s.status !== 'closed' || !isEvidencePromoted(s) || reviewed.has(s.id)) continue;
    const sinceDiscovery = daysSince(s.discoveredAt, now);
    if (sinceDiscovery == null || sinceDiscovery > ageBoundDays) continue;
    if (s.noReviewsExpected) { exempt.push(s.id); continue; }
    if (fetched.has(s.id)) continue;
    eligible.push({ id: s.id, url: s.evidenceUrls[0] });
  }
  return { batch: eligible.slice(0, limit), exempt, eligible: eligible.length };
}

module.exports = {
  DEFAULT_AGE_BOUND_DAYS,
  DEFAULT_GRACE_DAYS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_ATTEMPT_DAYS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_CLOSED_BACKFILL_PER_BATCH,
  MAX_CLOSED_BACKFILL_PER_BATCH,
  DEFAULT_STRANDED_DAYS,
  DEFAULT_EVIDENCE_PER_BATCH,
  MAX_EVIDENCE_PER_BATCH,
  AUDIT_EVIDENCE_SOURCE,
  CATCHUP_LIVENESS,
  hasGivenUp,
  selectCatchupCandidates,
  selectEvidenceSeedCandidates,
  isEvidencePromoted,
};
