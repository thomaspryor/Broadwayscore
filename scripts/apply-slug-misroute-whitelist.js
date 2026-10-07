#!/usr/bin/env node
/**
 * Apply hand-picked slug-misroute corrections.
 *
 * Reads a whitelist (default `/tmp/move-whitelist.json`). Accepts EITHER the
 * enriched audit object `{ findings:[ { from,to,file,confirm,outOfScope,
 * warnings,... } ] }` written by scripts/audit-slug-match-routing.js, OR a
 * legacy flat array `[ { from,to,file } ]`. A row moves only when
 * `isConfirmed()` passes: `confirm===true` AND `!outOfScope` AND no blocking
 * `warnings` (legacy rows with no `confirm` field keep the old opt-in
 * behavior). Uses `safeRenameReview` from review-write-guard.js, which:
 *   - refuses to overwrite an existing destination (returns 'conflict')
 *   - respects `_locked: true` (returns 'locked')
 *   - moves the matching `data/llm-scores/{showId}/{file}` sidecar
 *   - rewrites same-show `duplicateTextOf` sibling pointers
 * A move whose llm-scores sidecar CONFLICTED (both existed) is reported as
 * `needs-triage`, never as a clean `[MOVED]` — the scoring data is split.
 *
 * Safety mechanisms added 2026-05-28 (post 6-reviewer plan-review):
 *   - confirm/outOfScope/warnings gate (the 2026-05-27 HOLIDAY-INN revert).
 *   - stale guard: re-runs the year-aware matcher per file; aborts if the
 *     file no longer routes to the whitelisted `to` (concurrent scraper edits).
 *   - dest-exists is split by article URL: same-url → orphan-delete candidate
 *     (deferred, NOT auto-deleted); diff-url → flagged unresolved.
 *   Deferred items are written to apply-slug-misroute-deferred.json.
 *
 * Dry-run default. Pass `--apply` to actually move files.
 *
 * Caller responsibilities BEFORE invoking with --apply (per batch of 3-5):
 *   1. `gh workflow disable` the cron writers: scrape-new-aggregators,
 *      rebuild-fast, enrich-reviews, opening-night-orchestrator,
 *      collect-review-texts, AND opening-night-broadcast (it auto-fires on
 *      workflow_run — disabling the orchestrator does NOT stop it). Verify
 *      with `gh workflow list` that they show disabled.
 *   2. `cd` into the review-texts private repo clone. `git tag
 *      pre-misroute-batch-N-$(date +%Y%m%dT%H%M%S)`. `git fetch && git merge
 *      --ff-only`. If non-ff: ABORT — do NOT rebase a destructive move (a
 *      rebase resurrects the deleted FROM files → duplicates; the 2026-04-11
 *      / pull-rebase-clobber memory).
 *   3. Run THIS script with --apply.
 *   4. `git add -A && git commit && git push` (on push reject: fetch +
 *      ff-only retry; if non-ff, ABORT and rebuild the whitelist fresh).
 *   5. Re-enable the disabled workflows.
 *   6. Trigger `Rebuild Reviews (Fast)`; WAIT for completion.
 *   7. Spot-check live: each affected SHOW page AND each affected CRITIC page
 *      AND structured-data review counts. Confirm FROM kept its legit reviews
 *      and score deltas are expected. Only then the next batch.
 */

const fs = require('fs');
const path = require('path');
const { safeRenameReview } = require('./lib/review-write-guard');
const {
  matchSlugToShow, matchBwwRoundupSlugToShow, loadShows,
} = require('./lib/show-matching');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const whitelistPath = (args.find(a => a.startsWith('--whitelist=')) || '').replace('--whitelist=', '')
  || '/tmp/move-whitelist.json';

// A move is eligible only when the operator explicitly confirmed it and the
// harness raised no blocking flags. The 2026-05-27 incident (10 wrong
// HOLIDAY-INN moves) is why outOfScope/warnings hard-block regardless of a
// stray confirm:true.
//
// `enriched` = the whitelist came from the audit's {findings:[...]} object.
// Enriched rows MUST carry an explicit confirm===true AND a `warnings` array;
// a row that dropped either field (hand-edit / bad transform) is treated as
// unconfirmed rather than silently auto-moving. Only a genuinely legacy flat
// array of {from,to,file} (no enrichment) keeps the historical opt-in default.
function isConfirmed(m, enriched) {
  if (m.outOfScope === true) return false;
  if (Array.isArray(m.warnings) && m.warnings.length > 0) return false;
  if (enriched) {
    if (!Array.isArray(m.warnings)) return false;      // dropped safety field
    return m.confirm === true;
  }
  if (Object.prototype.hasOwnProperty.call(m, 'confirm')) return m.confirm === true;
  return true; // legacy {from,to,file} entry
}

