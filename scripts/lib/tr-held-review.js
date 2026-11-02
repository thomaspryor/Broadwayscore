/**
 * BRO-6507: is a Theatre Record review already held under another outlet's
 * file? Two cases, both "held, not new":
 *
 *  1. The parent label (daily-mail for a Mail on Sunday critic) until the
 *     outlet-mismatch heal moves it (the original extractor rule).
 *  2. A sister paper that publishes on the same site (CROSS_PUBLICATION_ALLOW:
 *     Observer on theguardian.com, Sunday Times on thetimes.co.uk, ...). A
 *     SERP/API writer files by host, so TR's "Observer / Susannah Clapp" for
 *     42nd Street (2017) sits in guardian--susannah-clapp.json. Without this
 *     the extractor would write observer--susannah-clapp.json, a second copy.
 *     A sister-paper file only counts with full proof (isSisterCopy): its
 *     stored outletId is the sister, both sides name the same real critic,
 *     and both dates are known and within a week. Anything less is new.
 *     Only consulted when the review's own outlet has no file (ownFileExists false): an existing
 *     observer-- file stays the merge target and the one the run marks seen.
 */
const { findExistingReviewFile, isConfirmedNamedCriticMatch } = require('./review-normalization');
const { CROSS_PUBLICATION_ALLOW } = require('./outlet-mismatch-heal');
const { stripOrdinals } = require('./date-utils');

const SISTER_DATE_WINDOW_DAYS = 7;

// "2017-04-09", "April 9th, 2017", "9 April 2017" -> ms; null when unparseable.
const toTime = (d) => {
  if (!d || typeof d !== 'string') return null;
  const t = Date.parse(stripOrdinals(d.trim()));
  return Number.isFinite(t) ? t : null;
};

/** Both dates known and within the window. An unknown date is NOT a match. */
function sameWeek(a, b) {
  const ta = toTime(a);
  const tb = toTime(b);
  if (ta === null || tb === null) return false;
  return Math.abs(ta - tb) <= SISTER_DATE_WINDOW_DAYS * 86400000;
}

/**
 * A sister file only counts as this review with full proof: it really is the
 * sister's file (stored outletId, not an alias such as sunday-times under a
 * times-uk lookup), both sides name the same real critic (an --unknown file
 * is never a match), and both dates are known and within a week.
 */
function isSisterCopy(hit, sister, critic, date) {
  const data = hit && hit.data;
  if (!data || data.outletId !== sister) return false;
  if (!isConfirmedNamedCriticMatch(critic, typeof data.criticName === 'string' ? data.criticName : '')) return false;
  return sameWeek(data.publishDate, date);
}

/**
 * @param {string} showDir
 * @param {{ parentOutletId: string, outletId: string, critic: string, date?: string|null, ownFileExists?: boolean }} review
 *   date is ISO (YYYY-MM-DD) when known; ownFileExists = a file under outletId
 *   itself (exact or variant) already holds it.
 * @returns {{ path: string, data: object|null, via: 'parent'|'sister', outletId: string } | null}
 */
function findHeldUnderRelatedOutlet(showDir, { parentOutletId, outletId, critic, date = null, ownFileExists = false }, find = findExistingReviewFile) {
  if (parentOutletId && parentOutletId !== outletId) {
    const hit = find(showDir, parentOutletId, critic);
    if (hit) return { ...hit, via: 'parent', outletId: parentOutletId };
  }
  if (ownFileExists) return null;
  for (const sister of CROSS_PUBLICATION_ALLOW[outletId] || []) {
    if (sister === outletId || sister === parentOutletId) continue;
    const hit = find(showDir, sister, critic);
    if (isSisterCopy(hit, sister, critic, date)) return { ...hit, via: 'sister', outletId: sister };
  }
  return null;
}

module.exports = { findHeldUnderRelatedOutlet, isSisterCopy, sameWeek, SISTER_DATE_WINDOW_DAYS };
