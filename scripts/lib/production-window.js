/**
 * Production-window filter for title-keyed audience scrapes (BRO-30).
 *
 * Reddit is searched by title, so a title shared by 2+ productions (revival,
 * transfer, other-market run: Glengarry 2025 Broadway vs 2026 West End) pulls
 * chatter about the sibling. This module scopes posts to THIS production's run
 * window and rejects posts naming only a sibling production's year.
 * Titles with no siblings are untouched (fallback behavior unchanged).
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

/** Years (opening/previews/closing) this production is live in. */
function productionYears(show) {
  const ys = new Set();
  for (const d of [show.previewsStartDate || show.previewDate, show.openingDate, show.closingDate]) {
    const y = yearOf(d);
    if (y) ys.add(y);
  }
  return ys;
}

/**
 * @returns {{floorSec:number|null, ceilSec:number|null, otherYears:Set<number>, hasSiblings:boolean}}
 * floorSec: explicit previews start always wins; else (siblings only) opening - 21d.
 * ceilSec: (siblings only) closing + 30d, so a later sibling's chatter is cut.
 * otherYears: sibling years not shared by this production.
 */
function computeProductionWindow(show, allShows) {
  const siblings = findTitleSiblings(show, allShows);
  const hasSiblings = siblings.length > 0;
  const previews = toMs(show.previewsStartDate || show.previewDate);
  const opening = toMs(show.openingDate);
  let floorMs = previews;
  if (floorMs == null && hasSiblings && opening != null) floorMs = opening - PRE_OPENING_FALLBACK_DAYS * DAY_MS;
  let ceilMs = null;
  const closing = toMs(show.closingDate);
  if (hasSiblings && closing != null) ceilMs = closing + POST_CLOSING_GRACE_DAYS * DAY_MS;

  const mine = productionYears(show);
  const otherYears = new Set();
  for (const s of siblings) for (const y of productionYears(s)) if (!mine.has(y)) otherYears.add(y);

  return {
    floorSec: floorMs == null ? null : floorMs / 1000,
    ceilSec: ceilMs == null ? null : ceilMs / 1000,
    otherYears,
    hasSiblings,
  };
}

/** True when text names a sibling-only year and none of this production's years. */
function mentionsOnlyOtherProductionYear(text, show, window) {
  if (!window || !window.otherYears || window.otherYears.size === 0) return false;
  const mine = productionYears(show);
  const found = (String(text || '').match(/\b(?:19|20)\d{2}\b/g) || []).map(Number);
  if (found.some(y => mine.has(y))) return false;
  return found.some(y => window.otherYears.has(y));
}

/** Decide whether a Reddit post belongs to this production. */
function isPostInProductionWindow(post, show, window) {
  if (!window) return true;
  const t = post.created_utc;
  if (t && window.floorSec != null && t < window.floorSec) return false;
  if (t && window.ceilSec != null && t > window.ceilSec) return false;
  if (mentionsOnlyOtherProductionYear(`${post.title || ''}`, show, window)) return false;
  return true;
}

module.exports = {
  titleKey,
  findTitleSiblings,
  computeProductionWindow,
  isPostInProductionWindow,
  mentionsOnlyOtherProductionYear,
  PRE_OPENING_FALLBACK_DAYS,
  POST_CLOSING_GRACE_DAYS,
};
