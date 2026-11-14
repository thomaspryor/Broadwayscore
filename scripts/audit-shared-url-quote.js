#!/usr/bin/env node
/**
 * audit-shared-url-quote.js (BRO-4594): lists article URLs filed
 * under 2+ shows that share one pull quote and have no per-show score override,
 * i.e. a multi-show column copied whole onto each show. Fix via a
 * data/pending-fixes review-field-edit plan (humanReviewScore + llmPullQuote).
 *
 *   node scripts/audit-shared-url-quote.js           # report
 *   node scripts/audit-shared-url-quote.js --max=N   # exit 1 when groups > N (corpus drift)
 *
 * Exit: 0 report / under --max, 1 over --max, 2 corpus missing.
 */
const fs = require('fs');
const path = require('path');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { listShowDirs } = require('./lib/list-show-dirs');
const { findSharedQuoteGroups } = require('./lib/shared-url-quote-detector');

const RT = resolveReviewTextsDir();
if (!RT || !fs.existsSync(RT)) {
  console.error(`review-texts dir not found: ${RT}`);
  process.exit(2);
}

const records = [];
for (const showId of listShowDirs(RT)) {
  if (showId.startsWith('_')) continue;
  const dir = path.join(RT, showId);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      records.push({ showId, file: f, url: d.url, llmPullQuote: d.llmPullQuote, humanReviewScore: d.humanReviewScore });
    } catch { /* unreadable file: other audits report it */ }
  }
}

const groups = findSharedQuoteGroups(records);
for (const g of groups) {
  console.log(`${g.key}\n  quote: ${g.quote.slice(0, 90)}`);
  for (const r of g.records) console.log(`  ${r.showId}/${r.file}`);
}
console.log(`[audit-shared-url-quote] ${groups.length} shared-quote group(s) across ${records.length} records`);
// Some groups are legitimate rep/joint reviews, so the count only gates against
// a measured baseline (check-corpus-drift.js, BRO-7077): a NEW copied column
// pushes it over --max.
const maxArg = process.argv.slice(2).find((a) => a.startsWith('--max='));
if (maxArg) {
  const max = Number(maxArg.slice(6));
  if (!Number.isFinite(max)) { console.error(`bad ${maxArg}`); process.exit(2); }
  if (groups.length > max) { console.log(`[audit-shared-url-quote] DRIFT: ${groups.length} > --max=${max}`); process.exitCode = 1; }
}
