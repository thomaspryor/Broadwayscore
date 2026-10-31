#!/usr/bin/env node
/**
 * Flag review-text files that share a URL across 2+ different shows as
 * isCombinedReview: true. These are legitimate multi-show articles.
 *
 * Usage:
 *   node scripts/flag-combined-reviews.js --dry-run
 *   node scripts/flag-combined-reviews.js
 */
const { isReviewTextFile } = require('./lib/review-text-sidecars');
const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');
const { baseSlug, normalizeArticleUrl, isBogusCombinedFlag, computeCombinedWith, shouldRecoverJointWrongShow } = require('./lib/combined-review-utils');
const { isCombinedReviewOfOtherMemberOnly } = require('./lib/review-guards');
const { clearWrongProductionFlags } = require('./lib/wrong-production-clear');
const { buildSiblingIndex } = require('./lib/market-routing');

const { hasHelpFlag } = require('./lib/cli-help.js');
const { markRescoreNeeded } = require('./lib/rescore-flagging');

const USAGE = `flag-combined-reviews.js — Flag review-text files that share a URL across 2+ different shows as.

Usage:
  node scripts/flag-combined-reviews.js [options]
  node scripts/flag-combined-reviews.js --help, -h    print this usage and exit
`;
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');

function loadShows() {
  const raw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return Array.isArray(raw) ? raw : raw.shows;
}

