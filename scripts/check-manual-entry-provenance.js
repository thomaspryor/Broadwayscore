#!/usr/bin/env node
'use strict';
/**
 * BRO-7291 class 5: every hand-entered reviews.json row (manualEntry) must record why it overrides the pipeline
 * (manualEntryReason, written by manual-review-direct.js --reason) unless it is grandfathered in
 * data/audit/manual-entry-baseline.json. Exits 1 when a row is neither. Advisory in test.yml (CLAUDE.md §19).
 *
 *   node scripts/check-manual-entry-provenance.js [--reviews=data/reviews.json] [--baseline=data/audit/manual-entry-baseline.json]
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { manualEntryKey, hasManualProvenance } = require('./lib/manual-entry-merge');

const ROOT = path.join(__dirname, '..');
const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };

/** Manual rows with no recorded reason that are not grandfathered. Pure. */
function unprovenancedRows(reviews, baselineKeys) {
  const base = new Set(baselineKeys || []);
  return reviews.filter((r) => r && r.manualEntry === true && !hasManualProvenance(r) && !base.has(manualEntryKey(r))).map(manualEntryKey);
}

function main() {
  const reviewsPath = path.resolve(ROOT, arg('reviews', 'data/reviews.json'));
  if (!fs.existsSync(reviewsPath)) { console.log('[manual-entry-provenance] no reviews.json, skipped'); return; }
  const data = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(path.resolve(ROOT, arg('baseline', 'data/audit/manual-entry-baseline.json')), 'utf8'));
  const reviews = data.reviews || data;
  const bad = unprovenancedRows(reviews, baseline.keys);
  const manual = reviews.filter((r) => r && r.manualEntry === true).length;
  console.log(`[manual-entry-provenance] ${manual} manual rows, ${baseline.keys.length} grandfathered, ${bad.length} without a reason`);
  for (const k of bad) console.log(`::error::manual reviews.json row without --reason and not grandfathered: ${k}`);
  if (bad.length) process.exit(1);
}

module.exports = { unprovenancedRows };
if (require.main === module) main();
