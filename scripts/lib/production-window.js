/**
 * Production-window filter for title-keyed audience scrapes (BRO-30).
 *
 * Reddit is searched by title, so a title shared by 2+ productions (revival,
 * transfer, other-market run: Glengarry 2025 Broadway vs 2026 West End) pulls
 * chatter about the sibling. This module scopes posts to THIS production's run
 * window. The fallback floor applies only when an EARLIER sibling exists and the
 * ceiling only when a LATER sibling exists; otherwise behavior is unchanged.
 * (A year-mention filter was tried and dropped: it rejected legit comparisons
 * like "better than the 2012 revival?" on long-running shows.)
 */

const DAY_MS = 86400 * 1000;
const PRE_OPENING_FALLBACK_DAYS = 21; // floor when previewsStartDate is missing
const POST_CLOSING_GRACE_DAYS = 30;

function titleKey(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s*\(.*?\)\s*$/, '')
    .trim();
}

function yearOf(d) {
  const m = /^(\d{4})/.exec(d || '');
  return m ? Number(m[1]) : null;
}

function toMs(d) {
  const t = d ? Date.parse(d) : NaN;
  return Number.isNaN(t) ? null : t;
}

/** Other shows with the same base title and a different id. */
function findTitleSiblings(show, allShows) {
  const key = titleKey(show.title);
  if (!key) return [];
  return (allShows || []).filter(s => s && s.id !== show.id && titleKey(s.title) === key);
}

function startMs(show) {
  const p = toMs(show.previewsStartDate || show.previewDate);
  return p != null ? p : toMs(show.openingDate);
}

/**
 * @returns {{floorSec:number|null, ceilSec:number|null, hasSiblings:boolean}}
 * floorSec: explicit previews start always wins; else opening-21d, only if an
 *   earlier-starting sibling exists (nothing to cut otherwise).
 * ceilSec: closing+30d, only if a sibling starts after this show closes.
 */
function computeProductionWindow(show, allShows) {
  const siblings = findTitleSiblings(show, allShows);
  const hasSiblings = siblings.length > 0;
  const mineStart = startMs(show);
  const closing = toMs(show.closingDate);
  const opening = toMs(show.openingDate);
  const previews = toMs(show.previewsStartDate || show.previewDate);

  let floorMs = previews;
  if (floorMs == null && opening != null && mineStart != null
      && siblings.some(s => { const t = startMs(s); return t != null && t < mineStart; })) {
    floorMs = opening - PRE_OPENING_FALLBACK_DAYS * DAY_MS;
  }
  let ceilMs = null;
  if (closing != null && siblings.some(s => { const t = startMs(s); return t != null && t > closing; })) {
    ceilMs = closing + POST_CLOSING_GRACE_DAYS * DAY_MS;
  }
  return {
    floorSec: floorMs == null ? null : floorMs / 1000,
    ceilSec: ceilMs == null ? null : ceilMs / 1000,
    hasSiblings,
  };
}

/** Decide whether a Reddit post belongs to this production's run window. */
function isPostInProductionWindow(post, show, window) {
  if (!window) return true;
  const t = post.created_utc;
  if (t && window.floorSec != null && t < window.floorSec) return false;
  if (t && window.ceilSec != null && t > window.ceilSec) return false;
  return true;
}

module.exports = {
  titleKey,
  findTitleSiblings,
  computeProductionWindow,
  isPostInProductionWindow,
  PRE_OPENING_FALLBACK_DAYS,
  POST_CLOSING_GRACE_DAYS,
};
