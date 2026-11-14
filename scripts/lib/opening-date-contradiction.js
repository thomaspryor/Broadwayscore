'use strict';

/**
 * opening-date-contradiction.js: is a show's stored openingDate later than the
 * date its critics actually reviewed it? (BRO-5156)
 *
 * Why this exists
 * ---------------
 * A stored openingDate that is too LATE makes collect-review-texts.js's
 * anticipatory gate flag real first-night reviews wrongProduction
 * ('anticipatory_pre_opening_post'), so they silently drop out of the score.
 * Hercules WE 2025 held 2025-07-10 (theatremonkey) while all 26 dated reviews
 * fell on 2025-06-24..28; five real reviews were held back. Ten more shows had
 * the same shape when this was written.
 *
 * Nothing caught it because the one corrector, infer-press-night-from-reviews.js,
 * only touches UNCONFIRMED sources (date-source-confidence.js). Labels such as
 * 'ibdb' or 'theatremonkey' were often stamped after the fact by
 * one-time-backfill-opening-date-source.js from category alone, so "confirmed"
 * does not mean checked. This predicate ignores the source label and asks the
 * reviews. It only DETECTS; a person verifies press night against Playbill or a
 * dated first-night review and fixes the date with a data-edit plan.
 *
 * Siblings, and why thresholds differ:
 *  - audit-run-contamination.js class6 counts open shows in reviews.json with
 *    2+ outlets 1-14d early: a coarse corpus-drift number, not per-show triage.
 *  - infer-press-night-from-reviews.js reverse branch auto-WRITES a date, so it
 *    is limited to unconfirmed sources. This one writes nothing, so it can look
 *    at every source and needs a bigger, majority cluster instead.
 *
 * Input is the discovery layer (data/review-texts/{showId}/*.json), not
 * reviews.json: the victims are exactly the files the anticipatory gate removed
 * from reviews.json, so they are counted back in here.
 */

const fs = require('fs');
const path = require('path');
const { normalizeDate } = require('./date-utils');
const { estimatePressNight, isCleanDiscoveredReview } = require('./opening-signal');
const { isWithinPriorRun, isWithinTourLeg } = require('./wrong-production-autoclear');

const DAY_MS = 86400000;
const ANTICIPATORY_REASON = 'anticipatory_pre_opening_post';

// Reviews further than this from the stored date are another run's coverage,
// the same 90-day line infer-press-night-from-reviews.js (MAX_GAP_DAYS) draws.
const WINDOW_DAYS = 90;
// Distinct outlets, not files: the corpus holds same-outlet duplicates.
const MIN_OUTLETS = 5;
// A majority of the outlets must be early, so a Talkin' Broadway day-early post
// or one preview-week blog cannot trip it.
const MIN_EARLY_SHARE = 0.6;
// "Early" = more than the Broadway anticipatory grace before the stored date
// (content-filters.js DEFAULT_GRACE_DAYS_BEFORE_OPENING); reviews the morning
// after press night are normal.
const EARLY_DAYS = 2;

const ROOT = path.join(__dirname, '..', '..');
const ACK_PATH = path.join(ROOT, 'data', 'audit', 'opening-date-contradiction-ack.json');

/**
 * Day-precision publish date, or null. Month-only values ('2015-07',
 * 'March 2015') are
 * rejected before normalizeDate, which would resolve them to the 1st and
 * invent an early date. normalizeDate handles 'June 1, 2023',
 * 'December 13th, 2021' and ISO timestamps.
 */
function reviewDay(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}$/.test(s) || /^[A-Za-z]+\.? \d{4}$/.test(s)) return null;
  return normalizeDate(s);
}

/**
 * Press coverage of this run: a clean discovered review, or one whose ONLY
 * problem is the anticipatory pre-opening flag (the flag a too-late stored
 * date produces; counting it is the point).
 */
function countsAsRunReview(review) {
  if (isCleanDiscoveredReview(review)) return true;
  if (!review || review.wrongProduction !== true) return false;
  if (review.wrongProductionReason !== ANTICIPATORY_REASON) return false;
  return isCleanDiscoveredReview({ ...review, wrongProduction: false });
}

function outletKey(review) {
  return review.outletId || review.outlet || review.url || null;
}

