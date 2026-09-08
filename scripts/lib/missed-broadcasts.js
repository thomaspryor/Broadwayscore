'use strict';

/**
 * missed-broadcasts.js — finds shows whose opening-night email never reached
 * subscribers, AFTER the broadcast pipeline has stopped looking at them.
 *
 * WHY THIS EXISTS (electra-persona-west-end-2026, opened 2026-09-01):
 * .github/workflows/opening-night-broadcast.yml only considers shows inside a
 * 2-day lookback window (its `find` step, `LOOKBACK=${{ inputs.lookback_days
 * || 2 }}`). That show qualified on review count but its checklist gate found
 * QA errors on every run, so the send was blocked; ~2 days later it left the
 * window and the pipeline stopped considering it. No broadcast, and — because
 * the overdue pager is itself gated on `pending_shows != ''` — no alert
 * either. The owner found out a week later, by noticing that a DIFFERENT
 * show's email had arrived and this one's never had.
 *
 * WHY THE PREDICATE IS DURABLE, NOT EDGE-TRIGGERED:
 * the obvious fix — "page on the show's final day in the window" — was
 * reviewed and rejected. It only fires if a run lands on that specific day AND
 * clears the time gate (runs before 11:00 UTC are skipped) AND the readiness
 * gate AND the overdue step's own 24h per-show dedup, which filters the show
 * out before any escalation branch runs (opening-night-broadcast.yml:851).
 * Four separate ways to silently miss the one moment that mattered. This
 * predicate is true every day until the condition is resolved, so it cannot be
 * missed by not being asked on the right day.
 *
 * WHY IT CLASSIFIES INSTEAD OF RETURNING A BOOLEAN:
 * "no email reached subscribers" has three causes with three different — and
 * NOT interchangeable — remediations. Telling the owner to re-run the
 * broadcast on a show whose draft may already have gone out would double-send
 * to real subscribers (CLAUDE.md §17). See classifyBroadcastState.
 *
 * Pure — no I/O, no clock of its own. scripts/check-missed-broadcasts.js does
 * the file reads and the alert routing (CLAUDE.md §15).
 */

const { migrateSentRecord } = require('./broadcast-state');
const { evaluateBroadcastReadiness } = require('./broadcast-readiness');

// Only these two ever broadcast — mirrors the category allowlist in
// opening-night-broadcast.yml's `find` step and findRecentlyOpenedShows.
// Off-Broadway / off-West-End subscribers did not opt into those markets.
const BROADCAST_CATEGORIES = new Set(['broadway', 'west-end']);

// Wait this many days past opening before calling a show missed. The window is
// 2 days, so 3 means "the pipeline has definitively stopped trying" — never a
// race against a broadcast that is merely late.
const DEFAULT_MIN_AGE_DAYS = 3;

// Bounds ALERTING only, never the report. Past this age a show stops paging
// (a show nobody rescued in three weeks is a backlog item, not an incident)
// but stays in the snapshot forever, so it can never go silent the way the
// original bug did — it just moves from "page" to "digest line". Bounding the
// report itself would recreate this exact bug at a longer horizon.
const DEFAULT_MAX_ALERT_AGE_DAYS = 21;

// The opening-night broadcast pipeline did not exist before this date — the
// earliest record in opening-night-sent.json is 2026-03-19 (62 records checked
// on 2026-09-07). Shows that opened before it never had an opening-night email
// and never will; reporting them as "missed" would bury three real findings
// under 48 entries reaching back to The Phantom of the Opera (1986). This is a
// floor on what the pipeline was ever RESPONSIBLE for, which is why it is a
// fixed date rather than a rolling window.
const BROADCAST_PIPELINE_EPOCH = '2026-03-19';

// Retention for the unbounded-by-alerting report. Past MAX_ALERT_AGE_DAYS a
// show stops paging but stays in the snapshot so it cannot vanish silently the
// way the original bug did; past this it leaves the report too, because a
// months-old never-sent show is neither actionable nor news. Set well clear of
// the alert bound so the digest keeps a real backlog visible.
const DEFAULT_MAX_REPORT_AGE_DAYS = 90;

const MS_PER_DAY = 86_400_000;

