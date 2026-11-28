#!/usr/bin/env node
'use strict';
// BRO-7539 diagnostic: what the Critics Take generator reads for one show.
// Usage: node scripts/diag-take-inputs.js <showId> [outletSubstring]
const fs = require('fs');
const path = require('path');
const { loadReviewTexts } = require('./lib/critic-consensus-inputs');
const { liveOutletKeys } = require('./lib/critic-consensus-eligibility');
const [showId, needle = ''] = process.argv.slice(2);
const root = path.join(__dirname, '..', 'data');
const reviews = JSON.parse(fs.readFileSync(path.join(root, 'reviews.json'), 'utf8'));
const shows = JSON.parse(fs.readFileSync(path.join(root, 'shows.json'), 'utf8')).shows;
const show = shows.find((s) => s.id === showId);
const rows = (reviews.reviews || []).filter((r) => r.showId === showId);
console.log('rows', rows.length, 'own(non-inherited)', rows.filter((r) => !r.inheritedFromShowId).length);
for (const r of rows.filter((x) => (x.outletId || '').includes(needle))) {
  console.log('ROW', JSON.stringify({ o: r.outletId, s: r.assignedScore, src: r.scoreSource, tier: r.contentTier, d: r.publishDate, inh: r.inheritedFromShowId || null, pq: (r.pullQuote || '').slice(0, 80) }));
}
const dir = path.join(root, 'review-texts', showId);
if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter((x) => x.includes(needle))) {
  if (!needle) continue;
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  console.log('FILE', f, JSON.stringify(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === 'string' ? v.length : v]))).slice(0, 700));
}
const live = liveOutletKeys(reviews);
// BRO-7558: the generator filters with the scorer predicate + within-show dedup;
// the write-free audit cannot. Print both so a drift report can be read.
const { isScoreable } = require('./lib/is-scoreable');
const { createWithinShowDedup } = require('./lib/within-show-dedup');
const { normalizeOutlet } = require('./lib/review-normalization');
const { canonicalizeUrlForDedup } = require('./lib/review-guards');
const liveRows = Array.isArray(reviews) ? reviews : reviews.reviews;
const inputs = loadReviewTexts(showId, live, { show, shows, normalizeOutlet, isScoreable, createDedup: createWithinShowDedup, liveRows, fallbackRows: liveRows, canonicalizeUrl: canonicalizeUrlForDedup });
const auditView = loadReviewTexts(showId, live, { show, shows });
console.log('INPUTS (generator)', inputs.length, 'AUDIT VIEW (unfiltered)', auditView.length);
for (const i of inputs.filter((x) => JSON.stringify(x).toLowerCase().includes(needle || '\u0000'))) {
  console.log('INPUT', JSON.stringify(i).slice(0, 400));
}
