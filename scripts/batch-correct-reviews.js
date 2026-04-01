#!/usr/bin/env node
/**
 * Batch Correction Tool for Opening Night Reviews
 *
 * Sets humanReviewScore overrides on multiple reviews in one commit.
 * Prevents the cascade of individual fix-push-rebuild cycles.
 *
 * Usage:
 *   node scripts/batch-correct-reviews.js --show=SHOW_ID --corrections='outlet:score,outlet:score'
 *   node scripts/batch-correct-reviews.js --show=SHOW_ID --critic-names='outlet:Name,outlet:Name'
 *   node scripts/batch-correct-reviews.js --show=SHOW_ID --corrections='nypost:40,culturesauce:38' --critic-names='nyt-theater:Jonathan Mandell'
 *
 * Options:
 *   --show=SHOW_ID          Required. The show to correct.
 *   --corrections=...       Comma-separated outlet:score pairs for humanReviewScore overrides.
 *   --critic-names=...      Comma-separated outlet:name pairs for critic name corrections.
 *   --dry-run               Show what would change without writing files.
 *   --reason=...            Override reason (default: "Manual correction via batch-correct-reviews.js")
 *
 * Examples:
 *   node scripts/batch-correct-reviews.js --show=dog-day-afternoon-2026 --corrections='nypost:40,culturesauce:38,nysr-roma-torre:60'
 *   node scripts/batch-correct-reviews.js --show=dog-day-afternoon-2026 --critic-names='nyt-theater:Jonathan Mandell'
 *
 * Note: For scores, use humanReviewScore (P0b in rebuild priority chain).
 * Do NOT use assignedScore — the rebuild recalculates it from llmScore.
 */
const fs = require('fs');
const path = require('path');

// --- CLI args ---
const args = process.argv.slice(2);
const SHOW_ID = (args.find(a => a.startsWith('--show=')) || '').split('=')[1];
const CORRECTIONS_RAW = (args.find(a => a.startsWith('--corrections=')) || '').split('=').slice(1).join('=');
const CRITIC_NAMES_RAW = (args.find(a => a.startsWith('--critic-names=')) || '').split('=').slice(1).join('=');
const DRY_RUN = args.includes('--dry-run');
const REASON = (args.find(a => a.startsWith('--reason=')) || '').split('=').slice(1).join('=')
  || 'Manual correction via batch-correct-reviews.js';

if (!SHOW_ID || (!CORRECTIONS_RAW && !CRITIC_NAMES_RAW)) {
  console.error('Usage: node scripts/batch-correct-reviews.js --show=SHOW_ID --corrections=outlet:score[,outlet:score]');
  console.error('       node scripts/batch-correct-reviews.js --show=SHOW_ID --critic-names=outlet:name[,outlet:name]');
  process.exit(1);
}

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts', SHOW_ID);
if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
  console.error(`Review texts directory not found: ${REVIEW_TEXTS_DIR}`);
  process.exit(1);
}

// Parse corrections: "nypost:40,culturesauce:38" → [{outlet: "nypost", score: 40}, ...]
// Also supports "nysr-roma-torre:60" → matches outlet "nysr" with critic containing "roma-torre"
const corrections = CORRECTIONS_RAW ? CORRECTIONS_RAW.split(',').map(pair => {
  const [key, value] = pair.split(':');
  const parts = key.split('-');
  // Check if the last parts look like a critic name (e.g., "nysr-roma-torre")
  // Heuristic: if there are 3+ parts and the outlet ID exists as the first 1-2 parts
  return { key: key.trim(), score: parseInt(value.trim()) };
}).filter(c => !isNaN(c.score)) : [];

// Parse critic names: "nyt-theater:Jonathan Mandell" → [{outlet: "nyt-theater", name: "Jonathan Mandell"}]
const criticNames = CRITIC_NAMES_RAW ? CRITIC_NAMES_RAW.split(',').map(pair => {
  const colonIdx = pair.indexOf(':');
  return { outlet: pair.slice(0, colonIdx).trim(), name: pair.slice(colonIdx + 1).trim() };
}).filter(c => c.outlet && c.name) : [];

console.log(`\nBatch Correction: ${SHOW_ID}`);
console.log(`${'═'.repeat(50)}`);
if (corrections.length) console.log(`Score corrections: ${corrections.length}`);
if (criticNames.length) console.log(`Critic name fixes: ${criticNames.length}`);
if (DRY_RUN) console.log('(DRY RUN — no files will be modified)\n');

const files = fs.readdirSync(REVIEW_TEXTS_DIR).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
let modified = 0;

