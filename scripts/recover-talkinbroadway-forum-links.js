#!/usr/bin/env node
/**
 * recover-talkinbroadway-forum-links.js — BRO-3788
 *
 * Same root cause as BRO-2605: some talkinbroadway review-texts files store
 * the allthatchat_new/d.php forum ANNOUNCEMENT thread as their url, not the
 * real review page. The forum thread only ever holds a short teaser + a
 * "Link" anchor pointing at the actual review
 * (talkinbroadway.com/page/{ob,bwaybway,westend}/{MM_DD_YY}.html) — no
 * re-fetch of the stored URL can ever recover full text, which is why these
 * sit permanently rejected-unscoreable or stuck as empty/invalid stubs.
 *
 * For each candidate file this fetches the forum thread, follows the
 * "<b>Link </b>" anchor to the real review page, extracts the critic name
 * from that page's own "Theatre Review by {Critic} - {Date}" byline (the
 * generic byline-extraction.js doesn't handle TB's markup — verified
 * returns null), and re-ingests via ingest-review-from-url.js so the review
 * goes through the same write path (collision/guard checks, score routing)
 * as every other URL ingest. The superseded husk file is deleted once the
 * new file is confirmed written under a different filename.
 *
 * Usage:
 *   node scripts/recover-talkinbroadway-forum-links.js [--show=ID] [--dry-run] [--data-dir=PATH]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const { fetchPage } = require('./lib/scraper');
const { isForumThreadUrl, extractReviewPageUrl, extractCriticName } = require('./lib/talkinbroadway-forum-link');

const args = process.argv.slice(2);
function getArg(name) {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : null;
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

const reviewTextsDir = getArg('data-dir') || path.join(__dirname, '..', 'data', 'review-texts');
const onlyShow = getArg('show');
const dryRun = hasFlag('dry-run');

function extractHtml(fetchResult) {
  return (fetchResult && (fetchResult.content || fetchResult.html || fetchResult.body))
    || (typeof fetchResult === 'string' ? fetchResult : null);
}

// talkinbroadway.com sits behind a Cloudflare managed challenge — Bright
// Data times out on it intermittently (observed ~50% first-attempt failure
// rate live during this script's development) even though a retry usually
// succeeds. A small retry here avoids treating a transient BD timeout as a
// permanent "can't recover this file".
async function fetchPageWithRetry(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchPage(url, { source: 'recover-talkinbroadway-forum-links' });
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) console.log(`  (retry ${i + 1}/${attempts - 1} after: ${e.message})`);
    }
  }
  throw lastErr;
}

// Batch scripts must checkpoint (CLAUDE.md rule 8): a git write outside this
// process (CI's rebuild-reviews, another local session) can silently
// overwrite an on-disk recovery before this script ever gets to `git add`
// at the end of a run — committing after each successful recovery shrinks
// that exposure window from the whole batch to a single candidate. Mirrors
// scripts/recover-serp-text.js's checkpointReviewTexts, without that
// script's restore-protected-fields step (this script never touches
// protected fields on OTHER outlets' files, only the talkinbroadway husk it
// just wrote).
function checkpointReviewTexts(label) {
  try {
    execSync('git add -A', { cwd: reviewTextsDir, stdio: 'pipe' });
    try {
      execSync('git diff --staged --quiet', { cwd: reviewTextsDir, stdio: 'pipe' });
      return; // nothing to commit
    } catch { /* has staged changes */ }
    execSync(`git commit -m "data: ${label} checkpoint"`, { cwd: reviewTextsDir, stdio: 'pipe' });
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        execSync('git pull --rebase origin main', { cwd: reviewTextsDir, stdio: 'pipe' });
        execSync('git push origin main', { cwd: reviewTextsDir, stdio: 'pipe' });
        console.log(`  [checkpoint] pushed review-texts (attempt ${attempt})`);
        return;
      } catch (e) {
        try { execSync('git rebase --abort', { cwd: reviewTextsDir, stdio: 'pipe' }); } catch { /* nothing to abort */ }
        if (attempt === 3) console.warn(`  [checkpoint] WARNING: failed to push after 3 attempts: ${e.message.slice(0, 200)}`);
      }
    }
  } catch (e) {
    console.warn(`  [checkpoint] error: ${e.message.slice(0, 200)}`);
  }
}

function findCandidateFiles() {
  const results = [];
  for (const showId of fs.readdirSync(reviewTextsDir)) {
    if (onlyShow && showId !== onlyShow) continue;
    const showDir = path.join(reviewTextsDir, showId);
    if (!fs.statSync(showDir).isDirectory()) continue;
    for (const file of fs.readdirSync(showDir)) {
      if (!file.startsWith('talkinbroadway--') || !file.endsWith('.json')) continue;
      const filePath = path.join(showDir, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        continue;
      }
      if (!isForumThreadUrl(data.url)) continue;
      // Some threads embed the full review inline — already complete, no
      // recovery needed (verified: 6 files corpus-wide, BRO-3788).
      if (data.contentTier === 'complete') continue;
      results.push({ showId, filePath, file, data });
    }
  }
  return results;
}

