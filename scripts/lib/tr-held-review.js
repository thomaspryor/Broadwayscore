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
 *     A sister-paper file only counts when its date is within a week of TR's
 *     (or either date is unknown): the same critic writing for both papers
 *     about one show weeks apart is two reviews. Only consulted when the
 *     review's own outlet has no file (ownFileExists false): an existing
 *     observer-- file stays the merge target and the one the run marks seen.
 */
const { findExistingReviewFile } = require('./review-normalization');
const { CROSS_PUBLICATION_ALLOW } = require('./outlet-mismatch-heal');

const SISTER_DATE_WINDOW_DAYS = 7;

const toTime = (d) => {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isFinite(t) ? t : null;
};

function sameWeek(a, b) {
  const ta = toTime(a);
  const tb = toTime(b);
  if (ta === null || tb === null) return true;
  return Math.abs(ta - tb) <= SISTER_DATE_WINDOW_DAYS * 86400000;
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
    if (hit && sameWeek(hit.data && hit.data.publishDate, date)) return { ...hit, via: 'sister', outletId: sister };
  }
  return null;
}

module.exports = { findHeldUnderRelatedOutlet, sameWeek, SISTER_DATE_WINDOW_DAYS };