// Apply score corrections
for (const corr of corrections) {
  // Find matching file — try exact outlet match, then outlet-critic match
  const matchingFile = files.find(f => {
    const outletId = f.split('--')[0];
    // Exact outlet match
    if (outletId === corr.key) return true;
    // Outlet-critic match (e.g., "nysr-roma-torre" matches "nysr--roma-torre.json")
    if (f.replace('.json', '').replace('--', '-') === corr.key) return true;
    return false;
  });

  if (!matchingFile) {
    console.log(`  ✗ No file found for: ${corr.key}`);
    continue;
  }

  const fp = path.join(REVIEW_TEXTS_DIR, matchingFile);
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const oldScore = data.humanReviewScore || data.assignedScore || 'none';

  data.humanReviewScore = corr.score;
  data.scoreOverrideReason = REASON;

  if (!DRY_RUN) {
    fs.writeFileSync(fp, JSON.stringify(data, null, 2));
  }
  console.log(`  ✓ ${matchingFile}: humanReviewScore ${oldScore} → ${corr.score}`);
  modified++;
}

// Apply critic name fixes
for (const cn of criticNames) {
  const matchingFiles = files.filter(f => f.startsWith(cn.outlet + '--'));

  if (matchingFiles.length === 0) {
    console.log(`  ✗ No file found for outlet: ${cn.outlet}`);
    continue;
  }

  // If multiple files, prefer the one with unknown/wrong critic
  const targetFile = matchingFiles.find(f => f.includes('--unknown')) || matchingFiles[0];
  const fp = path.join(REVIEW_TEXTS_DIR, targetFile);
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const oldName = data.criticName || 'Unknown';

  data.criticName = cn.name;

  if (!DRY_RUN) {
    fs.writeFileSync(fp, JSON.stringify(data, null, 2));

    // Rename file to match new critic name
    const newFilename = `${cn.outlet}--${cn.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
    if (newFilename !== targetFile) {
      const newFp = path.join(REVIEW_TEXTS_DIR, newFilename);
      if (!fs.existsSync(newFp)) {
        fs.renameSync(fp, newFp);
        console.log(`  ✓ ${targetFile} → ${newFilename}: critic "${oldName}" → "${cn.name}"`);
      } else {
        console.log(`  ✓ ${targetFile}: critic "${oldName}" → "${cn.name}" (file not renamed — target exists)`);
      }
    } else {
      console.log(`  ✓ ${targetFile}: critic "${oldName}" → "${cn.name}"`);
    }
  } else {
    console.log(`  ✓ ${targetFile}: critic "${oldName}" → "${cn.name}" (dry run)`);
  }
  modified++;
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`Modified: ${modified} files${DRY_RUN ? ' (dry run)' : ''}`);

// Auto-commit, push, and trigger rebuild
if (modified > 0 && !DRY_RUN) {
  const { execSync } = require('child_process');
  const reviewTextsDir = REVIEW_TEXTS_DIR;

  try {
    console.log('\nCommitting and pushing...');
    execSync('git add -A', { cwd: path.join(reviewTextsDir, '..'), stdio: 'pipe' });
    execSync(`git commit -m "data: Batch corrections for ${SHOW_ID} (${modified} files)"`, { cwd: path.join(reviewTextsDir, '..'), stdio: 'pipe' });

    // Push with retry (review-texts is a separate repo)
    let pushed = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        execSync('git pull --rebase origin main', { cwd: path.join(reviewTextsDir, '..'), stdio: 'pipe' });
        execSync('git push origin main', { cwd: path.join(reviewTextsDir, '..'), stdio: 'pipe' });
        pushed = true;
        console.log('  ✓ Pushed to review-texts repo');
        break;
      } catch (e) {
        if (attempt < 3) console.log(`  Push attempt ${attempt} failed, retrying...`);
      }
    }
    if (!pushed) console.error('  ✗ Failed to push after 3 attempts');

    // Trigger rebuild
    try {
      execSync(`gh workflow run rebuild-reviews.yml -f reason="Batch corrections for ${SHOW_ID}"`, { stdio: 'pipe' });
      console.log('  ✓ Rebuild triggered');
    } catch {
      console.log('  ⚠ Could not trigger rebuild (no gh CLI or no GH_TOKEN). Trigger manually:');
      console.log('    gh workflow run rebuild-reviews.yml -f reason="Batch corrections"');
    }
  } catch (e) {
    console.error('  ✗ Git error:', e.message);
    console.log('\n  Manual steps:');
    console.log(`  cd ${path.join(reviewTextsDir, '..')} && git add -A && git commit -m "data: Batch corrections" && git push`);
  }
}
