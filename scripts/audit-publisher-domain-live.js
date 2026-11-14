#!/usr/bin/env node
/**
 * audit-publisher-domain-live.js — BRO-4411. Measures the PROBLEM, not the heal
 * rule: reads the LIVE reviews.json (what the site scores) and fails on any row
 * whose URL host belongs to exactly one registry outlet different from the
 * row's outletId (allow-listed sister/syndication pairs, archive/aggregator
 * hosts and critic-established labels excluded, per publisherDomainCorrection).
 *
 * The heal's own dry-run reported 0 while 15 NYT reviews were live as
 * "About Entertainment", because the rule skipped pointer-marked duplicates
 * that the rebuild then recovered. This audit looks at the output instead.
 *
 * Usage: node scripts/audit-publisher-domain-live.js [--file=path/to/reviews.json] [--json]
 * Exit 0 = none, 1 = misattributions found, 2 = unreadable input.
 */
const fs = require('fs');
const path = require('path');
const { publisherDomainCorrection } = require('./lib/outlet-mismatch-heal');

function findMisattributions(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || !r.url || !r.outletId) continue;
    if (r.contentTier === 'invalid') continue; // kept in reviews.json but unscored (wrong production etc.)
    let fix = publisherDomainCorrection({ outletId: r.outletId, outlet: r.outlet, criticName: r.criticName, url: r.url });
    // Independent hard check, not routed through the rule's exemptions.
    let host = '';
    try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch { /* bad url */ }
    if (!fix && r.outletId === 'about-entertainment' && /(^|\.)nytimes\.com$/.test(host)) fix = { outletId: 'nytimes' };
    if (fix) out.push({ showId: r.showId, outletId: r.outletId, shouldBe: fix.outletId, criticName: r.criticName, url: r.url });
  }
  return out;
}

if (require.main === module) {
  const arg = process.argv.find((a) => a.startsWith('--file='));
  const file = arg ? arg.slice(7) : path.join(__dirname, '..', 'data', 'reviews.json');
  let rows;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    rows = Array.isArray(j) ? j : j.reviews;
    if (!Array.isArray(rows) || !rows.length) throw new Error('no reviews array');
  } catch (e) { console.error(`cannot read ${file}: ${e.message}`); process.exit(2); }
  const bad = findMisattributions(rows);
  if (process.argv.includes('--json')) console.log(JSON.stringify(bad, null, 2));
  else for (const b of bad) console.log(`${b.showId}\t${b.outletId} -> ${b.shouldBe}\t${b.criticName}\t${b.url}`);
  console.log(`${rows.length} live rows, ${bad.length} publisher-domain misattributions`);
  process.exit(bad.length ? 1 : 0);
}
module.exports = { findMisattributions };
