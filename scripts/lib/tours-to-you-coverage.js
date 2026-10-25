'use strict';

/**
 * Which Tours To You show pages running-tour discovery reads next, and which
 * have gone too long unread (BRO-4725). Pure; the state lives in
 * data/audit/tour-autocreate.json under discovery.coverage, committed by the
 * landing job, so each daily run continues where the last stopped.
 *
 * coverage: { [slug]: { seenAt: ISO, checkedAt: ISO|null } }
 *   seenAt    first run that listed the page (a new page isn't "stale" at once)
 *   checkedAt last time its HTML was read and evaluated
 */

// A full pass takes about two daily runs (~250 pages, ~6 min of a run at
// ~2.5s a page); four days allows one missed run before the digest says so.
const STALE_DAYS = 4;

const ms = iso => (iso ? Date.parse(iso) : NaN);

/**
 * Pages in reading order: never read first, then pages Tours To You edited
 * since we last read them (`modified`, from the pages API), then the
 * longest-unread. Ties go alphabetically so the order is stable.
 */
function orderForCheck(slugs, coverage = {}, modified = {}) {
  const rank = (slug) => {
    const c = coverage[slug];
    const checked = c ? ms(c.checkedAt) : NaN;
    if (Number.isNaN(checked)) return [0, 0];
    const mod = ms(modified[slug]);
    if (!Number.isNaN(mod) && mod > checked) return [1, checked];
    return [2, checked];
  };
  return [...slugs].sort((a, b) => {
    const [ga, ta] = rank(a);
    const [gb, tb] = rank(b);
    return ga - gb || ta - tb || (a < b ? -1 : a > b ? 1 : 0);
  });
}

/** The next coverage map: only listed pages, new ones seen now, read ones stamped. */
function nextCoverage(prev = {}, slugs, checkedNow = [], now = new Date().toISOString()) {
  const read = new Set(checkedNow);
  const out = {};
  for (const slug of [...slugs].sort()) {
    const p = prev[slug] || {};
    out[slug] = { seenAt: p.seenAt || now, checkedAt: read.has(slug) ? now : (p.checkedAt || null) };
  }
  return out;
}

/** Pages not read for more than `days`, longest-unread first. */
function stalePages(coverage = {}, now = new Date(), days = STALE_DAYS) {
  const limit = now.getTime() - days * 86400000;
  return Object.entries(coverage)
    .map(([slug, c]) => ({ slug, at: ms(c && (c.checkedAt || c.seenAt)), checkedAt: (c && c.checkedAt) || null }))
    .filter(r => Number.isNaN(r.at) || r.at < limit)
    .sort((a, b) => (a.at || 0) - (b.at || 0));
}

module.exports = { STALE_DAYS, orderForCheck, nextCoverage, stalePages };