/**
 * Whole days between a bare 'YYYY-MM-DD' opening date and `now`, both anchored
 * to UTC midnight. Parsing the parts explicitly (rather than `new Date(str)`
 * plus `setHours`, as the workflow's inline blocks do) keeps this stable
 * regardless of the runner's TZ — that mixed UTC-parse/local-truncate pairing
 * shifts by a day for anyone west of Greenwich.
 */
function daysSinceOpening(openingDate, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(openingDate || ''));
  if (!m) return null;
  const opened = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now);
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((todayUtc - opened) / MS_PER_DAY);
}

/**
 * Why did this show's audience never get mail? Returns one of:
 *
 *   'sent'          — resolved, not reported.
 *   'never-drafted' — the pipeline never produced a Resend draft. THE bug this
 *                     sweep exists for. Safe to re-run the broadcast.
 *   'draft-stuck'   — a draft exists in Resend and was never sent. `completed`
 *                     is set at draft CREATION (recordDraftCompletion in
 *                     send-opening-night-broadcast.js), not at send, so these
 *                     look successful to any check that trusts `completed`
 *                     alone — three West End shows sat in this state for two
 *                     months. Remediation is to press Send in Resend, NOT to
 *                     re-run the pipeline (which would create a second draft).
 *   'draft-unknown' — a draft existed and Resend now 404s it, with no observed
 *                     'sent' poll. Genuinely ambiguous: broadcast-state.js
 *                     documents that Resend reaps SENT broadcasts within hours,
 *                     so this is very often a delivered send whose record was
 *                     merely reaped before the reconciler saw it. MUST NOT be
 *                     told to re-send — that is how you email subscribers
 *                     twice (CLAUDE.md §17).
 *
 * Note the deliberate asymmetry: 'deleted' WITH completed:true is treated as
 * sent, because applyResendStatusUpdate only preserves completed on a 404 when
 * the record was previously observed sent. That is the same reasoning the
 * reconciler uses; it is mirrored here, not re-derived.
 */
function classifyBroadcastState(record) {
  if (!record) return 'never-drafted';
  const m = migrateSentRecord(record);

  if (m.draftStatus === 'sent') return 'sent';
  // Legacy/manual entry with no draft id: migrateSentRecord maps completed:true
  // to 'sent' above, so anything left here without an id was never drafted.
  if (!m.draftId) return m.completed === true ? 'sent' : 'never-drafted';

  if (m.draftStatus === 'deleted') return m.completed === true ? 'sent' : 'draft-unknown';
  // 'cancelled' is a user-initiated terminal failure (broadcast-state.js
  // TERMINAL_FAILURE_STATUSES) and shouldRequeueShow deliberately re-queues it,
  // so it is safe to re-send — same class as never-drafted.
  if (m.draftStatus === 'cancelled') return 'never-drafted';

  return 'draft-stuck'; // draft | queued | sending
}

/** Kept for callers that only need the boolean. */
function hasCompletedBroadcast(sentShows, showId) {
  return classifyBroadcastState((sentShows || {})[showId]) === 'sent';
}

/**
 * True if a West End show was already featured in a Weekly Round-up email
 * (data/newsletter-state.json `.issues[].featuredShowIds`) — the same
 * Critics' Take/score/review-count content a redundant force-send would
 * repeat (owner decision 2026-09-08, BRO-3088: West End does not get an
 * individual broadcast as a matter of course when the Round-up already
 * covered it). Broadway has no equivalent weekly digest, so this predicate is
 * only meaningful for West End — callers must gate on category themselves.
 *
 * Deliberately NOT filtered by `issue.edition`: generate.mjs runs a West End
 * openings section in BOTH editions (primary in the 'west-end' edition,
 * secondary in the 'broadway' one — see that file's EDITION comments), so a
 * 'broadway'-tagged issue can and does carry full West End show cards. The
 * real 2026-08-31 draft that motivated this fix is tagged edition:'broadway'
 * and its featuredShowIds are exactly the three WE shows the owner confirmed
 * were already covered — excluding it here would silently reintroduce this
 * bug for any show whose only coverage happened to land in that edition.
 */
function wasCoveredByWeeklyRoundup(issues, showId) {
  if (!showId) return false;
  return (issues || []).some((issue) => Array.isArray(issue?.featuredShowIds) && issue.featuredShowIds.includes(showId));
}

