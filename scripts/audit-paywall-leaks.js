#!/usr/bin/env node
/**
 * Scan review-texts for paywall boilerplate leaking into fullText.
 *
 * Uses scripts/lib/paywall-detector.js (positional + outlet-specific markers)
 * to find files where fullText starts with "subscribe/sign in to continue"
 * etc. — a signal that the subscriber cookie failed and the scraper fetched
 * the paywall overlay instead of the article.
 *
 * READ-ONLY. Writes per-run report to data/audit/paywall-leaks.json.
 *
 * Usage:
 *   node scripts/audit-paywall-leaks.js                     # all shows
 *   node scripts/audit-paywall-leaks.js --show=cats-2026    # single show
 *   node scripts/audit-paywall-leaks.js --outlet=wsj        # single outlet fileKey
 *   node scripts/audit-paywall-leaks.js --strict            # exit 2 if any leaks found
 *
 * Usual call site is ops/triage — not in the critical path. Run weekly or
 * after a cookie refresh to confirm the new cookies are breaking the paywall.
 */

const fs = require('fs');
const path = require('path');

const { detectHardPaywall } = require('./lib/paywall-detector');

const args = process.argv.slice(2);
const showFilter = (args.find((a) => a.startsWith('--show=')) || '').split('=')[1] || null;
const outletFilter = (args.find((a) => a.startsWith('--outlet=')) || '').split('=')[1] || null;
const strict = args.includes('--strict');

const REPO_ROOT = path.resolve(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(REPO_ROOT, 'data', 'review-texts');
const OUTPUT_PATH = path.join(REPO_ROOT, 'data', 'audit', 'paywall-leaks.json');

function main() {
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error(`ERROR: ${REVIEW_TEXTS_DIR} not found`);
    process.exit(1);
  }

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name);
  const targets = showFilter ? [showFilter] : showDirs;

  const leaks = [];
  let scanned = 0;

  for (const showId of targets) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try {
      files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json');
    } catch { continue; }

    for (const file of files) {
      if (outletFilter && !file.toLowerCase().includes(outletFilter.toLowerCase())) continue;
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8')); } catch { continue; }
      scanned++;
      if (!data.fullText) continue;
      const result = detectHardPaywall(data.fullText, data.url);
      if (result.detected) {
        leaks.push({
          showId,
          file,
          outlet: data.outlet || data.outletId || '?',
          critic: data.criticName || '-',
          url: data.url || null,
          marker: result.marker,
          reason: result.reason,
          textLength: data.fullText.length,
          textQuality: data.textQuality || null,
          contentTier: data.contentTier || null,
          hasScore: !!(data.llmScore || data.humanReviewScore || data.originalScore),
        });
      }
    }
  }

  console.log(`Scanned ${scanned} review-text files`);
  console.log(`Leaks detected: ${leaks.length}`);

  if (leaks.length > 0) {
    console.log('');
    console.log('Top 20 leaks:');
    for (const l of leaks.slice(0, 20)) {
      console.log(`  ${l.showId}/${l.file} | ${l.outlet} | len=${l.textLength} quality=${l.textQuality} scored=${l.hasScore}`);
      console.log(`    marker: ${l.marker}`);
    }
  }

  try {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify({
      generatedAt: new Date().toISOString(),
      scanned,
      leakCount: leaks.length,
      leaks,
    }, null, 2));
    console.log(`\nWrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
  } catch (e) {
    console.warn(`WARN: failed to write output: ${e.message}`);
  }

  if (strict && leaks.length > 0) process.exit(2);
}

if (require.main === module) main();

module.exports = { main };
