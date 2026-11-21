#!/usr/bin/env node
// BRO-7569 / BRO-7702: full-text rate per major outlet for 2025/2026-production reviews.
// Usage: node scripts/report-outlet-fulltext-gaps.js [--json] [outlet ...]  (outlets => list gap files)
// The coverage rules live in scripts/lib/outlet-fulltext.js (shared with check-outlet-fulltext-floors.js).
const { hasHelpFlag } = require('./lib/cli-help');
if (hasHelpFlag(process.argv)) { console.log('Usage: node scripts/report-outlet-fulltext-gaps.js [--json] [outlet ...]  (read-only; REVIEW_TEXTS_DIR overrides the corpus path)'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const { computeOutletFulltext } = require('./lib/outlet-fulltext');
const root = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const base = fs.existsSync(root + '/data/review-texts') ? root + '/data/review-texts' : root;
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const list = args.filter(a => !a.startsWith('--'));
const { rates: t, gaps } = computeOutletFulltext({ base });
if (asJson) { console.log(JSON.stringify({ rates: t, gaps }, null, 1)); process.exit(0); }
for (const [o, x] of Object.entries(t).sort((a, b) => b[1].n - a[1].n))
  console.log(o.padEnd(16), String(x.n).padStart(4), 'reviews', String(x.full).padStart(4), 'full', String(x.documented).padStart(3), 'terminal', String(x.dupCovered).padStart(3), 'duplicate', x.pct.toFixed(0).padStart(4) + '%', `(floor ${x.floor}%${x.pct < x.floor ? ', BELOW' : ''})`);
for (const o of list) { console.log(`--- gaps: ${o}`); gaps.filter(g => g.outlet === o).forEach(g => console.log(`  ${g.show}/${g.file} [${g.tier}] len=${g.len} ${g.url}`)); }
