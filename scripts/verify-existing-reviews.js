#!/usr/bin/env node
/**
 * Retroactive LLM Content Verification
 *
 * Two modes:
 *   1. VERIFY: Check reviews with fullText that were never LLM-verified (12K+)
 *   2. RECOVER: Re-evaluate wrongProduction/wrongShow flags for false positives (~650)
 *
 * Uses the same 4-provider chain as collect-review-texts.js:
 *   Kimi → Gemini Flash → GPT-4o-mini → Claude Sonnet
 *
 * Usage:
 *   node scripts/verify-existing-reviews.js                    # Both modes (default)
 *   node scripts/verify-existing-reviews.js --verify-only      # Only check unverified
 *   node scripts/verify-existing-reviews.js --recover-only     # Only re-evaluate flags
 *   node scripts/verify-existing-reviews.js --dry-run          # Log without modifying
 *   node scripts/verify-existing-reviews.js --limit=500        # Process at most N
 *   node scripts/verify-existing-reviews.js --show=hamilton     # Single show
 *
 * Env:
 *   SHOW_FILTER  — comma-separated show IDs (for CI partitioning)
 *   COMMIT_EVERY — checkpoint interval (default 25)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { verifyContent, resolveCvMarket } = require('./lib/content-verifier');
const { wrongShowCleared } = require('./lib/review-guards');
const { pushWithRetry } = require('./lib/push-with-retry.js');

const BASE = 'data/review-texts';

// ============================================================
// CLI Parsing
// ============================================================

const args = process.argv.slice(2);
const CLI = {
  dryRun: args.includes('--dry-run'),
  verifyOnly: args.includes('--verify-only'),
  recoverOnly: args.includes('--recover-only'),
  limit: parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 0,
  show: (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '',
  showFilter: process.env.SHOW_FILTER || '',
  commitEvery: parseInt(process.env.COMMIT_EVERY || '25'),
};

// ============================================================
// Load Shows Data
// ============================================================

const showsData = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
const showsMap = new Map();
for (const s of (showsData.shows || showsData)) {
  showsMap.set(s.id, s);
}

// ============================================================
// Scan Reviews
// ============================================================

function getAllReviewFiles() {
  const allDirs = fs.readdirSync(BASE).filter(d => {
    try { return fs.statSync(path.join(BASE, d)).isDirectory(); } catch { return false; }
  });

  // Apply show filters
  let dirs = allDirs;
  if (CLI.show) {
    dirs = dirs.filter(d => d === CLI.show || d.startsWith(CLI.show + '-'));
  } else if (CLI.showFilter) {
    const allowed = new Set(CLI.showFilter.split(',').map(s => s.trim()));
    dirs = dirs.filter(d => allowed.has(d));
  }

  const reviews = [];
  for (const d of dirs) {
    const files = fs.readdirSync(path.join(BASE, d)).filter(
      f => f.endsWith('.json') && f !== 'failed-fetches.json'
    );
    for (const f of files) {
      reviews.push({ showId: d, file: f, filePath: path.join(BASE, d, f) });
    }
  }
  return reviews;
}

function categorizeReviews(reviewFiles) {
  const toVerify = [];
  const toRecover = [];

  for (const { showId, file, filePath } of reviewFiles) {
    try {
      const r = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // RECOVER mode: re-evaluate flagged reviews with recoverable text
      if (!CLI.verifyOnly && (r.wrongProduction || r.wrongShow)) {
        // Skip wrongAttribution — those are typically correct
        if (r.wrongAttribution) continue;

        // Find best available text
        const text = r.fullText || r.wrongFullText || r.garbageFullText;
        if (text && text.length >= 200) {
          toRecover.push({
            showId, file, filePath,
            text,
            textSource: r.fullText ? 'fullText' : r.wrongFullText ? 'wrongFullText' : 'garbageFullText',
            currentFlags: {
              wrongProduction: !!r.wrongProduction,
              wrongShow: !!r.wrongShow,
            },
            review: r,
          });
        }
        continue;
      }

      // VERIFY mode: check unverified reviews with fullText
      if (!CLI.recoverOnly) {
        if (r.wrongProduction || r.wrongShow || r.wrongAttribution) continue;
        if (!r.fullText || r.fullText.length < 200) continue;
        if (r.verifiedBy && r.verifiedBy.startsWith('llm:')) continue;

        toVerify.push({
          showId, file, filePath,
          text: r.fullText,
          review: r,
        });
      }
    } catch {}
  }

  return { toVerify, toRecover };
}

// ============================================================
// Processing
// ============================================================

async function processVerify(items) {
  let flagged = 0, verified = 0, errors = 0;
  const flagDetails = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const show = showsMap.get(item.showId);
    const r = item.review;

    const label = `[${i + 1}/${items.length}] ${item.showId}/${item.file}`;

    try {
      const result = await verifyContent({
        scrapedText: item.text,
        excerpt: r.dtliExcerpt || r.bwwExcerpt || r.showScoreExcerpt || '',
        showTitle: show?.title || item.showId,
        outletName: r.outlet || r.outletId || '',
        criticName: r.criticName || '',
        openingDate: show?.openingDate || '',
        publishDate: r.publishDate || '',
        venue: show?.venue || '',
        market: resolveCvMarket(show),
        // Pass show metadata so applyTemporalOverrides can fire the named-entity bypass
        // (Hamlet 2026-05-08 FRC class). See review-guards.js:hasNamedDifferentDirectorSignal.
        show: show || null,
      });

      const provider = result.verifiedBy || 'unknown';

      if (result.wrongArticle || result.wrongProduction || result.isFilmTv) {
        const reason = result.wrongProduction ? 'wrongProduction'
          : result.isFilmTv ? 'film/TV'
          : 'wrongArticle';
        console.log(`  FLAG ${label} → ${reason} [${result.confidence}] (${provider}): ${result.reasoning || ''}`);
        flagged++;
        flagDetails.push({
          showId: item.showId, file: item.file,
          reason, confidence: result.confidence,
          reasoning: result.reasoning,
          provider,
        });

        if (!CLI.dryRun && (result.confidence === 'high' || result.confidence === 'medium')) {
          const data = JSON.parse(fs.readFileSync(item.filePath, 'utf8'));
          data.verifiedBy = provider;

          if (result.wrongProduction) {
            data.wrongProduction = true;
            data.wrongProductionReason = `Retroactive LLM verify: ${result.reasoning || reason}`;
          } else if (!wrongShowCleared(data)) {
            if (result.isFilmTv) {
              data.wrongShow = true;
              data.wrongShowReason = `Retroactive LLM verify (film/TV): ${result.reasoning || reason}`;
            } else {
              data.wrongShow = true;
              data.wrongShowReason = `Retroactive LLM verify: ${result.reasoning || reason}`;
            }
          }

          // Preserve fullText in wrongFullText before nulling
          if (data.fullText) {
            data.wrongFullText = data.fullText;
            data.fullText = null;
          }

          fs.writeFileSync(item.filePath, JSON.stringify(data, null, 2) + '\n');
        }
      } else {
        // Mark as verified
        if (!CLI.dryRun) {
          const data = JSON.parse(fs.readFileSync(item.filePath, 'utf8'));
          data.verifiedBy = provider;
          fs.writeFileSync(item.filePath, JSON.stringify(data, null, 2) + '\n');
        }
        verified++;
      }
    } catch (e) {
      console.log(`  ERROR ${label}: ${e.message}`);
      errors++;
    }

    // Checkpoint
    if (!CLI.dryRun && (i + 1) % CLI.commitEvery === 0) {
      checkpoint(`verify checkpoint ${i + 1}/${items.length}`);
    }

    // Rate limit — 200ms between calls
    await sleep(50);
  }

  return { flagged, verified, errors, flagDetails };
}

async function processRecover(items) {
  let recovered = 0, confirmed = 0, errors = 0;
  const recoveryDetails = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const show = showsMap.get(item.showId);
    const r = item.review;

    const label = `[${i + 1}/${items.length}] ${item.showId}/${item.file}`;
    const flagType = item.currentFlags.wrongProduction ? 'wrongProduction' : 'wrongShow';

    try {
      const result = await verifyContent({
        scrapedText: item.text,
        excerpt: r.dtliExcerpt || r.bwwExcerpt || r.showScoreExcerpt || '',
        showTitle: show?.title || item.showId,
        outletName: r.outlet || r.outletId || '',
        criticName: r.criticName || '',
        openingDate: show?.openingDate || '',
        publishDate: r.publishDate || '',
        venue: show?.venue || '',
        market: resolveCvMarket(show),
        // Pass show metadata so applyTemporalOverrides can fire the named-entity bypass
        // (Hamlet 2026-05-08 FRC class). See review-guards.js:hasNamedDifferentDirectorSignal.
        show: show || null,
      });

      const provider = result.verifiedBy || 'unknown';

      // LLM says it's actually valid → false positive, recover!
      if (result.isValid && !result.wrongArticle && !result.wrongProduction && !result.isFilmTv) {
        console.log(`  RECOVER ${label} (was ${flagType}, text from ${item.textSource}) [${result.confidence}] (${provider}): ${result.reasoning || ''}`);
        recovered++;
        recoveryDetails.push({
          showId: item.showId, file: item.file,
          wasFlagged: flagType, textSource: item.textSource,
          confidence: result.confidence, reasoning: result.reasoning,
          provider,
        });

        if (!CLI.dryRun && (result.confidence === 'high' || result.confidence === 'medium')) {
          const data = JSON.parse(fs.readFileSync(item.filePath, 'utf8'));

          // Restore fullText from wherever it was saved
          if (!data.fullText && data.wrongFullText) {
            data.fullText = data.wrongFullText;
            delete data.wrongFullText;
          } else if (!data.fullText && data.garbageFullText) {
            data.fullText = data.garbageFullText;
            delete data.garbageFullText;
          }

          // Clear flags
          delete data.wrongProduction;
          delete data.wrongProductionReason;
          delete data.wrongShow;
          delete data.wrongShowReason;

          // A stale contentTier:'invalid' (set when the file was originally flagged)
          // otherwise permanently blocks isIncludableForRebuild's separate invalid-tier
          // gate (review-guards.js) even after wrongProduction/wrongShow are cleared above —
          // that gate only stands down given wrongProductionManualClear/-Override or
          // humanReviewedWrongProduction===false, none of which recovery used to set.
          // Found live via card #632 (Les Mis Arena Concert Spectacular): 2 correctly-
          // recovered reviews stayed invisible to rebuild despite the flags being cleared.
          if (data.contentTier === 'invalid') {
            data.contentTier = (data.fullText && data.fullText.trim().length >= 200)
              ? 'complete'
              : (require('./lib/excerpt-fields').hasExcerpt(data) ? 'excerpt' : 'stub');
          }
          data.humanReviewedWrongProduction = false;

          data.verifiedBy = provider;
          data.recoveredBy = `retroactive-llm-verify`;
          data.recoveredAt = new Date().toISOString().split('T')[0];

          fs.writeFileSync(item.filePath, JSON.stringify(data, null, 2) + '\n');
        }
      } else {
        // LLM confirms the flag was correct
        const reason = result.wrongProduction ? 'wrongProduction'
          : result.isFilmTv ? 'film/TV'
          : result.wrongArticle ? 'wrongArticle'
          : 'confirmed';
        console.log(`  CONFIRM ${label} (${flagType} confirmed as ${reason}) [${result.confidence}] (${provider})`);
        confirmed++;

        // Stamp verification on the file
        if (!CLI.dryRun) {
          const data = JSON.parse(fs.readFileSync(item.filePath, 'utf8'));
          data.verifiedBy = provider;
          fs.writeFileSync(item.filePath, JSON.stringify(data, null, 2) + '\n');
        }
      }
    } catch (e) {
      console.log(`  ERROR ${label}: ${e.message}`);
      errors++;
    }

    // Checkpoint
    if (!CLI.dryRun && (i + 1) % CLI.commitEvery === 0) {
      checkpoint(`recover checkpoint ${i + 1}/${items.length}`);
    }

    // Rate limit
    await sleep(50);
  }

  return { recovered, confirmed, errors, recoveryDetails };
}

// ============================================================
// Git Checkpointing
// ============================================================

function checkpoint(message) {
  try {
    execSync('git add -u .', { stdio: 'pipe' });
    const status = execSync('git diff --staged --quiet 2>/dev/null; echo $?', { encoding: 'utf8' }).trim();
    if (status !== '0') {
      execSync(`git commit -m "chore: Retroactive LLM verify — ${message}"`, { stdio: 'pipe' });
      // Push through the shared helper (task #420). The hand-rolled
      // `git pull --rebase origin main && git push` retry loop here carried
      // no depth bound, and verify-existing-reviews.yml checks out at the
      // default fetch-depth: 1 — from a shallow clone that pull makes
      // upload-pack send the entire ~2.1 GB repo (#466). The helper also
      // brings the #394 stale-tracking-ref fix and #543 HEAD preservation.
      const { ok, stderr } = pushWithRetry({ branch: 'HEAD:main', retries: 5 });
      if (ok) {
        console.log(`  [checkpoint] Committed and pushed: ${message}`);
      } else {
        console.log(`  [checkpoint] Push failed: ${stderr.split('\n').slice(-3).join(' ')}`);
      }
    }
  } catch (e) {
    console.log(`  [checkpoint] Warning: ${e.message}`);
  }
  // Also push review-texts to private repo
  pushReviewTextsCheckpoint(message);
}

function pushReviewTextsCheckpoint(message) {
  if (!process.env.REVIEW_TEXTS_TOKEN || !process.env.GITHUB_ACTIONS) return;
  const rtDir = path.join(process.cwd(), 'data', 'review-texts');
  if (!fs.existsSync(path.join(rtDir, '.git'))) {
    console.log('  [checkpoint] (No private repo checkout — skipping review-texts push)');
    return;
  }
  try {
    execSync('git config user.name "GitHub Action"', { cwd: rtDir, stdio: 'pipe' });
    execSync('git config user.email "action@github.com"', { cwd: rtDir, stdio: 'pipe' });
    const remoteUrl = `https://x-access-token:${process.env.REVIEW_TEXTS_TOKEN}@github.com/thomaspryor/broadway-review-texts.git`;
    try {
      execSync(`git remote set-url origin "${remoteUrl}"`, { cwd: rtDir, stdio: 'pipe' });
    } catch {
      execSync(`git remote add origin "${remoteUrl}"`, { cwd: rtDir, stdio: 'pipe' });
    }
    execSync('git add -A', { cwd: rtDir, stdio: 'pipe' });
    try {
      execSync('git diff --staged --quiet', { cwd: rtDir, stdio: 'pipe' });
      return; // No changes
    } catch { /* Has changes */ }
    const msg = `chore: Checkpoint review texts — ${message}`;
    execSync(`git commit -m "${msg}"`, { cwd: rtDir, stdio: 'pipe' });
    // Push through the shared helper (task #420). Replaces a hand-rolled
    // `git pull --rebase -X theirs` + protected-field restore + conflict loop.
    // The review-texts checkout is shallow by default too (.github/actions/
    // checkout-review-texts, fetch-depth: 1), so the unbounded pull had the
    // same whole-repo-transfer exposure (#466). The helper runs the same
    // lib/restore-protected-fields.js this used to invoke by hand.
    //
    // DELIBERATE POLICY CHANGE (Codex ship-check, 2026-07-26): on a
    // modify/delete conflict the old hand-rolled loop kept whatever file was
    // still on disk, which RESURRECTS a tombstone the remote deleted on
    // purpose — the --unknown.json -> --named-critic.json rename case
    // push-with-retry.sh documents. The helper accepts the remote deletion
    // instead. That is the repo's intended behaviour (memory/feedback_outlet_
    // merge_no_flag_and_keep.md), so this is a fix, not a regression.
    const rtPush = pushWithRetry({ cwd: rtDir, branch: 'main', retries: 3 });
    if (rtPush.ok) {
      console.log('  [checkpoint] ✓ Pushed review-texts to private repo');
      return;
    }
    console.log(`  [checkpoint] ⚠ Failed to push review-texts: ${rtPush.stderr.split('\n').slice(-3).join(' ')}`);
  } catch (e) {
    console.log(`  [checkpoint] ⚠ Review-texts push error: ${e.message}`);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// Report
// ============================================================

function writeReport(verifyResult, recoverResult) {
  const report = {
    timestamp: new Date().toISOString(),
    dryRun: CLI.dryRun,
    verify: verifyResult ? {
      processed: verifyResult.verified + verifyResult.flagged + verifyResult.errors,
      verified: verifyResult.verified,
      flagged: verifyResult.flagged,
      errors: verifyResult.errors,
      flagDetails: verifyResult.flagDetails,
    } : null,
    recover: recoverResult ? {
      processed: recoverResult.recovered + recoverResult.confirmed + recoverResult.errors,
      recovered: recoverResult.recovered,
      confirmedCorrect: recoverResult.confirmed,
      errors: recoverResult.errors,
      recoveryDetails: recoverResult.recoveryDetails,
    } : null,
  };

  const reportPath = 'data/audit/retroactive-verify-report.json';
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`\nReport written to ${reportPath}`);
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log('=== Retroactive LLM Content Verification ===');
  console.log(`Mode: ${CLI.verifyOnly ? 'verify-only' : CLI.recoverOnly ? 'recover-only' : 'verify + recover'}`);
  console.log(`Dry run: ${CLI.dryRun}`);
  if (CLI.limit) console.log(`Limit: ${CLI.limit}`);
  if (CLI.show) console.log(`Show: ${CLI.show}`);
  if (CLI.showFilter) console.log(`Show filter: ${CLI.showFilter.split(',').length} shows`);
  console.log('');

  const allFiles = getAllReviewFiles();
  const { toVerify, toRecover } = categorizeReviews(allFiles);

  console.log(`Reviews to verify (unverified with fullText): ${toVerify.length}`);
  console.log(`Reviews to re-evaluate (flagged with recoverable text): ${toRecover.length}`);
  console.log('');

  // Apply limit — split proportionally between verify and recover
  let verifyItems = toVerify;
  let recoverItems = toRecover;
  if (CLI.limit) {
    const total = toVerify.length + toRecover.length;
    if (total > CLI.limit) {
      // Prioritize recovery (smaller set, higher value), then verify
      const recoverLimit = Math.min(toRecover.length, Math.ceil(CLI.limit * 0.3));
      const verifyLimit = CLI.limit - recoverLimit;
      recoverItems = toRecover.slice(0, recoverLimit);
      verifyItems = toVerify.slice(0, verifyLimit);
    }
  }

  let verifyResult = null;
  let recoverResult = null;

  // Run recovery first (higher value, smaller set)
  if (recoverItems.length > 0 && !CLI.verifyOnly) {
    console.log(`\n=== RECOVERY: Re-evaluating ${recoverItems.length} flagged reviews ===\n`);
    recoverResult = await processRecover(recoverItems);
    console.log(`\nRecovery complete: ${recoverResult.recovered} recovered, ${recoverResult.confirmed} confirmed correct, ${recoverResult.errors} errors`);

    if (!CLI.dryRun) checkpoint('recovery complete');
  }

  // Run verification
  if (verifyItems.length > 0 && !CLI.recoverOnly) {
    console.log(`\n=== VERIFY: Checking ${verifyItems.length} unverified reviews ===\n`);
    verifyResult = await processVerify(verifyItems);
    console.log(`\nVerify complete: ${verifyResult.verified} clean, ${verifyResult.flagged} flagged, ${verifyResult.errors} errors`);

    if (!CLI.dryRun) checkpoint('verification complete');
  }

  // Write report
  writeReport(verifyResult, recoverResult);

  // Summary
  console.log('\n=== SUMMARY ===');
  if (recoverResult) {
    console.log(`Recovery: ${recoverResult.recovered} reviews restored (were false positives)`);
    console.log(`  ${recoverResult.confirmed} flags confirmed correct by LLM`);
  }
  if (verifyResult) {
    console.log(`Verify: ${verifyResult.flagged} new flags found out of ${verifyResult.verified + verifyResult.flagged} checked`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
