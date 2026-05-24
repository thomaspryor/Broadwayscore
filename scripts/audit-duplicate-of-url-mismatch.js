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

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const JSON_OUT = args.includes('--json');

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

      const a = normalizeUrl(data.url);
      const b = normalizeUrl(sibling.url);
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
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
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
    const cleared = fix(mismatches);
    console.log(`\nCleared ${cleared} stale duplicateOf flag(s). Re-run rebuild to surface the recovered reviews.`);
    process.exit(0);
  }

  console.log('Run with --fix to clear stale flags.');
  process.exit(1);
}

main();
