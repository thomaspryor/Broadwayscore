#!/usr/bin/env node
/**
 * Apply hand-picked slug-misroute corrections.
 *
 * Reads a whitelist JSON (default `/tmp/move-whitelist.json`, each entry
 * `{ from, to, file }`) and uses `safeRenameReview` from
 * scripts/lib/review-write-guard.js to move each file. That helper:
 *   - refuses to overwrite an existing destination (returns 'conflict')
 *   - respects `_locked: true` (returns 'locked')
 *   - moves the matching `data/llm-scores/{showId}/{file}` sidecar
 *   - rewrites same-show `duplicateTextOf` sibling pointers
 *
 * The plain `git mv` an earlier draft of this plan proposed would have
 * skipped llm-scores + sibling pointers — a P0 finding in the
 * 2026-05-27 ship-check review.
 *
 * Dry-run default. Pass `--apply` to actually move files.
 *
 * Caller responsibilities BEFORE invoking with --apply:
 *   1. Pause cron writers: `scrape-new-aggregators`, `rebuild-fast`,
 *      `enrich-reviews`, `opening-night-orchestrator`, `opening-night-
 *      broadcast`, `collect-review-texts`. (`gh workflow disable <name>`)
 *   2. `cd` into the review-texts private repo clone, ensure clean tree,
 *      `git pull` to head.
 *   3. Run THIS script with --apply. It writes to the private repo.
 *   4. `git add -A && git commit -m "fix: route N misattributed reviews
 *      to correct shows (slug-routing audit)"`
 *   5. `git push` to the private repo.
 *   6. Trigger `Rebuild Reviews (Fast)` to regenerate reviews.json with
 *      the corrected attributions.
 *   7. Re-enable the paused workflows.
 *   8. Spot-check 3 affected show pages live within ~10min.
 */

const fs = require('fs');
const path = require('path');
const { safeRenameReview } = require('./lib/review-write-guard');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const whitelistPath = (args.find(a => a.startsWith('--whitelist=')) || '').replace('--whitelist=', '')
  || '/tmp/move-whitelist.json';

const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR
  || path.join(process.env.HOME || '/tmp', 'broadway-review-texts');

if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
  console.error(`review-texts dir not found: ${REVIEW_TEXTS_DIR}`);
  console.error('Set REVIEW_TEXTS_DIR to override.');
  process.exit(1);
}

if (!fs.existsSync(whitelistPath)) {
  console.error(`Whitelist not found: ${whitelistPath}`);
  console.error('Run scripts/audit-slug-match-routing.js + hand-pick first.');
  process.exit(1);
}

const moves = JSON.parse(fs.readFileSync(whitelistPath, 'utf8'));
if (!Array.isArray(moves) || moves.length === 0) {
  console.error('Whitelist is empty or not an array.');
  process.exit(1);
}

console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log(`review-texts: ${REVIEW_TEXTS_DIR}`);
console.log(`Whitelist: ${whitelistPath} (${moves.length} moves)`);
console.log();

const results = { moved: 0, skipped: 0, errors: 0, byReason: {} };

for (const m of moves) {
  const src = path.join(REVIEW_TEXTS_DIR, m.from, m.file);
  const dst = path.join(REVIEW_TEXTS_DIR, m.to, m.file);

  if (!fs.existsSync(src)) {
    results.skipped++;
    results.byReason['source-missing'] = (results.byReason['source-missing'] || 0) + 1;
    console.log(`  [SKIP source-missing] ${m.from}/${m.file}`);
    continue;
  }

  if (fs.existsSync(dst)) {
    results.skipped++;
    results.byReason['dest-exists'] = (results.byReason['dest-exists'] || 0) + 1;
    console.log(`  [SKIP dest-exists]    ${m.from}/${m.file} → ${m.to}/`);
    continue;
  }

  if (!APPLY) {
    results.moved++;  // counts as "would-move" in dry-run
    console.log(`  [WOULD-MOVE]          ${m.from}/${m.file} → ${m.to}/`);
    continue;
  }

  const r = safeRenameReview(src, dst);
  if (r.wrote && r.renamed) {
    results.moved++;
    const sister = r.sisterStoreMoved ? ' (+llm-score)' : '';
    console.log(`  [MOVED]               ${m.from}/${m.file} → ${m.to}/${sister}`);
  } else {
    results.errors++;
    const reason = r.skipped || 'unknown';
    results.byReason[reason] = (results.byReason[reason] || 0) + 1;
    console.log(`  [ERR ${reason}]        ${m.from}/${m.file}`);
  }
}

console.log();
console.log(`=== Summary ===`);
console.log(`  ${APPLY ? 'Moved' : 'Would move'}: ${results.moved}`);
console.log(`  Skipped:               ${results.skipped}`);
console.log(`  Errors:                ${results.errors}`);
for (const [r, n] of Object.entries(results.byReason)) {
  console.log(`    ${r.padEnd(20)}: ${n}`);
}

if (!APPLY) {
  console.log();
  console.log('Dry-run complete. Re-run with --apply to actually move files.');
}
