#!/usr/bin/env node
/**
 * Flag reviews that need rescoring
 *
 * Identifies reviews that:
 * - Have fullText (>500 chars)
 * - Have llmScore (old format, not ensemble)
 * - LLM score was likely based on excerpt (keyPhrases are short snippets)
 * - Haven't already been rescored (no rescoreCompletedAt)
 *
 * Usage:
 *   node scripts/flag-rescore-needed.js [--dry-run] [--tier=1,2]
 *
 *   --dry-run   Show what would be flagged without writing files
 *   --tier=N,M  Only flag outlets in specified tiers (e.g., --tier=1,2)
 */

const fs = require('fs');
const path = require('path');
const { isScoreable } = require('./lib/is-scoreable');

// Build showId → { title } map so isScoreable can activate the wrongShow
// stale-flag override (Notion 34e637c5-416f-8121).
function loadShowTitles() {
  const map = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
    for (const s of (j.shows || j)) {
      if (s.id && s.title) map.set(s.id, { title: s.title });
    }
  } catch { /* fall through — predicate fails safe to exclude wrongShow files */ }
  return map;
}
const SHOW_TITLES = loadShowTitles();
const showFor = (d) => (d.showId ? SHOW_TITLES.get(d.showId) : undefined);

// Parse args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const cleanupMode = args.includes('--cleanup');
const tierArg = args.find(a => a.startsWith('--tier='));
const tierFilter = tierArg ? tierArg.split('=')[1].split(',').map(Number) : null;

// Load outlet registry for tier filtering
let outletRegistry = null;
if (tierFilter) {
  try {
    outletRegistry = JSON.parse(fs.readFileSync('data/outlet-registry.json', 'utf8'));
    console.log(`Tier filter active: T${tierFilter.join(', T')}`);
  } catch (e) {
    console.error('Warning: Could not load outlet-registry.json for tier filtering');
  }
}

const reviewDir = 'data/review-texts';
const shows = fs.readdirSync(reviewDir).filter(f => {
  const fullPath = path.join(reviewDir, f);
  // Skip symlinks to avoid processing the same directory twice
  if (fs.lstatSync(fullPath).isSymbolicLink()) return false;
  return fs.statSync(fullPath).isDirectory();
});

// --cleanup mode: remove needsRescore from unscorable files
if (cleanupMode) {
  console.log('='.repeat(70));
  console.log('CLEANUP: Removing needsRescore from unscorable files');
  console.log('='.repeat(70));
  if (dryRun) console.log('\n*** DRY RUN — no files will be modified ***\n');

  let cleaned = 0;
  let scanned = 0;
  const cleanedFiles = [];
  for (const show of shows) {
    const showDir = path.join(reviewDir, show);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    for (const file of files) {
      const filePath = path.join(showDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        scanned++;
        if (!data.needsRescore) continue;
        // Check if unscorable
        if (!isScoreable(data, showFor(data))) {
          cleaned++;
          cleanedFiles.push(`${show}/${file}`);
          if (!dryRun) {
            delete data.needsRescore;
            delete data.rescoreReason;
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
          }
        }
      } catch (e) {}
    }
  }
  console.log(`Scanned: ${scanned} files`);
  console.log(`${dryRun ? 'Would clean' : 'Cleaned'}: ${cleaned} files with stale needsRescore`);
  if (cleanedFiles.length > 0 && cleanedFiles.length <= 30) {
    console.log('\nFiles:');
    cleanedFiles.forEach(f => console.log(`  ${f}`));
  } else if (cleanedFiles.length > 30) {
    console.log(`\nFirst 30 files:`);
    cleanedFiles.slice(0, 30).forEach(f => console.log(`  ${f}`));
    console.log(`  ... and ${cleanedFiles.length - 30} more`);
  }
  process.exit(0);
}

let flagged = 0;
let skipped = 0;
let alreadyFlagged = 0;
let alreadyRescored = 0;
let modernEnsemble = 0;
let noFullText = 0;
let noLlmScore = 0;
let tierFiltered = 0;

const flaggedReviews = [];

console.log('='.repeat(70));
console.log('FLAGGING REVIEWS THAT NEED RESCORING');
console.log('='.repeat(70));
if (dryRun) console.log('\n*** DRY RUN — no files will be modified ***');
console.log('\nLooking for reviews scored on excerpts that now have fullText...\n');

