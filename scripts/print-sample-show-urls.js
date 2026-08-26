#!/usr/bin/env node
/**
 * Thin CLI wrapper for lighthouse-post-deploy.yml (card #1919): prints 1-2
 * rotating show-page URLs for interpolation into that workflow's bash URLS
 * array, so the per-deploy Lighthouse gate isn't structurally blind to every
 * show page except /show/wicked. Reuses sampleShowPages() (BRO-175,
 * scripts/lib/sample-show-pages.js) rather than re-deriving its sampling
 * logic — see CLAUDE.md rule 15.
 *
 * Rotation is deliberately INDEPENDENT of check-seo-health.js's weekly index:
 * this workflow fires on every push to main plus a daily cron, far more often
 * than the weekly SEO health check, so a day-granularity rotation index (vs.
 * check-seo-health.js's week-granularity one) works through the catalog
 * faster on this higher-frequency gate. The output is also a rotating WINDOW
 * over sampleShowPages()'s picks (not always its first `count` entries), so
 * this gate doesn't pin to whichever category sorts alphabetically first.
 *
 * Usage: node scripts/print-sample-show-urls.js [count]   (default 2)
 */

const path = require('path');
const { sampleShowPages } = require('./lib/sample-show-pages');
const { SITE_HOST } = require('./submit-google-indexing');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function getDayIndex(date = new Date()) {
  return Math.floor(date.getTime() / MS_PER_DAY);
}

function pickRotatingShowSlugs(shows, count, dayIndex = getDayIndex()) {
  // sampleShowPages()'s `weekIndex` option is just an opaque rotation modulus —
  // deliberately feeding it a day-granularity value here (not a bug to "fix").
  const picks = sampleShowPages(shows, { weekIndex: dayIndex });
  if (picks.length === 0) return [];
  const start = dayIndex % picks.length;
  const window = [];
  for (let i = 0; i < count && i < picks.length; i++) {
    window.push(picks[(start + i) % picks.length]);
  }
  return window;
}

function main() {
  const count = Math.max(1, parseInt(process.argv[2], 10) || 2);
  const shows = require(path.join(__dirname, '../data/shows.json')).shows;
  const slugs = pickRotatingShowSlugs(shows, count);
  for (const slug of slugs) {
    console.log(`${SITE_HOST}/show/${slug}`);
  }
}

if (require.main === module) main();

module.exports = { pickRotatingShowSlugs, getDayIndex };