/**
 * @param {object} args
 * @param {Array}  args.shows     - shows.json `.shows`
 * @param {object} args.sentShows - opening-night-sent.json `.shows`
 * @param {Array}  args.reviews   - reviews.json entries
 * @param {number} args.now       - epoch ms
 * @param {Array}  [args.newsletterIssues] - newsletter-state.json `.issues`
 * @returns {Array<object>} unresolved shows, oldest-opening first. Each carries
 *   `state` (see classifyBroadcastState, plus 'covered-by-roundup') and
 *   `alertable` (within the paging age bound). Empty array is the healthy case.
 */
function findMissedBroadcasts({
  shows,
  sentShows,
  reviews,
  now,
  newsletterIssues = [],
  minAgeDays = DEFAULT_MIN_AGE_DAYS,
  maxAlertAgeDays = DEFAULT_MAX_ALERT_AGE_DAYS,
  maxReportAgeDays = DEFAULT_MAX_REPORT_AGE_DAYS,
  pipelineEpoch = BROADCAST_PIPELINE_EPOCH,
} = {}) {
  const reviewsByShow = new Map();
  for (const r of reviews || []) {
    if (!r || !r.showId) continue;
    const list = reviewsByShow.get(r.showId);
    if (list) list.push(r);
    else reviewsByShow.set(r.showId, [r]);
  }

  const missed = [];
  for (const s of shows || []) {
    if (!s || !s.id || !s.openingDate) continue;
    if (s.status !== 'open') continue;
    if (!BROADCAST_CATEGORIES.has(s.category)) continue;
    // Opera never broadcasts (see findRecentlyOpenedShows) — don't report the
    // absence of a send that is deliberately never attempted.
    if (s.type === 'opera') continue;

    // Pre-pipeline shows are not missed sends — nothing was ever owed to them.
    if (s.openingDate < pipelineEpoch) continue;

    const age = daysSinceOpening(s.openingDate, now);
    if (age === null || age < minAgeDays || age > maxReportAgeDays) continue;

    const state = classifyBroadcastState((sentShows || {})[s.id]);
    if (state === 'sent') continue;

    // The real gate, not a copy of it: Broadway needs 15 AND a DTLI/BWW
    // aggregator, West End needs 12 and no aggregator. Reporting a Broadway
    // show with 13 reviews as a missed send would be a confident lie — it
    // never qualified in the first place.
    const verdict = evaluateBroadcastReadiness(reviewsByShow.get(s.id) || [], s.category);
    if (!verdict.ready) continue;

    // Only the never-drafted case is what the redundant-force-send scenario
    // this exists for looks like — a draft-stuck/draft-unknown show already
    // has Resend-side state that needs a human look regardless of round-up
    // coverage (a stray draft, an ambiguous 404), so don't paper over those.
    const roundupCovered = state === 'never-drafted'
      && s.category === 'west-end'
      && wasCoveredByWeeklyRoundup(newsletterIssues, s.id);

    missed.push({
      id: s.id,
      title: s.title || s.id,
      category: s.category,
      openingDate: s.openingDate,
      daysSinceOpening: age,
      scoredReviews: verdict.count,
      readiness: verdict.reason,
      state: roundupCovered ? 'covered-by-roundup' : state,
      // Suppressed regardless of age — the Round-up already sent subscribers
      // this content, so there is nothing left to page about.
      alertable: roundupCovered ? false : age <= maxAlertAgeDays,
      draftUrl: ((sentShows || {})[s.id] || {}).draftUrl || null,
    });
  }

  return missed.sort((a, b) => b.daysSinceOpening - a.daysSinceOpening || a.id.localeCompare(b.id));
}

module.exports = {
  findMissedBroadcasts,
  classifyBroadcastState,
  wasCoveredByWeeklyRoundup,
  daysSinceOpening,
  hasCompletedBroadcast,
  BROADCAST_CATEGORIES,
  DEFAULT_MIN_AGE_DAYS,
  DEFAULT_MAX_ALERT_AGE_DAYS,
  DEFAULT_MAX_REPORT_AGE_DAYS,
  BROADCAST_PIPELINE_EPOCH,
};