for (const show of shows) {
  const showDir = path.join(reviewDir, show);
  const files = fs.readdirSync(showDir).filter(f =>
    f.endsWith('.json') && f !== 'failed-fetches.json'
  );

  for (const file of files) {
    const filePath = path.join(showDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Skip unscorable reviews — don't flag files that the scorer will skip anyway
      if (!isScoreable(data, showFor(data))) continue;

      // Skip if already flagged for rescore
      if (data.needsRescore) {
        alreadyFlagged++;
        continue;
      }

      // Skip if already rescored (flag was cleared after successful rescore)
      if (data.rescoreCompletedAt) {
        alreadyRescored++;
        continue;
      }

      // Skip if scored by modern ensemble (v5+ uses best available text)
      if (data.ensembleData) {
        modernEnsemble++;
        continue;
      }

      // Skip if no fullText
      if (!data.fullText || data.fullText.length < 500) {
        noFullText++;
        continue;
      }

      // Skip if no llmScore
      if (!data.llmScore || !data.llmScore.score) {
        noLlmScore++;
        continue;
      }

      // Tier filtering: look up outlet tier from registry
      if (tierFilter && outletRegistry) {
        const outletId = data.outletId || file.replace('.json', '').split('--')[0];
        const outlet = outletRegistry.outlets[outletId];
        const tier = outlet ? outlet.tier : 3;
        if (!tierFilter.includes(tier)) {
          tierFiltered++;
          continue;
        }
      }

      // Check if score was based on excerpt by looking at keyPhrases
      const keyPhrases = data.llmScore.keyPhrases || [];
      const reasoning = data.llmScore.reasoning || '';

      // Indicators of excerpt-based scoring:
      // 1. Reasoning mentions "brief" or "short" or "excerpt"
      // 2. Total keyPhrase text is <200 chars
      // 3. Only 1-2 keyPhrases
      const totalKeyPhraseLength = keyPhrases.reduce((sum, kp) => sum + (kp.quote || '').length, 0);
      const isExcerptBased =
        reasoning.toLowerCase().includes('brief') ||
        reasoning.toLowerCase().includes('short excerpt') ||
        reasoning.toLowerCase().includes('very brief') ||
        totalKeyPhraseLength < 200 ||
        keyPhrases.length <= 2;

      // Also check: if fullText is 3x+ longer than longest excerpt, probably needs rescore
      const excerptLength = Math.max(
        (data.dtliExcerpt || '').length,
        (data.bwwExcerpt || '').length,
        (data.showScoreExcerpt || '').length
      );
      const fullTextMuchLonger = data.fullText.length > excerptLength * 3 && excerptLength > 0;

      if (isExcerptBased || fullTextMuchLonger) {
        if (!dryRun) {
          // Flag for rescore
          data.needsRescore = true;
          data.rescoreReason = isExcerptBased
            ? 'scored on brief excerpt, now has fullText'
            : 'fullText significantly longer than excerpt used for scoring';

          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        }
        flagged++;
        flaggedReviews.push({
          show,
          file,
          score: data.llmScore.score,
          fullTextLength: data.fullText.length,
          excerptLength,
          reason: isExcerptBased
            ? 'scored on brief excerpt, now has fullText'
            : 'fullText significantly longer than excerpt used for scoring'
        });
      } else {
        skipped++;
      }
    } catch (e) {
      // Ignore parse errors
    }
  }
}

console.log('='.repeat(70));
console.log('SUMMARY');
console.log('='.repeat(70));
if (dryRun) console.log('\n*** DRY RUN — no files were modified ***');
console.log(`\nTotal reviews ${dryRun ? 'would be' : ''} flagged for rescore: ${flagged}`);
console.log(`Already flagged: ${alreadyFlagged}`);
console.log(`Already rescored (completed): ${alreadyRescored}`);
console.log(`Modern ensemble (skip): ${modernEnsemble}`);
console.log(`Skipped (score appears fullText-based): ${skipped}`);
console.log(`No fullText: ${noFullText}`);
console.log(`No llmScore: ${noLlmScore}`);
if (tierFilter) console.log(`Tier-filtered out: ${tierFiltered}`);

if (flaggedReviews.length > 0) {
  // Group by outlet for summary
  const byOutlet = {};
  for (const r of flaggedReviews) {
    const outlet = r.file.split('--')[0];
    byOutlet[outlet] = (byOutlet[outlet] || 0) + 1;
  }
  const sortedOutlets = Object.entries(byOutlet).sort((a, b) => b[1] - a[1]);

  console.log('\n--- By outlet (top 20) ---\n');
  for (const [outlet, count] of sortedOutlets.slice(0, 20)) {
    console.log(`  ${String(count).padStart(5)} | ${outlet}`);
  }
  if (sortedOutlets.length > 20) console.log(`  ... and ${sortedOutlets.length - 20} more outlets`);

  console.log('\n--- Sample flagged reviews ---\n');
  for (const r of flaggedReviews.slice(0, 10)) {
    console.log(`${r.show}/${r.file}:`);
    console.log(`  score: ${r.score}, fullText: ${r.fullTextLength} chars, excerpt: ${r.excerptLength} chars`);
    console.log(`  reason: ${r.reason}`);
  }
  if (flaggedReviews.length > 10) {
    console.log(`\n... and ${flaggedReviews.length - 10} more`);
  }
}

// Save full list to audit file
if (!dryRun) {
  const auditDir = 'data/audit';
  if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
  const auditPath = path.join(auditDir, 'rescore-needed.json');
  fs.writeFileSync(auditPath, JSON.stringify({
    flaggedAt: new Date().toISOString(),
    totalFlagged: flagged,
    reviews: flaggedReviews
  }, null, 2));
  console.log(`\nFull list saved to: ${auditPath}`);
} else {
  console.log('\nDry run — no audit file written. Remove --dry-run to flag files.');
}
