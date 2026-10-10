/**
 * Pure helpers for Resend broadcast state tracking.
 *
 * Motivation: data/opening-night-sent.json used to conflate "draft created" with
 * "broadcast sent" — `completed: true` was set the moment a Resend draft was
 * created, before Tom actually clicked Send. If Tom cancelled the draft in the
 * Resend UI, the tracker still read completed and the show silently never got
 * a follow-up attempt.
 *
 * New schema (additive — existing entries are treated as `sent` on migration):
 *   {
 *     [showId]: {
 *       ...legacy fields...,
 *       draftId:         string,        // Resend broadcast id (existed before)
 *       draftCreatedAt:  ISO string,
 *       draftStatus:     'draft' | 'queued' | 'sending' | 'sent' | 'cancelled' | 'deleted',
 *       sentAt:          ISO string | null,   // populated only on confirmed send
 *       recipientCount:  number | null,       // populated only on confirmed send
 *       completed:       boolean,             // true once draftStatus === 'sent'
 *       lastReconciledAt: ISO string,
 *     }
 *   }
 *
 * The reconciler (scripts/reconcile-broadcast-state.js) polls
 * `GET /broadcasts/{id}` on a cadence and updates the local record via
 * `applyResendStatusUpdate()`. Cancelled/deleted drafts that are older than
 * `REQUEUE_AFTER_HOURS` get re-queued via `shouldRequeueShow()` — the check
 * that send-opening-night-broadcast.js consults before skipping a "completed"
 * show.
 *
 * The 3-layer double-send prevention (memory/feedback_send_lock_pattern.md)
 * still guards every audience-facing path — this module is purely about
 * deciding WHETHER to offer a show to the sender, not about actually sending.
 *
 * CANONICAL PATTERN for API state reconcilers: this file is the reference
 * implementation for the rule "API 404 is not always terminal failure"
 * (memory/feedback_404_not_terminal.md). When writing a new poller that
 * reconciles local "completed"/"sent"/"processed" state against an external
 * API, copy the prior-state differentiation in applyResendStatusUpdate —
 * never flip a success flag on 404 alone.
 */

const REQUEUE_AFTER_HOURS = 12;

// Only 'cancelled' is a user-initiated terminal failure. 'deleted' comes from a
// Resend 404, which ALSO fires on normal retention of successfully-sent
// broadcasts (verified 2026-04-22: the-balusters-2026 was sent clean ~24h
// earlier and already 404'd). Treating a retention 404 as failure and flipping
// completed:false would re-queue the show and double-send after 12h. So
// 'deleted' is a recognized status but NOT terminal failure — see
// applyResendStatusUpdate for how 404s are handled.
const TERMINAL_FAILURE_STATUSES = new Set(['cancelled']);
const SUCCESS_STATUSES = new Set(['sent']);

/**
 * Normalize whatever Resend returns to our vocabulary.
 * Resend API values seen: 'draft', 'queued', 'sending', 'sent', 'cancelled'.
 * HTTP 404 from a deleted broadcast is passed here as status='deleted' by caller.
 */
function parseResendStatus(resendStatus) {
  if (!resendStatus || typeof resendStatus !== 'string') return 'draft';
  const s = resendStatus.toLowerCase();
  if (['draft', 'queued', 'sending', 'sent', 'cancelled', 'deleted'].includes(s)) return s;
  // Unknown status — keep as draft so we don't falsely re-queue or mark complete.
  return 'draft';
}

/**
 * Apply an inferred schema to a legacy record. Never downgrades — a record
 * that already has draftStatus wins. Used at reconciler startup so we can
 * poll brand-new API details against pre-migration records.
 *
 * Contract: legacy `completed: true` with a `draftId` is treated as `sent`,
 * because the only path that used to set completed:true was after successful
 * draft creation followed by Tom's manual send (which we couldn't observe).
 * Being conservative here would double-send old shows — bad.
 */