/**
 * @param {object} show shows.json row
 * @param {object[]} reviewFiles parsed review-text JSON for that show
 * @returns {null|{id, openingDate, openingDateSource, pressNight, outlets, earlyOutlets}}
 */
function findOpeningDateContradiction(show, reviewFiles) {
  if (!show || !show.openingDate) return null;
  const open = normalizeDate(show.openingDate);
  if (!open) return null;
  const openMs = Date.parse(open);

  // previewsStartDate fences off an earlier production's reviews, but not when
  // it is collapsed onto the stored opening: then it is the same wrong date
  // (Mother Russia OB 2026 stored both as 2026-03-03; previews really began
  // 02-03) and would hide the whole press cluster.
  const previews = show.previewsStartDate ? normalizeDate(show.previewsStartDate) : null;
  const previewsFloor = previews && Date.parse(previews) < openMs - EARLY_DAYS * DAY_MS
    ? previews : null;

  // Earliest in-window date per outlet.
  const byOutlet = new Map();
  for (const review of reviewFiles || []) {
    if (!countsAsRunReview(review)) continue;
    const day = reviewDay(review.publishDate || review.date);
    const key = outletKey(review);
    if (!day || !key) continue;
    if (previewsFloor && day < previewsFloor) continue;
    if (Math.abs(Date.parse(day) - openMs) > WINDOW_DAYS * DAY_MS) continue;
    if (isWithinPriorRun(day, show.priorRuns) || isWithinTourLeg(day, show.tourLegs)) continue;
    const prev = byOutlet.get(key);
    if (!prev || day < prev) byOutlet.set(key, day);
  }

  const days = [...byOutlet.values()];
  if (days.length < MIN_OUTLETS) return null;
  const earlyCutoff = new Date(openMs - EARLY_DAYS * DAY_MS).toISOString().slice(0, 10);
  const early = days.filter((d) => d < earlyCutoff).length;
  if (early / days.length < MIN_EARLY_SHARE) return null;
  const pressNight = estimatePressNight(days);
  if (!pressNight || pressNight >= earlyCutoff) return null;

  return {
    id: show.id,
    openingDate: open,
    openingDateSource: show.openingDateSource || null,
    pressNight,
    outlets: days.length,
    earlyOutlets: early,
  };
}

/** @returns {Array<{id, openingDate, ackedAt, note}>} */
function loadAcks(ackPath = ACK_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ackPath, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
  } catch { /* missing/corrupt: nothing acked */ }
  return [];
}

/**
 * An ack covers one (show, stored date) pair: if the date is later edited the
 * show is re-checked, so an ack can never hide a different wrong date.
 */
function isAcked(finding, acks) {
  return (acks || []).some((a) => a && a.id === finding.id && a.openingDate === finding.openingDate);
}

function addAck(acks, finding, note, nowIso) {
  const kept = (acks || []).filter((a) => a && a.id !== finding.id);
  kept.push({ id: finding.id, openingDate: finding.openingDate, ackedAt: nowIso, note: note || '' });
  return kept;
}

/** Parsed review-text files for one show directory ([] when absent). */
function readShowReviewFiles(reviewTextsDir, showId) {
  const dir = path.join(reviewTextsDir, showId);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('_')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))); } catch { /* skip unreadable */ }
  }
  return out;
}

/**
 * Scan every show. Returns { flagged, acked } (acked kept for visibility).
 */
function scanOpeningDateContradictions(shows, reviewTextsDir, acks) {
  const flagged = [];
  const acked = [];
  for (const show of shows || []) {
    if (!show || !show.openingDate) continue;
    const finding = findOpeningDateContradiction(show, readShowReviewFiles(reviewTextsDir, show.id));
    if (!finding) continue;
    (isAcked(finding, acks) ? acked : flagged).push(finding);
  }
  return { flagged, acked };
}

module.exports = {
  ACK_PATH,
  WINDOW_DAYS,
  MIN_OUTLETS,
  MIN_EARLY_SHARE,
  EARLY_DAYS,
  reviewDay,
  countsAsRunReview,
  findOpeningDateContradiction,
  loadAcks,
  isAcked,
  addAck,
  readShowReviewFiles,
  scanOpeningDateContradictions,
};