async function resolveReviewPageUrl(forumUrl) {
  const r = await fetchPageWithRetry(forumUrl);
  return extractReviewPageUrl(extractHtml(r));
}

async function resolveCriticName(reviewPageUrl) {
  const r = await fetchPageWithRetry(reviewPageUrl);
  return extractCriticName(extractHtml(r));
}

async function run() {
  const candidates = findCandidateFiles();
  console.log(`Found ${candidates.length} candidate file(s) with a dead-end forum URL.`);

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const { showId, filePath, file } of candidates) {
    console.log(`\n=== ${showId} / ${file} ===`);
    const showDir = path.dirname(filePath);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    let reviewPageUrl;
    try {
      reviewPageUrl = await resolveReviewPageUrl(data.url);
    } catch (e) {
      console.error(`  forum thread fetch failed: ${e.message}`);
      failed++;
      continue;
    }
    if (!reviewPageUrl) {
      console.error('  could not find a "Link" anchor in the forum thread — page shape may differ, skipping');
      skipped++;
      continue;
    }
    console.log(`  review page: ${reviewPageUrl}`);

    let critic = null;
    try {
      critic = await resolveCriticName(reviewPageUrl);
    } catch (e) {
      console.warn(`  critic lookup failed (${e.message}) — ingest will fall back to Unknown`);
    }
    if (critic) console.log(`  critic: ${critic}`);

    if (dryRun) {
      console.log(`  [dry-run] would ingest --show=${showId} --url=${reviewPageUrl}${critic ? ` --critic="${critic}"` : ''}`);
      continue;
    }

    const ingestArgs = [
      path.join(__dirname, 'ingest-review-from-url.js'),
      `--show=${showId}`,
      `--url=${reviewPageUrl}`,
      '--outlet=talkinbroadway',
      `--data-dir=${reviewTextsDir}`,
    ];
    if (critic) ingestArgs.push(`--critic=${critic}`);

    let stdout;
    try {
      stdout = execFileSync('node', ingestArgs, { encoding: 'utf8' });
      console.log(stdout.trim().split('\n').map((l) => `  ${l}`).join('\n'));
    } catch (e) {
      console.error(`  ingest failed: ${((e.stdout || '') + (e.stderr || e.message)).trim()}`);
      failed++;
      continue;
    }

    const writeMatch = stdout.match(/✅ (?:Created|Updated): (.+)/);
    if (!writeMatch) {
      console.warn('  ingest reported no write (skipped/no-op) — leaving husk file in place');
      skipped++;
      continue;
    }
    const newFilePath = writeMatch[1].trim();

    // createOrMergeReviewFile's merge-into-existing path only fills BLANK
    // fields — when the "Updated" target already has a non-blank (but
    // wrong) url/fullText from the old forum-thread fetch, the merge
    // silently keeps them and the husk's url never actually changes
    // (observed live during this script's development: girl-interrupted,
    // lean-to, romeo-and-juliet-off-broadway all reported "✅ Updated" but
    // left the forum URL in place). Verify the write actually landed
    // before trusting "Updated" — a stale merge needs the same manual
    // field-correction this script's own commit history shows, not a
    // silent false-positive success count.
    let landedUrl = null;
    try {
      landedUrl = JSON.parse(fs.readFileSync(newFilePath, 'utf8')).url;
    } catch { /* file unreadable — fall through to the mismatch branch below */ }
    if (landedUrl !== reviewPageUrl) {
      console.warn(`  ⚠️  ingest reported "Updated" but ${newFilePath} still has url=${landedUrl} (expected ${reviewPageUrl}) — merge-into-existing only fills blank fields. Manual field correction needed; leaving husk in place.`);
      skipped++;
      continue;
    }

    if (path.resolve(newFilePath) !== path.resolve(filePath) && fs.existsSync(newFilePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`  deleted superseded husk: ${path.join(showDir, file)}`);
      } catch (e) {
        // Non-fatal — the new file already landed and is what matters; a
        // leftover husk is cosmetic clutter, not a reason to abort every
        // remaining candidate in the batch.
        console.warn(`  ⚠️  could not delete husk ${path.join(showDir, file)}: ${e.message}`);
      }
    }
    succeeded++;
    checkpointReviewTexts(`recover-talkinbroadway-forum-links (${showId})`);
  }

  console.log(`\nDone. ${succeeded} succeeded, ${failed} failed, ${skipped} skipped.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

run().catch((e) => {
  console.error('Fatal:', e.stack || e.message);
  process.exit(1);
});