// Re-derive the article slug + source + year from a review file exactly as the
// audit does, then re-run the year-aware matcher. Used as a stale guard: the
// whitelist may have been built hours/days before apply while CI committed to
// review-texts every ~30 min, so the file's correct destination can have
// changed underneath the operator.
function currentRouting(reviewPath, shows) {
  let r;
  try { r = JSON.parse(fs.readFileSync(reviewPath, 'utf8')); } catch { return null; }
  let slug = null, source = null, matcher = null;
  if (r.playbillVerdictUrl && r.playbillVerdictUrl.includes('playbill.com/article/')) {
    slug = (r.playbillVerdictUrl.split('/article/')[1] || '').replace(/[?#].*$/, '');
    source = 'pv'; matcher = matchSlugToShow;
  } else if (r.bwwRoundupUrl && /review-roundup/i.test(r.bwwRoundupUrl)) {
    slug = r.bwwRoundupUrl.split('/article/')[1] || '';
    source = 'bww'; matcher = matchBwwRoundupSlugToShow;
  }
  if (!slug || !matcher) return null;
  // Match the PRODUCTION matcher's year derivation EXACTLY so the stale guard
  // reproduces live routing: BWW derives the year only from the slug tail (it
  // never sees publishDate); only PV (no date in slug) falls back to
  // publishDate. An undated BWW slug stays year-less here too.
  let year = null;
  if (source === 'bww') { const m = String(slug).match(/-(\d{8})$/); if (m) { const y = parseInt(m[1].slice(0, 4), 10); if (y >= 1900 && y <= 2100) year = y; } }
  else if (r.publishDate) { const y = parseInt(String(r.publishDate).slice(0, 4), 10); if (y >= 1900 && y <= 2100) year = y; }
  const res = matcher(slug, shows, year ? { year } : {});
  return { showId: res ? res.show.id : null, url: r.playbillVerdictUrl || r.bwwRoundupUrl || null };
}

function reviewUrl(p) {
  try { const r = JSON.parse(fs.readFileSync(p, 'utf8')); return r.playbillVerdictUrl || r.bwwRoundupUrl || r.url || null; }
  catch { return null; }
}

// WRITES (--apply moves files via safeRenameReview) — see scripts/lib/review-texts-dir.js.
const REVIEW_TEXTS_DIR = resolveReviewTextsDir();

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

const raw = JSON.parse(fs.readFileSync(whitelistPath, 'utf8'));
// Accept the enriched audit object ({findings:[...]}) OR a legacy flat array.
const enriched = !Array.isArray(raw) && Array.isArray(raw.findings);
const allEntries = Array.isArray(raw) ? raw : (enriched ? raw.findings : null);
if (!allEntries || allEntries.length === 0) {
  console.error('Whitelist is empty, or not an array / {findings:[...]} object.');
  process.exit(1);
}

const moves = allEntries.filter(m => isConfirmed(m, enriched));
const blockedCount = allEntries.length - moves.length;

const shows = loadShows();

console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log(`review-texts: ${REVIEW_TEXTS_DIR}`);
console.log(`Whitelist: ${whitelistPath} (${allEntries.length} entries, ${moves.length} confirmed, ${blockedCount} blocked by !confirm/outOfScope/warnings)`);
console.log();

const results = { moved: 0, skipped: 0, errors: 0, needsTriage: 0, byReason: {} };
const orphanCandidates = [];   // dest-exists, SAME url — redundant FROM copy
const unresolved = [];         // dest-exists, DIFFERENT url — real conflict
const staleSkips = [];         // current routing no longer matches whitelist `to`
const bump = (k) => { results.byReason[k] = (results.byReason[k] || 0) + 1; };

for (const m of moves) {
  const src = path.join(REVIEW_TEXTS_DIR, m.from, m.file);
  const dst = path.join(REVIEW_TEXTS_DIR, m.to, m.file);

  if (!fs.existsSync(src)) {
    results.skipped++; bump('source-missing');
    console.log(`  [SKIP source-missing] ${m.from}/${m.file}`);
    continue;
  }

  // Stale guard: the year-aware matcher must STILL route this file to m.to.
  // If the whitelist went stale (concurrent scraper edits, shows.json change),
  // abort the file rather than move it on outdated reasoning.
  const routing = currentRouting(src, shows);
  if (!routing || routing.showId !== m.to) {
    results.skipped++; bump('stale-routing');
    staleSkips.push({ from: m.from, to: m.to, file: m.file, nowRoutesTo: routing ? routing.showId : null });
    console.log(`  [SKIP stale-routing]  ${m.from}/${m.file} → wanted ${m.to}, now routes to ${routing ? routing.showId : 'NULL'}`);
    continue;
  }

  if (fs.existsSync(dst)) {
    // The correct show already has a copy. Compare article URLs: SAME → the
    // FROM file is a redundant orphan (separate safeUnlinkReview sub-task, NOT
    // auto-deleted here). DIFFERENT → a real distinct review is already there;
    // do NOT silently skip — flag it.
    const srcUrl = reviewUrl(src), dstUrl = reviewUrl(dst);
    results.skipped++;
    if (srcUrl && dstUrl && srcUrl === dstUrl) {
      bump('dest-exists-same-url');
      orphanCandidates.push({ from: m.from, to: m.to, file: m.file, url: srcUrl });
      console.log(`  [SKIP dest-exists/same-url → orphan-delete candidate] ${m.from}/${m.file}`);
    } else {
      bump('dest-exists-diff-url');
      unresolved.push({ from: m.from, to: m.to, file: m.file, srcUrl, dstUrl });
      console.log(`  [SKIP dest-exists/DIFF-url — UNRESOLVED] ${m.from}/${m.file} (src=${srcUrl} dst=${dstUrl})`);
    }
    continue;
  }

  if (!APPLY) {
    results.moved++;
    console.log(`  [WOULD-MOVE]          ${m.from}/${m.file} → ${m.to}/`);
    continue;
  }

  const r = safeRenameReview(src, dst);
  if (r.wrote && r.renamed) {
    // A moved review text whose llm-scores sidecar could not follow is NOT a
    // clean move — the scoring data is split across source/dest show dirs.
    if (r.sisterStoreConflict || r.sisterStoreError) {
      results.needsTriage++; bump('sister-store-needs-triage');
      console.log(`  [MOVED⚠ needs-triage] ${m.from}/${m.file} → ${m.to}/ (llm-score ${r.sisterStoreError ? 'error: ' + r.sisterStoreError : 'conflict — both sidecars kept'})`);
    } else {
      results.moved++;
      const sister = r.sisterStoreMoved ? ' (+llm-score)' : '';
      console.log(`  [MOVED]               ${m.from}/${m.file} → ${m.to}/${sister}`);
    }
  } else {
    results.errors++;
    bump(r.skipped || 'unknown');
    console.log(`  [ERR ${r.skipped || 'unknown'}]        ${m.from}/${m.file}`);
  }
}

console.log();
console.log(`=== Summary ===`);
console.log(`  ${APPLY ? 'Moved (clean)' : 'Would move'}: ${results.moved}`);
console.log(`  Needs triage (split scoring): ${results.needsTriage}`);
console.log(`  Skipped:               ${results.skipped}`);
console.log(`  Errors:                ${results.errors}`);
for (const [k, n] of Object.entries(results.byReason)) {
  console.log(`    ${k.padEnd(24)}: ${n}`);
}

// Persist the deferred sub-tasks so a follow-up run / operator can act on them.
const sidecarOut = {
  generatedAt: new Date().toISOString(),
  orphanDeleteCandidates: orphanCandidates,   // dest-exists, same article URL
  unresolvedDiffUrl: unresolved,              // dest-exists, different review
  staleSkips,                                 // routing changed since whitelist built
};
const sidecarPath = path.join(path.dirname(whitelistPath), 'apply-slug-misroute-deferred.json');
try {
  fs.writeFileSync(sidecarPath, JSON.stringify(sidecarOut, null, 2));
  if (orphanCandidates.length || unresolved.length || staleSkips.length) {
    console.log();
    console.log(`  Deferred items written to ${sidecarPath}:`);
    console.log(`    orphan-delete candidates (same-url): ${orphanCandidates.length}`);
    console.log(`    unresolved (diff-url):               ${unresolved.length}`);
    console.log(`    stale-routing skips:                 ${staleSkips.length}`);
  }
} catch (e) { console.warn(`Could not write ${sidecarPath}: ${e.message}`); }

if (!APPLY) {
  console.log();
  console.log('Dry-run complete. Re-run with --apply to actually move files.');
}
