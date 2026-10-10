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
// but stays in the snapshot forever, so it can never go silent the way the
// original bug did — it just moves from "page" to "digest line". Bounding the
// report itself would recreate this exact bug at a longer horizon.
const DEFAULT_MAX_ALERT_AGE_DAYS = 21;

// Owner decision 2026-09-13: West End shows get shared in the Sunday roundup
// email to all subscribers regardless of whether their own opening-night
// broadcast ever sends, so a still-unsent West End broadcast past one week is
// no longer worth paging about — unlike Broadway, which has no equivalent
// weekly digest safety net (see wasCoveredByWeeklyRoundup's Broadway
// exclusion above) and keeps the longer default bound.
const WEST_END_MAX_ALERT_AGE_DAYS = 7;

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

/**
 * State for one show, looking past its own record. Every draft is written
 * under several tracker keys that share one draftId (the `market:id[+id]`
 * broadcastKey record plus a mirror per show, see recordDraftCompletion in
 * send-opening-night-broadcast.js), and the reconciler updates them one key at
 * a time. If one GET fails the copies disagree, and reading only the per-show
 * mirror paged the owner for a School Girls email they had already sent from
 * the Resend UI (BRO-4474: the broadway: record said sent, the mirror said
 * draft). A send observed on ANY record of the same draft is a send.
 *
 * Only records with the SAME draftId count, so a stale sibling broadcast (an
 * older combo that was later recreated) can never vouch for a new draft.
 */
function classifyShowBroadcastState(sentShows, showId) {
  const state = classifyBroadcastState((sentShows || {})[showId]);
  if (state === 'sent') return state;
  return sentOnSiblingRecord(sentShows, showId) ? 'sent' : state;
}

/**
 * True when a record OTHER than the show's own per-show mirror observed the
 * send: one sharing the mirror's draftId, or (no mirror at all) a sent
 * `market:a+b` key naming the show. Never consults the mirror's own state,
 * so re-queue gates (send-opening-night-broadcast.js, broadcast-deadline.js)
 * can add it on top of shouldRequeueShow without inheriting this file's
 * different reading of the mirror itself.
 */
function sentOnSiblingRecord(sentShows, showId) {
  const shows = sentShows || {};
  const own = shows[showId];
  for (const [key, rec] of Object.entries(shows)) {
    if (key === showId || !rec) continue;
    if (key.startsWith('preview:') || key.startsWith('overdue-alert:')) continue;
    if (own) {
      if (!own.draftId || rec.draftId !== own.draftId) continue;
    } else {
      // No per-show mirror (recordDraftCompletion always writes one today,
      // but a partial merge could drop it).
      const m = /^[a-z-]+:([^:]+)$/.exec(key);
      if (!m || !m[1].split('+').includes(showId)) continue;
    }
    if (classifyBroadcastState(rec) === 'sent') return true;
  }
  return false;
}

/**
 * The record that proves the send for display (sentAt, reviewCount), or null.
 * Status pages used to trust `completed`, which is set at DRAFT creation, so a
 * draft waiting in Resend read "Broadcast sent at Invalid Date" (sentAt null).
 */
function findSentRecord(sentShows, showId, market) {
  const shows = sentShows || {};
  const candidates = [shows[showId], market ? shows[`${market}:${showId}`] : null];
  for (const rec of candidates) if (rec && classifyBroadcastState(rec) === 'sent') return rec;
  const own = shows[showId];
  for (const [key, rec] of Object.entries(shows)) {
    if (key === showId || !rec || key.startsWith('preview:') || key.startsWith('overdue-alert:')) continue;
    const m = /^[a-z-]+:([^:]+)$/.exec(key);
    const related = own && own.draftId ? rec.draftId === own.draftId : !!(m && m[1].split('+').includes(showId));
    if (related && classifyBroadcastState(rec) === 'sent') return rec;
  }
  return null;
}

/**
 * Cross-check alertable 'draft-stuck' shows against Resend before paging
 * (BRO-4474). The tracker is only as fresh as the reconciler's last good poll,
 * so a send the reconciler missed paged the owner for an email they had sent.
 *
 *   live 'sent'    -> dropped from the result (not a missed broadcast)
 *   live 'deleted' -> relabelled 'draft-unknown'. Resend reaps SENT broadcasts
 *                     (~24h), so a 404 on a draft we last saw unsent is the
 *                     ambiguous case, and must get the "verify in Resend first,
 *                     do not re-send" text, never "open the draft and send it"
 *                     at a URL that no longer exists.
 *   anything else, an error, or out of time -> unchanged (pages as before).
 *
 * `fetchStatus(draftId)` resolves to a Resend status string or null on error.
 * `deadlineMs` bounds the WHOLE pass: the sweep runs under a 2-minute step
 * timeout and writes its snapshot and pages only afterwards, so a slow Resend
 * must never cost the day's pages. Returns { missed, confirmedSent, notes }.
 */