const normalizeUrl = normalizeArticleUrl;

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'));
  const urlMap = new Map();

  for (const dir of showDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, dir.name);
    const files = fs.readdirSync(showDir).filter(f => isReviewTextFile(f));
    for (const file of files) {
      const filePath = path.join(showDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        // NOTE: wrongShow:true is INTENTIONALLY not skipped here. The
        // ensemble-scoreability-check rejects joint reviews as wrong_show
        // when the article spends most of its words on the OTHER show in the
        // pairing (issue #316: NYer Schmigadoon!/Lost Boys). If the same URL
        // appears in another show's directory, that's the strongest possible
        // signal it's a legitimate joint review — flag it so wrongShowCleared()
        // includes it in rebuild.
        if (data.wrongProduction || data.isRoundupArticle ||
            data.duplicateOf || data.fabricatedEntry) continue;
        if (!data.url) continue;
        const normUrl = normalizeUrl(data.url);
        if (!normUrl) continue;
        if (!urlMap.has(normUrl)) urlMap.set(normUrl, []);
        urlMap.get(normUrl).push({ showId: dir.name, file, filePath });
      } catch { continue; }
    }
  }

  // baseSlug() lives in scripts/lib/combined-review-utils.js so unit tests
  // can require() the real function. Joint review = URL that genuinely spans
  // 2+ DIFFERENT base shows (e.g. lost-boys + schmigadoon, NOT
  // the-lost-boys + the-lost-boys-2026).

  const allShows = loadShows();
  const siblingIndex = buildSiblingIndex(allShows);
  const titleById = new Map(allShows.map((s) => [s.id, s.title]));
  const showRecordById = new Map(allShows.map((s) => [s.id, s]));

  let flagged = 0, urlCount = 0, siblingEntriesSkipped = 0, staleFlagsCleared = 0;
  for (const [url, entries] of urlMap) {
    const uniqueShows = new Set(entries.map(e => e.showId));
    if (uniqueShows.size < 2) {
      // BRO-6682: a flag stamped under the old collapsed URL key (LSA story.asp,
      // ~400-show combinedWith) must not outlive the key that produced it.
      for (const entry of entries) {
        try {
          const data = JSON.parse(fs.readFileSync(entry.filePath, 'utf8'));
          if (!isBogusCombinedFlag(data)) continue;
          staleFlagsCleared++;
          if (DRY_RUN) { console.log(`  [would clear bogus isCombinedReview, ${data.combinedWith.length} shows] ${entry.showId}/${entry.file}`); continue; }
          data.isCombinedReview = false;
          data.combinedWith = null;
          safeWriteReview(entry.filePath, data);
        } catch { /* unreadable file: other checks report it */ }
      }
      continue;
    }
    // Require 2+ DIFFERENT base shows. Filters out same-production-different-id
    // cases that aren't joint reviews.
    const uniqueBaseShows = new Set([...uniqueShows].map(baseSlug));
    if (uniqueBaseShows.size < 2) continue;
    urlCount++;
    const showList = Array.from(uniqueShows);
    if (DRY_RUN) {
      console.log(`URL: ${url.substring(0, 100)}`);
      for (const e of entries) console.log(`  ${e.showId}/${e.file}`);
      console.log();
    }
    for (const entry of entries) {
      // baseSlug() doesn't strip every market suffix (e.g. "-at-art-regional"),
      // so a same-title transfer pair like a regional run and its Broadway
      // transfer can still pass the ">= 2 different base shows" check above.
      // That pair is NOT a joint review — classifyMarketRouting() /
      // audit-sibling-title-misroute.js already own routing the review to
      // exactly ONE sibling by date proximity. Filtered per-entry (not by
      // skipping the whole URL group) so a MIXED group — a sibling pair AND
      // a genuinely different show sharing the same URL (e.g. a roundup
      // covering both) — still flags the real joint-review relationship
      // without the sibling pair re-duplicating into each other's dirs via
      // combinedWith (a whole-group skip would still list the sibling in a
      // 3-member group's combinedWith, reintroducing the exact bug).
      const newCombinedWith = computeCombinedWith(entry.showId, showList, siblingIndex);
      if (newCombinedWith.length === 0) {
        siblingEntriesSkipped++;
        if (DRY_RUN) console.log(`  [sibling-only, no genuine joint review] ${entry.showId}/${entry.file}`);
        // Backfill: a prior buggy run (pre task #1608 fix) may have already
        // stamped this file isCombinedReview:true with ONLY a title-sibling
        // in combinedWith — a stale false-positive, not something this run
        // would newly flag. Clear it so the cross-show contamination guards
        // that treat isCombinedReview as an exemption
        // (audit-cross-show-url-collisions.js, audit-cross-attribution-by-
        // critic.js, scripts/lib/url-ownership.js, validate-data.js) stop
        // skipping it. null, not delete — combinedWith has no CLEAR_BREADCRUMBS
        // entry, so a delete is silently reverted by safeWriteReview's
        // merge-mode restore pass (same footgun as the wrongShow-recovery
        // block below; confirmed live on buena-vista-social-club-2025/
        // cititour--brian-scott-lipton.json — delete came back on disk).
        {
          const data = JSON.parse(fs.readFileSync(entry.filePath, 'utf8'));
          // Re-check flags on fresh read (handles concurrent modifications) —
          // same guard the flagging branch below applies (code-review finding,
          // 2026-08-15: this branch was writing unconditionally on a race).
          if (data.wrongProduction || data.duplicateOf || data.fabricatedEntry) continue;
          if (data.isCombinedReview === true) {
            staleFlagsCleared++;
            if (DRY_RUN) {
              console.log(`  [would clear stale isCombinedReview] ${entry.showId}/${entry.file}`);
            } else {
              data.isCombinedReview = false;
              data.combinedWith = null;
              safeWriteReview(entry.filePath, data);
            }
          }
        }
        continue;
      }
      if (!DRY_RUN) {
        const data = JSON.parse(fs.readFileSync(entry.filePath, 'utf8'));
        // Re-check flags on fresh read (handles concurrent modifications).
        // wrongShow stays in the recovery path — see top-of-loop comment.
        if (data.wrongProduction || data.duplicateOf || data.fabricatedEntry) continue;
        const existingCombinedWith = (data.combinedWith || []).slice().sort();
        // Only write if flag is new or combinedWith list changed
        if (data.isCombinedReview && JSON.stringify(newCombinedWith) === JSON.stringify(existingCombinedWith)) {
          // Even when combinedWith is unchanged, still recover stale wrongShow
          // flags below — those clear the rebuild gate.
        } else {
          data.isCombinedReview = true;
          data.combinedWith = newCombinedWith;
        }
        // Recover from a stale wrongShow rejection: a URL that exists in 2+
        // show dirs (excluding this entry's own title-siblings) is intentional
        // joint coverage, not a wrong-show false positive. Clear the flag so
        // this file lands in reviews.json.
        // Refused for a human-approved flag or a body that never names this show (BRO-4599).
        // BRO-2746: never recover when the url names only a co-member show and the
        // text never names this one: that is the other show's review misfiled here
        // (CARE's Stage review under A Month in the Country). The rebuild excludes
        // it through the same predicate.
        const otherMemberOnly = isCombinedReviewOfOtherMemberOnly(data, showRecordById.get(entry.showId));
        if (otherMemberOnly) console.log(`  [not joint: url names only a co-member] ${entry.showId}/${entry.file}`);
        if (!otherMemberOnly && shouldRecoverJointWrongShow(data, titleById.get(entry.showId) || null)) {
          clearWrongProductionFlags(data, {
            source: 'flag-combined-reviews.js',
            reason: 'URL co-occurs across ' + (newCombinedWith.length + 1) + ' show dirs — joint review',
            wrongShowOnly: true,
          });
          // The override clears the rebuild gate, but the scorer's UNSCORED /
          // needsRescore queries (llm-ensemble-score.yml) BOTH exclude any file
          // that still carries a rejectionReason — so the file would land in
          // reviews.json unscored and never be picked up (the Mandell / NY
          // Theater combined-review deadlock, girl-interrupted 2026-06-05).
          // Clear the stale rejection breadcrumbs and request a rescore so the
          // combined-review Haiku fallback (llm-scoring/index.ts) can run.
          // null, not delete — none of these fields has a CLEAR_BREADCRUMBS
          // entry, so a delete is silently reverted by safeWriteReview's
          // merge-mode restore pass (task #1624).
          data.rejectionReason = null;
          data.rejectedBy = null;
          data.rejectedAt = null;
          data.rejectionReasoning = null;
          data.rescoreCompletedAt = null;
          markRescoreNeeded(data, data.rescoreReason || 'combined review rejection cleared', undefined, { requeue: true });
        }
        safeWriteReview(entry.filePath, data);
      }
      flagged++;
    }
  }

  console.log('=== SUMMARY ===');
  console.log(`URLs shared across 2+ shows: ${urlCount}`);
  console.log(`Files flagged isCombinedReview: ${flagged}`);
  console.log(`Entries skipped (co-occurrence was only with a same-title sibling, owned by market-routing instead): ${siblingEntriesSkipped}`);
  console.log(`Stale isCombinedReview flags cleared (backfill of pre-fix false positives): ${staleFlagsCleared}`);
  if (DRY_RUN) console.log('(DRY RUN)');
}

main();
