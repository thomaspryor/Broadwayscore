#!/usr/bin/env node
/**
 * reclassify-invalid-reviews.js — audit (and optionally repair) reviews with
 * contentTier='invalid' by re-running classifyContentTier() on their current
 * fullText. Surfaces reviews that would flip invalid→valid after any recent
 * tightening of content-quality patterns.
 *
 * Also reports the (tier, tierReason) distribution for P2 #3 — systemic
 * over-rejection audit. Many historical 'invalid' reviews have empty/generic
 * tierReasons; this script surfaces which need a better reason and which are
 * genuinely salvageable.
 *
 * Usage:
 *   node scripts/reclassify-invalid-reviews.js            # dry run, report only
 *   node scripts/reclassify-invalid-reviews.js --apply    # write new tier to source files
 *   node scripts/reclassify-invalid-reviews.js --sample 100  # test against subset
 *
 * Exit codes:
 *   0 — audit completed (regardless of flip count)
 *   1 — scan failed (missing data/review-texts, etc.)
 */

const fs = require('fs');
const path = require('path');
const cq = require('./lib/content-quality.js');

function parseArgs(argv) {
  const args = { apply: false, sample: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--sample') args.sample = parseInt(argv[++i], 10);
    else if (a.startsWith('--sample=')) args.sample = parseInt(a.split('=')[1], 10);
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(__filename, 'utf-8').split('\n').slice(2, 22).join('\n'));
      process.exit(0);
    }
  }
  return args;
}

function findDir() {
  const candidates = [
    path.resolve(process.cwd(), 'data/review-texts'),
    path.resolve(__dirname, '../data/review-texts'),
  ];
  for (const d of candidates) {
    try { if (fs.statSync(d).isDirectory()) return d; } catch {}
  }
  console.error('FATAL: data/review-texts not found.');
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv);
  const dir = findDir();
  const showDirs = fs.readdirSync(dir).filter(d => {
    try { return fs.statSync(path.join(dir, d)).isDirectory() && d !== '_pending'; } catch { return false; }
  });

  const pool = args.sample ? showDirs.slice(-args.sample) : showDirs;
  const stats = {
    totalInvalid: 0,
    totalReviews: 0,
    wouldFlipToValid: 0,
    wouldStayInvalid: 0,
    wouldFlipByNewTier: {},   // newTier → count
    // (oldReason, newReason) buckets: key = `${oldReason} → ${newReason}`
    reasonFlips: {},
    // Current state distribution: tierReason → count
    currentReasons: {},
    // Sample of flipped-to-valid reviews for manual inspection
    flipExamples: [],
    // Sample of empty-reason invalid reviews (P2 #3 input)
    emptyReasonExamples: [],
  };

  for (const show of pool) {
    const showDir = path.join(dir, show);
    let files;
    try { files = fs.readdirSync(showDir).filter(f => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      let review;
      const filePath = path.join(showDir, f);
      try { review = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { continue; }
      stats.totalReviews++;
      if (review.contentTier !== 'invalid') continue;
      stats.totalInvalid++;

      const oldReason = review.tierReason || '(empty)';
      stats.currentReasons[oldReason] = (stats.currentReasons[oldReason] || 0) + 1;

      if (oldReason === '(empty)' && stats.emptyReasonExamples.length < 10) {
        stats.emptyReasonExamples.push({
          show, file: f,
          textLen: (review.fullText || '').length,
          textStatus: review.textStatus || null,
          wrongProduction: review.wrongProduction || false,
        });
      }

      // Re-classify with current code
      const result = cq.classifyContentTier(review);
      const newTier = result.contentTier;
      const newReason = result.tierReason || '(empty)';

      if (newTier !== 'invalid') {
        stats.wouldFlipToValid++;
        stats.wouldFlipByNewTier[newTier] = (stats.wouldFlipByNewTier[newTier] || 0) + 1;
        if (stats.flipExamples.length < 10) {
          stats.flipExamples.push({
            show, file: f,
            oldReason,
            newTier,
            newReason,
            textLen: (review.fullText || '').length,
          });
        }

        if (args.apply) {
          review.contentTier = newTier;
          review.tierReason = result.tierReason;
          fs.writeFileSync(filePath, JSON.stringify(review, null, 2) + '\n');
        }
      } else {
        stats.wouldStayInvalid++;
        const flipKey = `${oldReason}  →  ${newReason}`;
        if (oldReason !== newReason) {
          stats.reasonFlips[flipKey] = (stats.reasonFlips[flipKey] || 0) + 1;
        }
      }
    }
  }

  // Report
  console.log(`=== Re-classify invalid reviews — ${args.apply ? 'APPLY' : 'DRY RUN'} ===\n`);
  console.log(`Pool: ${pool.length} shows${args.sample ? ` (--sample ${args.sample})` : ' (full corpus)'}`);
  console.log(`Total reviews scanned: ${stats.totalReviews}`);
  console.log(`Currently invalid:     ${stats.totalInvalid} (${(100 * stats.totalInvalid / stats.totalReviews).toFixed(1)}%)`);
  console.log(`Would flip to valid:   ${stats.wouldFlipToValid}`);
  console.log(`Would stay invalid:    ${stats.wouldStayInvalid}\n`);

  if (stats.wouldFlipToValid > 0) {
    console.log('New tier distribution for flipped reviews:');
    for (const [tier, count] of Object.entries(stats.wouldFlipByNewTier).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${tier}: ${count}`);
    }
    console.log('\nSample flips:');
    for (const ex of stats.flipExamples) {
      console.log(`  [${ex.show}/${ex.file}] "${ex.oldReason}" → ${ex.newTier}: "${ex.newReason}" (${ex.textLen} chars)`);
    }
  }

  console.log('\n=== Current tierReason distribution on invalid reviews ===');
  const sortedReasons = Object.entries(stats.currentReasons).sort((a, b) => b[1] - a[1]);
  console.log(`(${sortedReasons.length} distinct reasons)`);
  for (const [reason, count] of sortedReasons.slice(0, 20)) {
    console.log(`  ${String(count).padStart(5)}  ${reason}`);
  }
  if (sortedReasons.length > 20) {
    console.log(`  ... and ${sortedReasons.length - 20} more`);
  }

  if (stats.emptyReasonExamples.length > 0) {
    console.log('\n=== Sample empty-tierReason invalid reviews (P2 #3 diagnostic) ===');
    for (const ex of stats.emptyReasonExamples) {
      console.log(`  [${ex.show}/${ex.file}] textLen=${ex.textLen}, textStatus=${ex.textStatus}, wrongProduction=${ex.wrongProduction}`);
    }
  }

  if (Object.keys(stats.reasonFlips).length > 0) {
    console.log('\n=== tierReason changes (stays invalid, reason updated) ===');
    const sortedFlips = Object.entries(stats.reasonFlips).sort((a, b) => b[1] - a[1]);
    for (const [flip, count] of sortedFlips.slice(0, 10)) {
      console.log(`  ${String(count).padStart(5)}  ${flip}`);
    }
  }

  if (args.apply && stats.wouldFlipToValid > 0) {
    console.log(`\n✅ Applied changes to ${stats.wouldFlipToValid} review files.`);
    console.log('Next steps: commit review-texts, trigger rebuild-all-reviews.js to propagate to reviews.json.');
  }
}

main();
