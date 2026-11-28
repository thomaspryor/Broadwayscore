'use strict';

// Show pages are ~2800 of ~2900 routes and the heaviest page type on the site,
// but callers used to hardcode exactly one of them (e.g. /show/hamilton or
// /show/wicked) — so the same single page got checked forever and every other
// show page's regressions went unmonitored. Card #419: hamilton was found
// carrying 645KB of RSC payload; sibling show pages had the identical defect
// with nothing to catch it. Extracted from scripts/check-seo-health.js
// (BRO-175) so the higher-frequency lighthouse-post-deploy.yml gate (card
// #1919) can reuse the same sampling instead of copying the logic.
//
// sampleShowPages() picks a rotating, stratified sample instead: bucketed by
// category (broadway/off-broadway/west-end/off-west-end/regional, so every
// market segment is represented every run) and rotated by a monotonically
// increasing week index (days-since-epoch / 7, NOT the 1-53 ISO week-of-year —
// that would reset every January and re-visit the same ~10 shows per category
// forever), so re-running within the same week is reproducible (stable for
// tests/debugging) while successive weeks work through the full catalog.
const SHOW_PAGE_SAMPLE_SIZE = 12;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

function getRotationIndex(date = new Date()) {
  return Math.floor(date.getTime() / MS_PER_WEEK);
}

function sampleShowPages(shows, { sampleSize = SHOW_PAGE_SAMPLE_SIZE, weekIndex = getRotationIndex() } = {}) {
  const eligible = (Array.isArray(shows) ? shows : []).filter(s => s && typeof s.slug === 'string' && s.slug);
  if (eligible.length === 0) return [];

  const byCategory = new Map();
  for (const show of eligible) {
    const cat = typeof show.category === 'string' && show.category ? show.category : 'unknown';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(show);
  }
  // Stable sort within each bucket so the rotation is reproducible run to run.
  for (const list of byCategory.values()) list.sort((a, b) => a.slug.localeCompare(b.slug));

  const categories = [...byCategory.keys()].sort();
  const perCategory = Math.max(1, Math.floor(sampleSize / categories.length));
  const picks = [];
  for (const cat of categories) {
    const list = byCategory.get(cat);
    for (let i = 0; i < perCategory; i++) {
      picks.push(list[(weekIndex * perCategory + i) % list.length].slug);
    }
  }
  // De-dupe (small categories can wrap onto the same slug twice in one run).
  // The cap is the larger of sampleSize and categories.length so that having
  // more categories than the sample budget (perCategory floors to 1 each)
  // never truncates away whichever categories sort last — every category
  // picked above must survive into the result.
  return [...new Set(picks)].slice(0, Math.max(sampleSize, categories.length));
}

module.exports = { SHOW_PAGE_SAMPLE_SIZE, MS_PER_WEEK, getRotationIndex, sampleShowPages };
