#!/usr/bin/env node
/**
 * Sweep stale suspectedMisattribution=true flags off review-text files where
 * the current critic-registry would no longer fire Guard G on them. Identified
 * by `isLikelyStaleSuspectedMisattribution()` from scripts/lib/review-guards.js.
 *
 * Background: Notion 34e637c5-416f-81b8. The critic-registry is regenerated
 * nightly from the corpus by audit-critic-outlets.js, so knownOutlets expands
 * over time as critics accumulate reviews at additional outlets. Files flagged
 * in earlier passes carry the exclusion forever, even after the registry has
 * caught up. The sweep clears the flag where the current registry no longer
 * justifies it.
 *
 * Usage:
 *   node scripts/clear-stale-suspected-misattribution-flags.js [--apply] [--show=ID] [--dir=PATH] [--force-bulk]
 *
 * Default mode is dry-run — prints the list and exits without writing.
 *
 * Surge guard (card #1610, 2026-08-19): refuses to clear more than
 * FIX_SURGE_THRESHOLD files in one run without --force-bulk. This flag is
 * scheduled weekly (clear-stale-suspected-misattribution-flags.yml) and
 * writes unattended to the private review-texts corpus — a spike this size
 * usually means the critic-registry regressed, not routine catch-up drift.
 */
const fs = require('fs');
const path = require('path');
const { isLikelyStaleSuspectedMisattribution, getCriticRegistry } = require('./lib/review-guards');

const FIX_SURGE_THRESHOLD = 25;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE_BULK = args.includes('--force-bulk');
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '';
const DIR_OVERRIDE = (args.find(a => a.startsWith('--dir=')) || '').split('=')[1] || '';

const REVIEW_TEXTS_DIR = DIR_OVERRIDE || path.join(__dirname, '..', 'data', 'review-texts');
const registry = getCriticRegistry();

if (!registry || Object.keys(registry).length === 0) {
  console.error('ERROR: critic-registry empty or missing — cannot evaluate staleness.');
  process.exit(1);
}

const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'));

let scanned = 0;
let flagged = 0;
let stale = 0;
const cleared = [];

for (const d of showDirs) {
  if (SHOW_FILTER && d.name !== SHOW_FILTER) continue;
  const showDir = path.join(REVIEW_TEXTS_DIR, d.name);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
  for (const f of files) {
    scanned++;
    const filePath = path.join(showDir, f);
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
    if (data.suspectedMisattribution !== true) continue;
    flagged++;
    if (!isLikelyStaleSuspectedMisattribution(data, registry)) continue;
    stale++;
    cleared.push({ rel: `${d.name}/${f}`, filePath });
  }
}

console.log(`Scanned: ${scanned} files`);
console.log(`suspectedMisattribution=true: ${flagged}`);
console.log(`Stale (would clear): ${stale}`);

if (APPLY && stale > FIX_SURGE_THRESHOLD && !FORCE_BULK) {
  console.error(`::error::Refusing to auto-clear ${stale} stale suspectedMisattribution flags (> ${FIX_SURGE_THRESHOLD}). A spike this large usually means the critic-registry regressed, not routine drift — auto-clearing would re-admit a flood of reviews to scoring. Investigate the cause, then re-run with --force-bulk if the clears are legitimate.`);
  process.exit(1);
}

if (!APPLY) {
  console.log('\nDRY RUN — pass --apply to write changes.');
  console.log('\nFirst 20 affected files:');
  cleared.slice(0, 20).forEach(c => console.log('  ' + c.rel));
} else {
  const clearedNote = `[${new Date().toISOString().slice(0, 10)} cleared stale suspectedMisattribution — current critic-registry no longer fires Guard G — Notion 34e637c5-416f-81b8]`;
  for (const c of cleared) {
    const orig = fs.readFileSync(c.filePath, 'utf8');
    const hadTrailingNewline = orig.endsWith('\n');
    const data = JSON.parse(orig);
    data.suspectedMisattribution = false;
    data.suspectedMisattributionClearedNote = clearedNote;
    fs.writeFileSync(c.filePath, JSON.stringify(data, null, 2) + (hadTrailingNewline ? '\n' : ''));
  }
  console.log(`\nAPPLIED — cleared ${stale} files.`);
}
