#!/usr/bin/env node
/**
 * audit-duplicate-of-url-mismatch.js
 *
 * Flags review files where `duplicateOf` points at a sibling whose URL no
 * longer matches our own. Catches the Sommers/Bernardo failure mode: a stale
 * duplicate flag persists after the URL that triggered the collision has been
 * corrected, silently excluding a legitimate review.
 *
 * Usage:
 *   node scripts/audit-duplicate-of-url-mismatch.js          # Report
 *   node scripts/audit-duplicate-of-url-mismatch.js --fix    # Clear stale flags
 *   node scripts/audit-duplicate-of-url-mismatch.js --json   # JSON output (CI)
 *
 * Exit codes:
 *   0 — no mismatches
 *   1 — mismatches found (CI gate)
 */

const fs = require('fs');
const path = require('path');
const { normalizeUrl } = require('./lib/review-normalization');
const { safeWriteReview } = require('./lib/review-write-guard');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const JSON_OUT = args.includes('--json');
const FORCE_BULK = args.includes('--force-bulk');

// Surge guard: --fix nulls duplicateOf flags, which re-admits those reviews to
// scoring. A handful per day is normal churn. A sudden spike means a producer
// regression (e.g. review-write-guard writing bad pointers, or a mass sibling
// rename) — auto-clearing it would flood scoring with double-counted reviews.
// Above this count, --fix refuses and reddens CI for manual review unless
// --force-bulk is passed. See plan-review pre-mortem (SECONDARY) 2026-05-31.
const FIX_SURGE_THRESHOLD = 25;

function walkShowDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => path.join(root, e.name));
}

function audit() {
  const mismatches = [];
  const showDirs = walkShowDirs(REVIEW_TEXTS_DIR);

  for (const showDir of showDirs) {
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    const cache = {};
    const load = (name) => {
      if (cache[name] !== undefined) return cache[name];
      try { cache[name] = JSON.parse(fs.readFileSync(path.join(showDir, name), 'utf-8')); }
      catch { cache[name] = null; }
      return cache[name];
    };

    for (const file of files) {
      const data = load(file);
      if (!data || !data.duplicateOf) continue;
      if (typeof data.duplicateOf !== 'string' || !data.duplicateOf.endsWith('.json')) continue;

      const sibling = load(data.duplicateOf);
      if (!sibling) {
        mismatches.push({
          showId: path.basename(showDir),
          file,
          duplicateOf: data.duplicateOf,
          reason: 'sibling-missing',
          url: data.url || null,
          siblingUrl: null,
        });
        continue;
      }

      // Compare path WITHOUT the query string. normalizeUrl strips a fixed
      // allow-list of tracking params (utm_*, ref, fbclid, …) but not every
      // outlet's — e.g. WSJ's Google-news-feed `?st=…&mod=googlenewsfeed`,
      // which made a correctly-deduped WSJ review (same article, tracked vs
      // bare URL) flag as a false-positive url-mismatch and flap the CI gate
      // (home-2024/wsj 2026-06-06). A genuine stale flag (the Sommers case —
      // a URL corrected to a DIFFERENT article) differs by PATH, so dropping
      // the query keeps that detection while killing tracking-only noise.
      // Done here (not in normalizeUrl, which is on the scoring watchlist).
      const stripQuery = (u) => u.split('?')[0];
      const a = stripQuery(normalizeUrl(data.url));
      const b = stripQuery(normalizeUrl(sibling.url));
      if (a && b && a !== b) {
        mismatches.push({
          showId: path.basename(showDir),
          file,
          duplicateOf: data.duplicateOf,
          reason: 'url-mismatch',
          url: data.url,
          siblingUrl: sibling.url,
        });
      }
    }
  }

  return mismatches;
}

function fix(mismatches) {
  let cleared = 0;
  for (const m of mismatches) {
    const filePath = path.join(REVIEW_TEXTS_DIR, m.showId, m.file);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const reason = m.reason === 'sibling-missing'
      ? `audit-duplicate-of-url-mismatch.js (--fix) on ${new Date().toISOString().slice(0, 10)}: sibling ${m.duplicateOf} no longer exists`
      : `audit-duplicate-of-url-mismatch.js (--fix) on ${new Date().toISOString().slice(0, 10)}: our URL ${data.url} ≠ sibling ${m.duplicateOf} URL ${m.siblingUrl}`;
    data.duplicateClearReason = reason;
    data.duplicateOf = null;
    data.duplicateReason = null;
    safeWriteReview(filePath, data);
    cleared++;
  }
  return cleared;
}

function main() {
  const mismatches = audit();

  if (JSON_OUT) {
    console.log(JSON.stringify({ count: mismatches.length, mismatches }, null, 2));
    process.exit(mismatches.length === 0 ? 0 : 1);
  }

  if (mismatches.length === 0) {
    console.log('OK: no duplicateOf URL mismatches found');
    process.exit(0);
  }

  console.log(`Found ${mismatches.length} duplicateOf URL mismatch(es):\n`);
  for (const m of mismatches) {
    console.log(`  ${m.showId}/${m.file}`);
    console.log(`    → duplicateOf: ${m.duplicateOf}  (${m.reason})`);
    console.log(`    → our url:     ${m.url}`);
    console.log(`    → sibling url: ${m.siblingUrl}`);
    console.log('');
  }

  if (FIX) {
    if (mismatches.length > FIX_SURGE_THRESHOLD && !FORCE_BULK) {
      console.error(`::error::Refusing to auto-clear ${mismatches.length} stale duplicateOf flags (> ${FIX_SURGE_THRESHOLD}). A spike this large usually means a producer regression, not routine churn — auto-clearing would re-admit a flood of reviews to scoring. Investigate the cause, then re-run with --force-bulk if the clears are legitimate.`);
      process.exit(1);
    }
    const cleared = fix(mismatches);
    console.log(`\nCleared ${cleared} stale duplicateOf flag(s). Re-run rebuild to surface the recovered reviews.`);
    process.exit(0);
  }

  console.log('Run with --fix to clear stale flags.');
  process.exit(1);
}

main();