function migrateSentRecord(record) {
  if (!record || typeof record !== 'object') return record;
  if (record.draftStatus) return record; // already migrated
  const migrated = { ...record };
  if (record.completed === true && record.draftId) {
    migrated.draftStatus = 'sent';
    // sentAt may be absent on legacy entries; best-effort from draftCreatedAt.
    if (!migrated.sentAt) migrated.sentAt = record.draftCreatedAt || record.sentAt || null;
  } else if (record.completed === true) {
    // Legacy entry with no draftId (e.g. manual send before API flow).
    migrated.draftStatus = 'sent';
  } else {
    migrated.draftStatus = 'draft';
  }
  migrated._migratedAt = new Date().toISOString();
  return migrated;
}

/**
 * Given a record + a fresh Resend API response, produce the updated record.
 * Pure. Does NOT mutate the input.
 */
function applyResendStatusUpdate(record, apiResponse, nowIso) {
  if (!record) return record;
  // Defensive migration: migrateSentRecord is idempotent and the reconciler
  // calls it at startup, but a partial write or a non-reconciler code path
  // could hand us a record with no draftStatus. The prior-state checks below
  // depend on draftStatus being set.
  record = migrateSentRecord(record);

  const now = nowIso || new Date().toISOString();
  const status = parseResendStatus(apiResponse && apiResponse.status);

  const next = {
    ...record,
    draftStatus: status,
    lastReconciledAt: now,
  };

  if (status === 'sent') {
    // Resend returns `sent_at` when the broadcast has fully gone out.
    next.sentAt = apiResponse.sent_at || record.sentAt || now;
    next.completed = true;
    if (typeof apiResponse.total_recipients === 'number') {
      next.recipientCount = apiResponse.total_recipients;
    }
  } else if (TERMINAL_FAILURE_STATUSES.has(status)) {
    next.completed = false;
    next.sentAt = null;
  } else if (status === 'deleted') {
    // 404 from Resend. Ambiguous: could be (a) post-send retention reap of a
    // successful broadcast, or (b) the draft was manually deleted pre-send.
    // Differentiate by prior state:
    //   - if the record was previously sent (completed:true + draftStatus:'sent'
    //     OR legacy completed:true), (a) is overwhelmingly the case — Resend
    //     reaps sent broadcasts within hours. Preserve completed.
    //   - otherwise treat it as cancelled so we can re-queue.
    const priorSent =
      record.completed === true &&
      (record.draftStatus === 'sent' || record.draftStatus === undefined);
    if (priorSent) {
      next.completed = record.completed;
      next.sentAt = record.sentAt || null;
    } else {
      next.completed = false;
      next.sentAt = null;
    }
  }
  // draft / queued / sending → leave completed as-is (legacy behavior keeps it
  // true to prevent aggressive re-queues; shouldRequeueShow gates actual re-entry).

  return next;
}

/**
 * Should send-opening-night-broadcast.js re-queue this show despite the
 * `completed: true` flag? Returns true only when the reconciler has explicitly
 * observed a failed final state and enough time has passed for Tom to realize
 * and fix it.
 */
function shouldRequeueShow(record, nowMs) {
  if (!record) return true; // never recorded — definitely pending
  // Belt-and-suspenders: if a broken external writer ever produced
  // { completed:false, draftStatus:'sent' }, do NOT re-queue — the 'sent'
  // status observed by the reconciler is authoritative. applyResendStatusUpdate
  // never produces this state (it forces completed:true on 'sent'), so the
  // guard only matters if something else wrote to the tracker directly.
  if (!record.completed && record.draftStatus === 'sent') return false;
  if (!record.completed) return true; // never sent — definitely pending
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const status = record.draftStatus;
  if (!TERMINAL_FAILURE_STATUSES.has(status)) return false; // healthy completion
  const createdAt = record.draftCreatedAt ? Date.parse(record.draftCreatedAt) : NaN;
  if (!Number.isFinite(createdAt)) return false; // can't date the draft → be safe, don't re-queue
  const ageMs = now - createdAt;
  return ageMs >= REQUEUE_AFTER_HOURS * 3600 * 1000;
}

module.exports = {
  REQUEUE_AFTER_HOURS,
  TERMINAL_FAILURE_STATUSES,
  SUCCESS_STATUSES,
  parseResendStatus,
  migrateSentRecord,
  applyResendStatusUpdate,
  shouldRequeueShow,
};
