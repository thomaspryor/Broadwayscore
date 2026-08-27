/**
 * stale-announced-audit.js — decision logic for audit-stale-announced-shows.js
 * (BRO-93). Extracted per CLAUDE.md §15 so scripts/audit-stale-announced-shows.test.mjs
 * exercises the real predicate instead of a copy.
 *
 * Ack mechanism mirrors scripts/lib/t1-scoreboard.js's data/audit/t1-coverage-ack.json
 * pattern: the audit script does NOT auto-flip status (previewsStartDate can
 * legitimately slip and 'announced' can be pre-sale/unconfirmed), so a human who has
 * actually looked at a flagged show records that triage as an ack — a reason the show
 * is known-stale-for-a-good-reason — so the same show doesn't reappear in the report
 * every run. An acked show is still 'announced' in shows.json; the ack only silences
 * the audit, it does not change data.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ACK_PATH = path.join(ROOT, 'data', 'audit', 'stale-announced-shows-ack.json');

/** @returns {Array<{id, ackedAt, note}>} */
function loadAcks() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACK_PATH, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
  } catch { /* missing/corrupt — nothing acked */ }
  return [];
}

function isAcked(showId, acks) {
  return (acks || []).some((a) => a && a.id === showId);
}

/** Pure w.r.t. the input array — returns a new array (append, or refresh the note on re-ack). */
function addAck(acks, id, note, nowIso) {
  const kept = (acks || []).filter((a) => a && a.id !== id);
  kept.push({ id, ackedAt: nowIso, note: note || '' });
  return kept;
}

function saveAcks(acks) {
  fs.mkdirSync(path.dirname(ACK_PATH), { recursive: true });
  fs.writeFileSync(ACK_PATH, JSON.stringify(acks, null, 2) + '\n');
}

function daysSince(dateStr, now) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.floor((now.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Is this 'announced' show stale? Three independent signals, any fires:
 *  - previewsStartDate is set and > staleDays in the past
 *  - openingDate is set and > staleDays in the past (mirrors the date-staleness
 *    check announced-promotion.js's decideAnnouncedPromotion already does for
 *    BOTH dates — a show can be announced with only an openingDate set and no
 *    previewsStartDate, e.g. a straight-to-open transfer, and that case was
 *    silently unflaggable before this)
 *  - the show has a populated data/review-texts/{id}/ directory (hasReviews, injected
 *    so this stays a pure function — the fs read is the caller's job)
 *
 * @param show shows.json entry
 * @param opts { now: Date, staleDays: number, hasReviews: boolean, acks: array }
 * @returns {string[]} reasons (empty = not flagged, including because it's acked)
 */
function evaluateAnnouncedShow(show, opts) {
  const { now, staleDays, hasReviews, acks } = opts || {};
  if (!show || show.status !== 'announced') return [];
  if (isAcked(show.id, acks)) return [];

  const reasons = [];
  const previewsPastDays = show.previewsStartDate ? daysSince(show.previewsStartDate, now) : null;
  if (previewsPastDays !== null && previewsPastDays > staleDays) {
    reasons.push(`previewsStartDate ${show.previewsStartDate} is ${previewsPastDays}d in the past`);
  }
  const openingPastDays = show.openingDate ? daysSince(show.openingDate, now) : null;
  if (openingPastDays !== null && openingPastDays > staleDays) {
    reasons.push(`openingDate ${show.openingDate} is ${openingPastDays}d in the past`);
  }
  if (hasReviews) {
    reasons.push('data/review-texts/ has collected review file(s)');
  }
  return reasons;
}

module.exports = {
  ACK_PATH,
  loadAcks,
  isAcked,
  addAck,
  saveAcks,
  daysSince,
  evaluateAnnouncedShow,
};
