#!/usr/bin/env node
'use strict';
/**
 * slow-market-grade.js (BRO-6687): grade review discovery for one or more
 * openings from the committed hourly gap audit. Read-only; needs no private repos.
 *
 * PASS = every review a source cited (aggregator roundup, WE reference source) is
 * live or legitimately excluded; FAIL = cited reviews still not live, or an
 * automated exclusion a current round-up lists. SERP-census hits are shown for
 * information only: they are unverified search results, not citations.
 *
 * Usage:
 *   node scripts/slow-market-grade.js --show=a,b,c          # print grades
 *   node scripts/slow-market-grade.js --show=a,b --check    # exit 1 on any FAIL / missing row
 *   node scripts/slow-market-grade.js --json                # machine-readable
 */
const fs = require('fs');
const path = require('path');
const { slowMarketListedGap } = require('./lib/slow-market-gap');
const { currentRunOnly } = require('./lib/prior-production-citations');

const ROOT = path.join(__dirname, '..');

function gradeShow(row, liveCount) {
  if (!row) return { grade: 'NO-AUDIT', live: liveCount, notLive: [], census: 0, hiddenAsNonReview: 0 };
  const g = slowMarketListedGap(row);
  return {
    grade: g.residual === 0 ? 'PASS' : 'FAIL',
    live: liveCount,
    notLive: g.rows.map((m) => m.url),
    cited: g.rows.length - g.flaggedOut,
    capped: g.capped,
    reverify: g.flaggedOut,
    census: currentRunOnly(row.missing).filter((m) => m && m.serpCensus).length,
    hiddenAsNonReview: currentRunOnly(row.flaggedMisses).filter((m) => m && m.confirmedNonReview).length,
    auditedAt: row.computedAt || null,
  };
}

function main(argv = process.argv.slice(2)) {
  const showArg = argv.find((a) => a.startsWith('--show='));
  const ids = showArg ? showArg.split('=')[1].split(',').filter(Boolean) : [];
  if (!ids.length) {
    console.error('usage: node scripts/slow-market-grade.js --show=<id[,id...]> [--check] [--json]');
    return 2;
  }
  const audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'audit', 'show-review-gap.json'), 'utf8'));
  const reviews = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reviews.json'), 'utf8')).reviews || [];
  const live = new Map();
  for (const r of reviews) live.set(r.showId, (live.get(r.showId) || 0) + 1);
  const byId = new Map((audit.results || []).map((r) => [r.showId, r]));
  const out = ids.map((id) => ({ showId: id, ...gradeShow(byId.get(id), live.get(id) || 0) }));
  if (argv.includes('--json')) console.log(JSON.stringify({ auditGeneratedAt: audit.generatedAt, shows: out }, null, 2));
  else {
    console.log(`gap audit generated ${audit.generatedAt}`);
    for (const s of out) {
      console.log(`${s.grade.padEnd(8)} ${s.showId}: ${s.live} live, ${s.cited || 0} cited not live${s.capped ? ` (${s.capped} behind the ingest cap)` : ''}${s.reverify ? `, ${s.reverify} automated exclusion(s) to re-verify` : ''}; info: ${s.census} census candidate(s), ${s.hiddenAsNonReview} excluded as non-review${s.auditedAt ? `; audited ${s.auditedAt}` : ''}`);
      for (const u of s.notLive) console.log(`         - ${u}`);
    }
  }
  return argv.includes('--check') && out.some((s) => s.grade !== 'PASS') ? 1 : 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { gradeShow, main };
