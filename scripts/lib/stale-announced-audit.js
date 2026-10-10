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


// Reviews already triaged as belonging to a DIFFERENT show, or to a different
// production of it, are not evidence that THIS show has opened - they are
// contamination a rebuild already drops. Counting them produced 19 of 43
// stale-announced flags on shows whose every review file was flagged out
// (measured 2026-08-31; e.g. private-lives-2025 had 23 files, all 23 flagged).
//
// Every OTHER exclusion reason still counts as evidence. A truncated,
// paywalled or otherwise unscoreable review is still a real critic writing
// about this production, which is exactly the signal this audit wants.
//
// Rule names come from review-guards.explainExclusion, the single
// implementation of the includability decision. Never re-test the raw
// wrongShow/wrongProduction flags here
// (memory/feedback_includability_predicates_must_be_canonical.md).
const NOT_EVIDENCE_OF_OPENING = new Set(['wrongShow', 'wrongProduction']);

/**
 * True when a parsed review-text record is evidence that its show has opened.
 *
 * @param {object} data parsed review-text JSON
 * @param {(d: object) => (string|null)} explainExclusion review-guards'
 *   canonical exclusion explainer, injected so this stays a pure function and
 *   this lib keeps no heavy require.
 * @returns {boolean}
 */
function isEvidenceOfOpening(data, explainExclusion, show) {
  if (!data || typeof data !== 'object') return true;
  // `show` is forwarded because explainExclusion's wrongShow/wrongProduction
  // rules consult show metadata for their stale-flag recovery paths. Calling it
  // with data alone would discount a review whose flag the guard itself would
  // have cleared.
  return !NOT_EVIDENCE_OF_OPENING.has(explainExclusion(data, show));
}

/**
 * The review-texts signal: does this show have at least one collected review
 * that is evidence it opened?
 *
 * This lives here, not in the audit script, because scripts/audit-stale-announced-shows.test.mjs
 * used to inline its own copy of the rule (`readdirSync(dir).some(f => f.endsWith('.json'))`).
 * That copy is why fixing the script alone left the acceptance test asserting
 * the OLD behaviour and CI still red — the exact failure CLAUDE.md §15 exists
 * to prevent. Script and test now both call this.
 *
 * @param {string} reviewTextsDir absolute path to data/review-texts
 * @param {string} showId
 * @param {(d: object, show?: object) => (string|null)} explainExclusion
 * @param {object} [show] the show record, forwarded to explainExclusion
 * @returns {boolean}
 */
function hasEvidenceOfOpening(reviewTextsDir, showId, explainExclusion, show) {
  return describeOpeningEvidence(reviewTextsDir, showId, explainExclusion, show).hasEvidence;
}

/**
 * Same decision as hasEvidenceOfOpening, plus the counts behind it.
 *
 * A show whose review files ALL got discounted looks identical, from the
 * flag list alone, to a show with no review files at all — and those are very
 * different situations. The second is normal; the first means the only signal
 * this show ever had was thrown away, and if those flags are false positives
 * (the LLM wrongProduction FP rate is material) the show sits 'announced'
 * forever with nothing pointing at it. Reporting the counts is what keeps the
 * discount from being a silent hole.
 *
 * @returns {{hasEvidence: boolean, reviewFiles: number, excludedFiles: number}}
 */
function describeOpeningEvidence(reviewTextsDir, showId, explainExclusion, show) {
  const dir = path.join(reviewTextsDir, showId);
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return { hasEvidence: false, reviewFiles: 0, excludedFiles: 0 };
  }
  let excluded = 0;
  let hasEvidence = false;
  for (const f of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      // Unreadable file: something collected it, so treat it as evidence
      // rather than silently weakening the signal. This audit's safe
      // direction is to over-flag, never to go quiet.
      hasEvidence = true;
      continue;
    }
    if (isEvidenceOfOpening(data, explainExclusion, show)) hasEvidence = true;
    else excluded++;
  }
  return { hasEvidence, reviewFiles: files.length, excludedFiles: excluded };
}

module.exports = {
  ACK_PATH,
  loadAcks,
  isAcked,
  addAck,
  saveAcks,
  daysSince,
  evaluateAnnouncedShow,
  isEvidenceOfOpening,
  hasEvidenceOfOpening,
  describeOpeningEvidence,
  NOT_EVIDENCE_OF_OPENING,
};