async function applyLiveBroadcastStatus(missed, sentShows, fetchStatus, { deadlineMs = 30_000, now = Date.now } = {}) {
  const shows = sentShows || {};
  const stop = now() + deadlineMs;
  const drop = new Set();
  const relabel = new Set();
  const confirmedSent = [];
  const notes = [];
  for (const m of missed) {
    if (!m.alertable || m.state !== 'draft-stuck') continue;
    const draftId = (shows[m.id] || {}).draftId;
    if (!draftId) continue;
    const remaining = stop - now();
    if (remaining <= 0) { notes.push(`${m.id}: live check skipped (time budget spent)`); continue; }
    let timer;
    const status = await Promise.race([
      Promise.resolve().then(() => fetchStatus(draftId)).catch(() => null),
      new Promise((r) => { timer = setTimeout(() => r(null), remaining); }),
    ]);
    clearTimeout(timer);
    if (status === 'sent') { drop.add(m.id); confirmedSent.push(m.id); }
    else if (status === 'deleted') relabel.add(m.id);
    else if (status == null) notes.push(`${m.id}: live check failed or timed out; paging on tracker state`);
  }
  return {
    missed: missed
      .filter((m) => !drop.has(m.id))
      .map((m) => (relabel.has(m.id) ? { ...m, state: 'draft-unknown' } : m)),
    confirmedSent,
    notes,
  };
}

/** Kept for callers that only need the boolean. */
function hasCompletedBroadcast(sentShows, showId) {
  return classifyShowBroadcastState(sentShows, showId) === 'sent';
}

/**
 * True if a West End show was already featured in a Weekly Round-up email
 * ACTUALLY DELIVERED to West End subscribers (data/newsletter-state.json
 * `.issues[].featuredShowIds`) — the same Critics' Take/score/review-count
 * content a redundant force-send would repeat (owner decision 2026-09-08,
 * BRO-3088: West End does not get an individual broadcast as a matter of
 * course when the Round-up already covered it). Broadway has no equivalent
 * weekly digest, so this predicate is only meaningful for West End — callers
 * must gate on category themselves.
 *
 * MUST exclude `edition: 'broadway'` issues. Resend audience is derived
 * strictly from edition in create-broadcast-draft.mjs: `EDITION === 'west-end'
 * ? 'west-end' : 'general'` — two DISTINCT audience lists ("General is the
 * weekly newsletter list. west-end is the smaller WE list."). generate.mjs
 * does render a West End openings section into the Broadway edition during a
 * quiet Broadway week (`quietBroadwayWeek` fallback), which is exactly why
 * the real 2026-08-31 issue that motivated this fix is tagged
 * edition:'broadway' with only West End show ids in featuredShowIds — but
 * that draft went to the 'general' audience, not 'west-end', so it is not
 * proof West End subscribers received it. Treating it as coverage would risk
 * silently suppressing the one channel that actually reaches them, in a
 * future week where a show's ONLY appearance happens to be quiet-week
 * Broadway-edition filler. Every show actually validated against this
 * predicate (electra-persona, the-story, abigails-party, a-month-in-the-
 * country, how-the-other-half-loves-west-end-2026) independently has a
 * properly `edition: 'west-end'`-tagged issue too, so this restriction does
 * not change any confirmed-correct outcome — it only removes a false-positive
 * risk for the next week. Untagged issues (pre edition-split) count, since
 * before the split there was one combined audience.
 */
function wasCoveredByWeeklyRoundup(issues, showId) {
  if (!showId) return false;
  return (issues || []).some((issue) => issue && issue.edition !== 'broadway'
    && Array.isArray(issue.featuredShowIds) && issue.featuredShowIds.includes(showId));
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
  westEndMaxAlertAgeDays = WEST_END_MAX_ALERT_AGE_DAYS,
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

    const state = classifyShowBroadcastState(sentShows, s.id);
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

    // West End gets the shorter bound regardless of state (draft-stuck
    // included) — the Sunday roundup covers it either way. Broadway has no
    // such safety net, so it keeps the full default window. Both bounds are
    // caller-overridable (codex adversarial review, 2026-09-13: a caller
    // passing maxAlertAgeDays for incident recovery/testing was silently
    // ignored for West End before this param existed).
    const ageBound = s.category === 'west-end' ? westEndMaxAlertAgeDays : maxAlertAgeDays;

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
      alertable: roundupCovered ? false : age <= ageBound,
      // Exposed so callers (alert text, digest summaries) never re-derive the
      // category rule themselves — the CLI printing a stale "21 days" for a
      // West End show that actually ages out at 7 was exactly the bug this
      // field exists to prevent.
      ageBoundDays: ageBound,
      draftUrl: ((sentShows || {})[s.id] || {}).draftUrl || null,
    });
  }

  return missed.sort((a, b) => b.daysSinceOpening - a.daysSinceOpening || a.id.localeCompare(b.id));
}

module.exports = {
  findMissedBroadcasts,
  classifyBroadcastState,
  classifyShowBroadcastState,
  sentOnSiblingRecord,
  findSentRecord,
  applyLiveBroadcastStatus,
  wasCoveredByWeeklyRoundup,
  daysSinceOpening,
  hasCompletedBroadcast,
  BROADCAST_CATEGORIES,
  DEFAULT_MIN_AGE_DAYS,
  DEFAULT_MAX_ALERT_AGE_DAYS,
  WEST_END_MAX_ALERT_AGE_DAYS,
  DEFAULT_MAX_REPORT_AGE_DAYS,
  BROADCAST_PIPELINE_EPOCH,
};
