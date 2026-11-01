#!/usr/bin/env node
'use strict';

/**
 * Joint-review parity audit (BRO-6736): gap rows whose cited URL is live under a
 * different show. Advisory (exit 0) unless --max=N is given and exceeded.
 * Usage: node scripts/audit-joint-review-gap.js [--hosts=regex] [--max=N] [--json]
 */
const fs = require('fs');
const path = require('path');
const { findCitedLiveElsewhere } = require('./lib/joint-review-gap');
const { hasHelpFlag } = require('./lib/cli-help');

const USAGE = 'Usage: node scripts/audit-joint-review-gap.js [--hosts=regex] [--max=N] [--json]';
const argv = process.argv.slice(2);
if (hasHelpFlag(argv)) { console.log(USAGE); process.exit(0); }
const arg = (n) => (argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || null;
const dataDir = path.join(__dirname, '..', 'data');
const gap = JSON.parse(fs.readFileSync(path.join(dataDir, 'audit', 'show-review-gap.json'), 'utf8'));
const reviews = JSON.parse(fs.readFileSync(path.join(dataDir, 'reviews.json'), 'utf8'));
const rows = findCitedLiveElsewhere(gap.results, Array.isArray(reviews) ? reviews : reviews.reviews, { hosts: arg('hosts') ? new RegExp(arg('hosts')) : null });
if (argv.includes('--json')) console.log(JSON.stringify(rows, null, 1));
else {
  for (const r of rows) console.log(`${r.showId}\t${r.url}\tlive under: ${r.liveUnder.join(', ')}`);
  console.log(`${rows.length} cited-not-live row(s) whose URL is live under another show`);
}
const max = arg('max');
if (max !== null && rows.length > Number(max)) process.exit(1);
