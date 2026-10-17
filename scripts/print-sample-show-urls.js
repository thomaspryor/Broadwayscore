#!/usr/bin/env node
/**
 * Thin CLI wrapper for lighthouse-post-deploy.yml (card #1919): prints 1-2
 * rotating show-page URLs for interpolation into that workflow's bash URLS
 * array, so the per-deploy Lighthouse gate isn't structurally blind to every
 * show page except /show/wicked.
 *
 * Reads the LIVE sitemap (scripts/lib/live-show-slugs.js) rather than
 * checking out the private core-data repo: every picked slug is guaranteed
 * to be an actually-deployed route, and this workflow — which previously had
 * zero data dependencies beyond hitting production URLs — needs no new
 * secret or private-repo checkout. Rotates by day (days-since-epoch), so
 * across the daily cron this gate works through the live catalog over time.
 *
 * Falls back to FALLBACK_SLUG if the sitemap fetch fails or returns nothing
 * (network hiccup, robots.txt/sitemap shape change) — this gate must never
 * silently drop to zero show-page coverage.
 *
 * Usage: node scripts/print-sample-show-urls.js [count]   (default 2)
 */

const { fetchLiveShowSlugs } = require('./lib/live-show-slugs');
const { SITE_HOST } = require('./submit-google-indexing');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FALLBACK_SLUG = 'wicked';

function getDayIndex(date = new Date()) {
  return Math.floor(date.getTime() / MS_PER_DAY);
}

function pickRotatingWindow(slugs, count, dayIndex = getDayIndex()) {
  if (slugs.length === 0) return [FALLBACK_SLUG];
  const start = dayIndex % slugs.length;
  const window = [];
  for (let i = 0; i < count && i < slugs.length; i++) {
    window.push(slugs[(start + i) % slugs.length]);
  }
  return window;
}

async function main() {
  const count = Math.max(1, parseInt(process.argv[2], 10) || 2);
  const slugs = await fetchLiveShowSlugs(SITE_HOST);
  if (slugs.length === 0) {
    console.error(`::warning::print-sample-show-urls.js found 0 live show slugs — falling back to /show/${FALLBACK_SLUG}`);
  }
  for (const slug of pickRotatingWindow(slugs, count)) {
    console.log(`${SITE_HOST}/show/${slug}`);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(`::warning::print-sample-show-urls.js failed (${err.message}) — falling back to /show/${FALLBACK_SLUG}`);
    console.log(`${SITE_HOST}/show/${FALLBACK_SLUG}`);
  });
}

module.exports = { pickRotatingWindow, getDayIndex, FALLBACK_SLUG };
