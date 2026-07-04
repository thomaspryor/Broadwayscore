#!/usr/bin/env node
/**
 * audit-review-url-clusters.js
 *
 * Flags byline-explosion clusters (see scripts/lib/review-url-clusters.js): one
 * review URL scraped into 5+ files under different critic names. These slip past
 * criticName-keyed dup audits and usually leave the real review unscored
 * (invalid tier + circular duplicateOf). Surfaced the buried WhatsOnStage
 * reviews for the two concurrent 2026 "Midsummer Night's Dream" productions.
 *
 * Usage:
 *   node scripts/audit-review-url-clusters.js            # human report
 *   node scripts/audit-review-url-clusters.js --gate     # exit 1 if any cluster
 *   node scripts/audit-review-url-clusters.js --threshold=5
 */
const fs = require('fs');
const path = require('path');
const { findUrlClusters } = require('./lib/review-url-clusters');

const args = process.argv.slice(2);
const gate = args.includes('--gate');
const threshold = Number((args.find(a => a.startsWith('--threshold=')) || '').split('=')[1]) || 5;
const RT = process.env.REVIEW_TEXTS_DIR
  || path.join(require('os').homedir(), 'broadway-review-texts');

if (!fs.existsSync(RT)) {
  console.error(`review-texts dir not found: ${RT}`);
  process.exit(gate ? 0 : 0); // no data locally is not a gate failure
}

const showDirs = fs.readdirSync(RT).filter(d => {
  const p = path.join(RT, d);
  return !d.startsWith('_') && !d.startsWith('.') && fs.statSync(p).isDirectory();
});

let flagged = 0;
const report = [];
for (const show of showDirs) {
  const dir = path.join(RT, show);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const reviews = [];
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      reviews.push({ file: f, url: r.url, criticName: r.criticName || r.critic, contentTier: r.contentTier });
    } catch { /* skip unreadable */ }
  }
  const clusters = findUrlClusters(reviews, threshold);
  if (clusters.length) {
    flagged += clusters.length;
    report.push({ show, clusters });
  }
}

if (report.length === 0) {
  console.log(`[audit-review-url-clusters] OK — no URL clusters >= ${threshold} across ${showDirs.length} shows.`);
  process.exit(0);
}

console.log(`[audit-review-url-clusters] ${flagged} byline-explosion cluster(s) across ${report.length} show(s) (threshold ${threshold}):\n`);
for (const { show, clusters } of report) {
  console.log(`  ${show}`);
  for (const c of clusters) {
    console.log(`    ${c.count}x same URL (${c.invalidCount} invalid): ${c.url}`);
    console.log(`      bylines: ${c.bylines.join(', ')}`);
  }
}
console.log(`\nFix: collapse each cluster to one canonical review (best byline + valid extraction/star), mark the rest duplicateOf it (non-circular), and re-score.`);

process.exit(gate ? 1 : 0);
