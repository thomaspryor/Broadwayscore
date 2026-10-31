#!/usr/bin/env node
/**
 * sweep-revival-wrong-production.js
 *
 * Recovers wrong-production false-positives on revival shows where the
 * wrong-production audit deleted text from legitimate reviews because the
 * reviews mention prior productions of the same show.
 *
 * Bug pattern (from DoaS Apr 9-10 postmortem):
 *   1. Reviewer mentions Brian Dennehy / Dustin Hoffman / Wendell Pierce
 *   2. content-quality.js's "Different show mentioned 3+ times" trip fires
 *   3. content-verifier.js sets contentVerification.wrongProduction=true
 *   4. collect-review-texts.js nulls fullText and stashes it in wrongFullText
 *   5. rebuild-all-reviews.js CV-promotes wrongProduction=true on the file
 *   6. Review drops from composite
 *
 * What this script does (in priority order, all idempotent):
 *
 *   A. RECOVERY: For files where wrongFullText is populated AND fullText is
 *      empty AND incompleteReason==='wrong_content', restore fullText and
 *      clear the stale rejection state. These are the bug victims.
 *
 *   B. PROTECT-KNOWN-GOOD: For files that already have full text
 *      (contentTier in [complete, truncated, excerpt]) AND no current
 *      wrongProduction flag, set humanReviewedWrongProduction=false to
 *      prevent the next CV-pre-pass from re-flagging them.
 *
 *   C. CLEAR STALE CV-FLAG: For files where humanReviewedWrongProduction
 *      gets set to false (B above) AND contentVerification.wrongProduction
 *      is currently true, clear the CV flag so the rebuild's CV-pre-pass
 *      doesn't see a stale stale signal.
 *
 *   D. SKIP-AMBIGUOUS: Files with wrongProduction=true AND fullText=empty
 *      AND wrongFullText=empty are AMBIGUOUS — they may be genuinely wrong.
 *      Log them for manual review; do not modify.
 *
 *   E. SKIP-EMPTY-NEW: Files that are stubs (no text yet) but not flagged
 *      wrongProduction are skipped — collect-review-texts.js will handle them.
 *
 * Usage:
 *   node scripts/one-off/sweep-revival-wrong-production.js --show=<show-id> [--apply]
 *
 *   --show=<id>   REQUIRED. Show ID to sweep (e.g. death-of-a-salesman-2026)
 *   --apply       Write changes to disk. Without this flag, runs in DRY-RUN mode.
 *
 * Exit codes:
 *   0 = success (or dry-run completed)
 *   1 = invalid args or show dir not found
 *   2 = unexpected error during processing
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const showArg = args.find(a => a.startsWith('--show='));
const apply = args.includes('--apply');

if (!showArg) {
  console.error('ERROR: --show=<show-id> is required');
  console.error('Usage: node scripts/one-off/sweep-revival-wrong-production.js --show=death-of-a-salesman-2026 [--apply]');
  process.exit(1);
}

const showId = showArg.split('=')[1];
const showDir = path.join('data', 'review-texts', showId);

if (!fs.existsSync(showDir)) {
  console.error(`ERROR: show directory not found: ${showDir}`);
  process.exit(1);
}

const mode = apply ? 'APPLY' : 'DRY-RUN';
console.log(`\n=== sweep-revival-wrong-production.js [${mode}] ===`);
console.log(`Show: ${showId}`);
console.log(`Dir:  ${showDir}\n`);

const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
console.log(`Found ${files.length} review files\n`);

const stats = {
  recovered: [],          // A: bug victims, fullText restored
  protected: [],          // B: known-good, hRWP=false set
  clearedCv: [],          // C: cv.wrongProduction stale flag cleared
  skipAmbiguous: [],      // D: empty + wrongProduction, manual review needed
  skipEmpty: [],          // E: stubs without flags, leave to collector
  alreadyClean: [],       // already had hRWP=false set
};

for (const file of files) {
  const filepath = path.join(showDir, file);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) {
    console.error(`  PARSE ERROR: ${file} — ${e.message}`);
    continue;
  }

  const fullTextLen = (data.fullText || '').length;
  const wrongFullTextLen = (data.wrongFullText || '').length;
  const isWrongProduction = data.wrongProduction === true;
  const isWrongShow = data.wrongShow === true;
  const cvWrongProd = data.contentVerification && data.contentVerification.wrongProduction === true;
  const incompleteReason = data.incompleteReason;
  const contentTier = data.contentTier;
  const alreadyHrwpFalse = data.humanReviewedWrongProduction === false;

  const mutations = [];

  // A. RECOVERY: bug victims with wrongFullText preserved
  // STRICT GATING: only recover when ALL of these are true:
  //   - wrongFullText preserved AND fullText empty AND incompleteReason='wrong_content'
  //   - wrongShow !== true (do NOT recover regional productions, feature articles, etc.)
  //   - publishDate within 14 days of OPENING_DATE (avoids 2022/2012 productions)
  //     OR publishDate is null AND URL contains current year suffix (e.g., /2026/)
  // The intent: only recover the FALSE POSITIVES from the revival heuristic on
  // actual current-production reviews. Genuinely-wrong reviews (regional, prior
  // production, non-review features) are skipped to manual review.
  const OPENING_DATE = new Date('2026-04-09'); // DoaS opening night
  const RECOVERY_WINDOW_MS = 14 * 86400000;
  const publishDateValue = data.publishDate ? new Date(data.publishDate) : null;
  const publishDateValid = publishDateValue && !isNaN(publishDateValue.getTime());
  const withinOpeningWindow = publishDateValid &&
    Math.abs(publishDateValue.getTime() - OPENING_DATE.getTime()) <= RECOVERY_WINDOW_MS;
  const urlHasOpeningYear = data.url && /\/2026\//.test(data.url);
  const recoveryAllowedByDate = withinOpeningWindow || (!publishDateValid && urlHasOpeningYear);

  if (wrongFullTextLen > 0 && fullTextLen === 0 && incompleteReason === 'wrong_content'
      && !isWrongShow && recoveryAllowedByDate) {
    mutations.push(`restore fullText (${wrongFullTextLen} chars from wrongFullText)`);
    if (apply) {
      data.fullText = data.wrongFullText;
      data.textWordCount = data.fullText.split(/\s+/).filter(Boolean).length;
      delete data.wrongFullText;
    }
    if (isWrongProduction) {
      mutations.push('clear wrongProduction (false-positive on revival)');
      if (apply) {
        delete data.wrongProduction;
        delete data.wrongProductionNote;
        delete data.wrongProductionReason;
      }
    }
    if (incompleteReason) {
      mutations.push(`clear incompleteReason (${incompleteReason})`);
      if (apply) {
        delete data.incompleteReason;
        delete data.incompleteDetail;
      }
    }
    if (contentTier === 'invalid' || contentTier === 'needs-rescrape') {
      mutations.push(`clear contentTier=${contentTier} (let rebuild recompute)`);
      if (apply) {
        delete data.contentTier;
        delete data.contentTierReason;
      }
    }
    if (!alreadyHrwpFalse) {
      mutations.push('set humanReviewedWrongProduction=false');
      if (apply) {
        data.humanReviewedWrongProduction = false;
      }
    }
    stats.recovered.push({ file, mutations });
  }
  // D. SKIP-AMBIGUOUS: empty + wrongProduction + no preserved text
  else if (isWrongProduction && fullTextLen === 0 && wrongFullTextLen === 0) {
    stats.skipAmbiguous.push({
      file,
      reason: 'wrongProduction=true, fullText empty, no wrongFullText preserved — needs manual review',
    });
  }
  // B. PROTECT-KNOWN-GOOD: has text, not currently flagged wrong
  else if (fullTextLen > 0 && !isWrongProduction && !isWrongShow) {
    if (!alreadyHrwpFalse) {
      mutations.push('set humanReviewedWrongProduction=false (proactive revival protection)');
      if (apply) {
        data.humanReviewedWrongProduction = false;
      }
    }

    // C. CLEAR STALE CV-FLAG: if cv.wrongProduction stale-true, clear
    if (cvWrongProd) {
      mutations.push('clear contentVerification.wrongProduction (stale true on healthy file)');
      if (apply) {
        delete data.contentVerification.wrongProduction;
        if (Object.keys(data.contentVerification).length === 0) {
          delete data.contentVerification;
        }
      }
      stats.clearedCv.push({ file });
    }

    if (mutations.length === 0) {
      stats.alreadyClean.push(file);
    } else {
      stats.protected.push({ file, mutations });
    }
  }
  // E. SKIP-EMPTY-NEW: stubs without flags
  else {
    stats.skipEmpty.push({
      file,
      reason: `fullText=${fullTextLen} wrongFullText=${wrongFullTextLen} wp=${isWrongProduction} ws=${isWrongShow} tier=${contentTier || '(none)'}`,
    });
  }

  // Persist if any mutations were applied
  if (apply && mutations.length > 0) {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n');
  }
}

// Report
console.log(`\n--- RECOVERED (bug victims) [${stats.recovered.length}] ---`);
stats.recovered.forEach(({ file, mutations }) => {
  console.log(`  ${file}`);
  mutations.forEach(m => console.log(`    - ${m}`));
});

console.log(`\n--- PROTECTED (hRWP=false set) [${stats.protected.length}] ---`);
stats.protected.forEach(({ file, mutations }) => {
  console.log(`  ${file}`);
  mutations.forEach(m => console.log(`    - ${m}`));
});

console.log(`\n--- CLEARED STALE CV (had stale cv.wrongProduction) [${stats.clearedCv.length}] ---`);
stats.clearedCv.forEach(({ file }) => console.log(`  ${file}`));

console.log(`\n--- SKIPPED: ALREADY CLEAN [${stats.alreadyClean.length}] ---`);
stats.alreadyClean.forEach(file => console.log(`  ${file}`));

console.log(`\n--- SKIPPED: AMBIGUOUS (manual review needed) [${stats.skipAmbiguous.length}] ---`);
stats.skipAmbiguous.forEach(({ file, reason }) => console.log(`  ${file}\n    ${reason}`));

console.log(`\n--- SKIPPED: STUBS / OTHER [${stats.skipEmpty.length}] ---`);
stats.skipEmpty.forEach(({ file, reason }) => console.log(`  ${file}\n    ${reason}`));

console.log(`\n=== Summary ===`);
console.log(`  Recovered:     ${stats.recovered.length}`);
console.log(`  Protected:     ${stats.protected.length}`);
console.log(`  Cleared CV:    ${stats.clearedCv.length}`);
console.log(`  Already clean: ${stats.alreadyClean.length}`);
console.log(`  Ambiguous:     ${stats.skipAmbiguous.length}  ← need manual review`);
console.log(`  Other skipped: ${stats.skipEmpty.length}`);
console.log(`  Total files:   ${files.length}`);
console.log(`\nMode: ${mode}${apply ? '' : '  (no changes written — use --apply to commit)'}`);
