#!/usr/bin/env node
/**
 * manual-review-direct.js — Direct-to-reviews.json manual corrections
 *
 * Bypasses the entire rebuild pipeline. Edits reviews.json directly in the
 * core-data repo and triggers deploy-only. Live in ~3 minutes.
 *
 * ALSO writes a source file to review-texts (via ingest-manual-review.js)
 * so the pipeline eventually catches up and the manualEntry flag gets dropped.
 *
 * Usage:
 *   node scripts/manual-review-direct.js \
 *     --show=becky-shaw-2026 --outlet=guardian --critic="Adrian Horton" \
 *     --score=60 --stars="3/5" --url="https://..." --text-file=review.txt
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// --- Parse CLI args ---
const args = process.argv.slice(2);
const getArg = (name) => {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=').slice(1).join('=') : null;
};
const hasFlag = (name) => args.includes(`--${name}`);

const showId = getArg('show');
const outletArg = getArg('outlet');
const criticName = getArg('critic');
const url = getArg('url');
const scoreArg = getArg('score');
const starsArg = getArg('stars');
const inlineText = getArg('text');
const textFile = getArg('text-file');
const publishDate = getArg('publish-date');
const dryRun = hasFlag('dry-run');
const skipSourceFile = hasFlag('skip-source-file');

if (!showId || !outletArg || !criticName) {
  console.error('Usage: node scripts/manual-review-direct.js --show=ID --outlet=ID --critic=NAME [options]');
  console.error('');
  console.error('Required: --show, --outlet, --critic');
  console.error('Optional: --score, --stars, --url, --text, --text-file, --publish-date');
  console.error('Flags:    --dry-run, --skip-source-file');
  process.exit(1);
}

// --- Resolve outlet ---
const { resolveCanonicalOutletId } = require('./lib/outlet-canonicalize');
const _resolved = resolveCanonicalOutletId({ outletArg, url });
if (_resolved.warning) console.warn(`⚠️  ${_resolved.warning}`);
const outletId = _resolved.outletId;
const outletName = _resolved.displayName;

// --- Get outlet tier for correct composite weighting ---
const outletRegistry = require('../data/outlet-registry.json');
const outletInfo = outletRegistry.outlets?.[outletId];
const tier = outletInfo?.tier || 3;

// --- Parse score ---
let score = null;
if (scoreArg) {
  score = parseInt(scoreArg, 10);
  if (isNaN(score) || score < 1 || score > 100) {
    console.error(`Invalid score: ${scoreArg} (must be 1-100)`);
    process.exit(1);
  }
}

// --- Parse stars ---
let originalScore = null;
if (starsArg) {
  const match = starsArg.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+)$/);
  if (!match) {
    console.error(`Invalid stars: ${starsArg} (expected N/M)`);
    process.exit(1);
  }
  const normalized = Math.round((parseFloat(match[1]) / parseFloat(match[2])) * 100);
  originalScore = starsArg;
  if (!score) score = normalized;
}

if (!score) {
  console.error('Direct path requires a score (--score=N or --stars=N/M). For text-only, use ingest-manual-review.js instead.');
  process.exit(1);
}

// --- Get review text ---
let fullText = null;
if (textFile && fs.existsSync(textFile)) {
  fullText = fs.readFileSync(textFile, 'utf8').trim();
} else if (inlineText) {
  fullText = inlineText;
}

// --- Verify show exists ---
const showsData = require('../data/shows.json');
const show = showsData.shows.find(s => s.id === showId);
if (!show) {
  console.error(`Show not found: ${showId}`);
  process.exit(1);
}

// --- Determine score bucket ---
const bucket = score >= 83 ? 'Rave' : score >= 75 ? 'Positive' : score >= 55 ? 'Mixed' : score >= 30 ? 'Negative' : 'Pan';

console.log(`\n╔══════════════════════════════════════════════════╗`);
console.log(`║  Direct Review Entry${dryRun ? ' (DRY RUN)' : ''}`);
console.log(`║  Show: ${show.title} (${showId})`);
console.log(`║  Outlet: ${outletName} (${outletId}) [T${tier}]`);
console.log(`║  Critic: ${criticName}`);
console.log(`║  Score: ${score} (${bucket})`);
if (originalScore) console.log(`║  Stars: ${originalScore}`);
if (url) console.log(`║  URL: ${url}`);
if (fullText) console.log(`║  Text: ${fullText.length} chars`);
console.log(`║  Path: DIRECT → reviews.json → deploy`);
console.log(`╚══════════════════════════════════════════════════╝\n`);

if (dryRun) {
  console.log('Dry run — no changes made.');
  process.exit(0);
}

// --- Step 1: Clone core-data and edit reviews.json ---
const coreDataDir = '/tmp/core-data-direct';

console.log('1. Cloning core-data repo...');
try {
  execSync(`rm -rf ${coreDataDir}`, { stdio: 'pipe' });
  execSync(`gh repo clone thomaspryor/broadway-scorecard-data ${coreDataDir} -- --depth 1`, { stdio: 'pipe' });
} catch (e) {
  console.error('Failed to clone core-data:', e.message);
  process.exit(1);
}

const reviewsJsonPath = path.join(coreDataDir, 'reviews.json');
const data = JSON.parse(fs.readFileSync(reviewsJsonPath, 'utf8'));

// Find existing review for this show+outlet or create new
const existingIdx = data.reviews.findIndex(r =>
  r.showId === showId && r.outletId === outletId &&
  (r.criticName || '').toLowerCase() === (criticName || '').toLowerCase()
);

const review = {
  showId,
  outletId,
  outlet: outletName,
  criticName,
  assignedScore: score,
  scoreSource: 'human-review',
  scoreConfidence: 'high',
  contentTier: fullText ? 'complete' : 'manual',
  tier,
  bucket,
  url: url || '',
  publishDate: publishDate || new Date().toISOString().split('T')[0],
  manualEntry: true,
  manualEntryAt: new Date().toISOString(),
};

if (originalScore) {
  review.originalScore = originalScore;
}

if (fullText) {
  // Generate a pull quote from the first sentence that mentions the show or production
  const sentences = fullText.match(/[^.!?]+[.!?]+/g) || [];
  const pullQuote = sentences.find(s =>
    s.toLowerCase().includes(show.title.toLowerCase().split(':')[0].split(' ')[0]) ||
    s.includes('production') || s.includes('revival') || s.includes('performance')
  ) || sentences[1] || sentences[0] || '';
  if (pullQuote) review.pullQuote = pullQuote.trim().substring(0, 200);
}

if (existingIdx >= 0) {
  data.reviews[existingIdx] = { ...data.reviews[existingIdx], ...review };
  console.log(`2. Updated existing review in reviews.json`);
} else {
  data.reviews.push(review);
  console.log(`2. Added new review to reviews.json`);
}

fs.writeFileSync(reviewsJsonPath, JSON.stringify(data, null, 2));

// Push to core-data
console.log('3. Pushing to core-data repo...');
try {
  execSync(`cd ${coreDataDir} && git add reviews.json && git commit -m "data: Direct manual entry — ${outletName} for ${showId} (${score})" && git push origin main`, { stdio: 'pipe' });
} catch (e) {
  console.error('Failed to push core-data:', e.message);
  console.error('Retrying with pull...');
  try {
    execSync(`cd ${coreDataDir} && git pull --rebase origin main && git push origin main`, { stdio: 'pipe' });
  } catch (e2) {
    console.error('Push failed after retry:', e2.message);
    process.exit(1);
  }
}
console.log('   ✅ Pushed to core-data');

// --- Step 2: Trigger deploy ---
console.log('4. Triggering deploy...');
try {
  const result = execSync('gh workflow run "Deploy to Vercel"', { encoding: 'utf8' });
  console.log('   ✅ Deploy triggered');
} catch (e) {
  console.error('   ⚠️  Deploy trigger failed:', e.message);
  console.error('   Run manually: gh workflow run "Deploy to Vercel"');
}

// --- Step 3: Also write source file (for pipeline to catch up) ---
if (!skipSourceFile) {
  console.log('5. Writing source file to review-texts (for pipeline)...');
  try {
    const sourceArgs = [
      `--show=${showId}`,
      `--outlet=${outletId}`,
      `--critic="${criticName}"`,
      `--score=${score}`,
      '--no-rebuild',
    ];
    if (url) sourceArgs.push(`--url="${url}"`);
    if (starsArg) sourceArgs.push(`--stars="${starsArg}"`);
    if (textFile) sourceArgs.push(`--text-file=${textFile}`);
    else if (inlineText) sourceArgs.push(`--text="${inlineText}"`);
    if (publishDate) sourceArgs.push(`--publish-date=${publishDate}`);

    execSync(`node scripts/ingest-manual-review.js ${sourceArgs.join(' ')}`, { stdio: 'inherit' });
    console.log('   ✅ Source file written');

    // Push source file
    try {
      execSync('cd data/review-texts && git add -A && git commit -m "data: Source file for manual entry" && git push origin main 2>/dev/null', { stdio: 'pipe' });
    } catch {
      // Push may fail due to concurrent CI — that's OK, the direct path already worked
      console.log('   ⚠️  Source file push failed (concurrent CI) — direct path already live');
    }
  } catch (e) {
    console.log('   ⚠️  Source file write failed — direct path still works');
  }
}

// --- Step 4: Verify on site ---
console.log('\n6. Waiting for deploy to land...');
const maxWait = 10 * 60 * 1000; // 10 minutes
const start = Date.now();
const checkInterval = 20 * 1000; // 20 seconds

function checkSite() {
  try {
    const result = execSync(
      `curl -s "https://broadwayscorecard.com/data/shows/${showId}.json"`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const d = JSON.parse(result);
    const found = d.rv.find(r =>
      r.o === outletName || r.o === outletId
    );
    if (found) {
      console.log(`\n✅ LIVE: ${outletName} — ${found.s} ${found.b}`);
      console.log(`   Total reviews: ${d.rv.length} | Pos: ${d.bd.positive} | Mix: ${d.bd.mixed}`);
      return true;
    }
  } catch {}
  return false;
}

function poll() {
  if (checkSite()) return;
  if (Date.now() - start > maxWait) {
    console.log('\n⚠️  Timed out waiting for deploy. Check manually:');
    console.log(`   https://broadwayscorecard.com/show/${showId}`);
    return;
  }
  setTimeout(poll, checkInterval);
}

poll();
