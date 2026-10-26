#!/usr/bin/env node
/**
 * The homepage headline ("N scored shows. N critic reviews.") is the site-wide
 * count from getSiteStats, published at /data/site-stats.json for the iOS Home
 * subtitle. This guards the wiring so the headline can't drift back to the
 * Broadway-only getDataStats numbers while the app keeps showing the site-wide ones.
 *
 * Run: node scripts/test-site-stats-wiring.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const page = read('src/app/page.tsx');
assert.match(page, /const siteStats = getSiteStats\(\)/, 'homepage must read getSiteStats');
assert.match(page, /totalShows=\{siteStats\.scoredShows\}/, 'client hero count must be the site-wide scored count');
assert.match(page, /totalReviews=\{siteStats\.totalReviews\}/, 'client review count must be site-wide');
assert.doesNotMatch(page, /stats\.totalShows\.toLocaleString/, 'server headline must not use Broadway-only totalShows');

const core = read('src/lib/data-core.ts');
const fn = core.slice(core.indexOf('export function getSiteStats'));
assert.match(fn.slice(0, 600), /displaysCriticScore/, 'scored shows must use the badge gate (displaysCriticScore)');
assert.match(fn.slice(0, 600), /regionalSlugAllowed/, 'must cover every enabled market, not only Broadway');

assert.match(fn.slice(0, 900), /HIDDEN_LONDON_IDS/, 'must skip shows the market pages hide (ABBA Voyage)');
assert.match(fn.slice(0, 900), /isTourListed/, 'tours count only when listed');

// Every page-wide review count (footer, FAQ schema) must agree with the headline.
assert.match(read('src/app/layout.tsx'), /totalReviews \} = getSiteStats\(\)/, 'footer review count must be site-wide');
assert.match(page, /generateHomepageFAQSchema\(\{ totalShows: siteStats\.scoredShows, totalReviews: siteStats\.totalReviews \}\)/, 'FAQ schema must use the site-wide counts');

const route = read('src/app/data/site-stats.json/route.ts');
assert.match(route, /getSiteStats\(\)/, 'site-stats.json must publish getSiteStats');
assert.match(route, /force-static/, 'site-stats.json must be statically exported');

console.log('site-stats wiring: OK');
