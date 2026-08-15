#!/usr/bin/env node
/**
 * audit-sibling-title-misroute.js — backfill audit for the SAME-TITLE sibling
 * class of cross-show contamination: two shows.json entries with the same
 * (normalized) title — most commonly a regional/pre-Broadway run and its
 * Broadway transfer, linked via transferOf/transferredTo — where a review
 * landed under the WRONG one of the pair.
 *
 * classifyMarketRouting() (scripts/lib/market-routing.js) already prevents
 * this at WRITE time. What it can't do is retroactively fix files that were
 * written before the guard existed (or before a since-fixed bug in it) — the
 * guard only ever runs on the review being written *right now*. Found
 * 2026-08-14: two-strangers-carry-a-cake-across-new-york-at-art-regional-2025
 * carried 4 live reviews (NYT, TheWrap, NYSR x2) that are actually about the
 * Broadway transfer, dated from before firstSeenAt stamping existed. Nothing
 * had ever re-checked existing files against the guard's current logic.
 *
 * This script closes that gap: for every show with a same-title sibling, it
 * re-runs classifyMarketRouting against each existing review-texts file's own
 * url/publishDate, and reports (or --fix) any file the guard would place
 * differently today.
 *
 * --fix is for manual, supervised runs only — same posture as
 * audit-cross-show-url.js's own "report-only by default, NEVER auto --fix
 * the whole corpus" rule. It is NOT wired into any CI workflow with --fix.
 * Two reasons: (1) it moves/deletes files non-atomically (read → write →
 * unlink, no lock, no transaction) against a directory tree that many
 * scheduled scrapers write to concurrently — running --fix unattended risks
 * racing a live write; (2) classifyMarketRouting's signals (date proximity,
 * URL year, venue substrings) can still disagree with clear content evidence
 * on individual files (found while building this: 4 flagged shows where the
 * date-only Tier-1 heuristic contradicted an explicit "-broadway-" or
 * "/london/" URL marker) — verify each --fix target by hand before applying,
 * the way this script's own author did for the Two Strangers pair.
 * Rollback: data/review-texts is a git repo (private broadway-review-texts) —
 * a bad --fix run is a normal `git revert` on that commit, same as any other
 * data-repo mistake. Run --fix against a clean working tree so the run is
 * its own isolated, revertible commit.
 *
 * Usage:
 *   node scripts/audit-sibling-title-misroute.js                 # report
 *   node scripts/audit-sibling-title-misroute.js --show=ID        # one show
 *   node scripts/audit-sibling-title-misroute.js --fix            # apply
 *   node scripts/audit-sibling-title-misroute.js --json
 *   node scripts/audit-sibling-title-misroute.js --strict --max=0 # CI gate
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { buildSiblingIndex, classifyMarketRouting } = require('./lib/market-routing');
const { parseMaxArgOrExit } = require('./lib/parse-max-arg.js');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

const ARGV = process.argv.slice(2);
const FIX = ARGV.includes('--fix');
const JSON_OUT = ARGV.includes('--json');
const STRICT = ARGV.includes('--strict');
const showArg = ARGV.find(a => a.startsWith('--show='));
const ONLY_SHOW = showArg ? showArg.replace('--show=', '').trim() : null;

// Mirrors review-file-writer.js's humanCleared check — never override an
// explicit human decision, whichever direction it went.
function isHumanCleared(d) {
  return !!(d && (
    d.humanReviewedWrongProduction === false ||
    d.wrongProductionManualClear === true ||
    d.wrongProductionOverride === true ||
    d.wrongProduction === false
  ));
}

// Already flagged (by this guard or any other) — not this audit's job to redo.
function isAlreadyFlagged(d) {
  return !!(d && (d.wrongProduction === true || d.wrongShow === true));
}

// Ordinal content-quality rank so --fix's dedup-by-URL path never discards
// the better of two copies of the same review. Ties (equal rank) keep the
// EXISTING target copy and drop the source — never destructive when quality
// is indistinguishable. Mirrors the tier order used elsewhere in the corpus
// (complete > truncated > excerpt > stub > invalid/missing).
const CONTENT_TIER_RANK = { complete: 4, truncated: 3, excerpt: 2, stub: 1, invalid: 0 };
function reviewQualityRank(d) {
  const tierRank = CONTENT_TIER_RANK[d && d.contentTier] ?? -1;
  const hasScore = d && (d.assignedScore != null || (d.llmScore && d.llmScore.score != null)) ? 1 : 0;
  const textLen = (d && typeof d.fullText === 'string') ? d.fullText.length : 0;
  return [tierRank, hasScore, textLen];
}
function isHigherQuality(a, b) {
  const ra = reviewQualityRank(a);
  const rb = reviewQualityRank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) return ra[i] > rb[i];
  }
  return false;
}

// Find a filename in targetDir that doesn't collide, looping (not a single
// one-shot rename) so a second/third collision can't silently overwrite an
// unrelated file before the source is unlinked.
function uniqueDestName(targetDir, baseName) {
  let destName = baseName;
  let n = 1;
  while (fs.existsSync(path.join(targetDir, destName))) {
    n++;
    destName = baseName.replace(/\.json$/, `-rerouted${n > 2 ? `-${n}` : ''}.json`);
  }
  return destName;
}

function loadShows() {
  const raw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return Array.isArray(raw) ? raw : raw.shows;
}

function main() {
  let MAX;
  if (STRICT) MAX = parseMaxArgOrExit(ARGV, { scriptName: 'audit-sibling-title-misroute' });

  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error(`✗ review-texts not found at ${REVIEW_TEXTS_DIR} (worktree without data symlinks?)`);
    process.exit(2);
  }

  const shows = loadShows();
  const byId = new Map(shows.map(s => [s.id, s]));
  const siblingIndex = buildSiblingIndex(shows);

  let dirs = listShowDirs(REVIEW_TEXTS_DIR, { silent: true })
    .filter(d => d !== '_pending' && d !== '_superseded-misattributed');
  if (ONLY_SHOW) dirs = dirs.filter(d => d === ONLY_SHOW);

  let scanned = 0;
  const hits = [];

  for (const showId of dirs) {
    const sibData = siblingIndex.get(showId);
    if (!sibData || !sibData.siblings.length) continue; // no same-title sibling — nothing to check
    const show = byId.get(showId);
    if (!show) continue;

    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try { files = fs.readdirSync(showDir).filter(f => f.endsWith('.json')); } catch { continue; }

    for (const f of files) {
      const fp = path.join(showDir, f);
      let d;
      try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      if (!d.url) continue;
      scanned++;

      if (isHumanCleared(d)) continue;

      const decision = classifyMarketRouting({
        showId,
        url: d.url,
        outletId: d.outletId,
        publishDate: d.publishDate,
        category: show.category,
        siblingIndex,
      });

      if (decision.action === 'reroute' && !isAlreadyFlagged(d)) {
        hits.push({
          type: 'reroute', showId, targetShowId: decision.targetShowId, file: f, filePath: fp,
          url: d.url, reason: decision.reason,
        });
      } else if (decision.action === 'accept' && decision.flag === 'wrongProduction' && !isAlreadyFlagged(d)) {
        hits.push({
          type: 'ambiguous', showId, file: f, filePath: fp, url: d.url,
          reason: decision.reason, signalsByCandidate: decision.signalsByCandidate,
        });
      } else if (decision.action === 'reject') {
        hits.push({ type: 'reject', showId, file: f, filePath: fp, url: d.url, reason: decision.reason });
      }
    }
  }

  const rerouteHits = hits.filter(h => h.type === 'reroute');
  const ambiguousHits = hits.filter(h => h.type === 'ambiguous');
  const rejectHits = hits.filter(h => h.type === 'reject');

  if (FIX) {
    for (const h of rerouteHits) {
      try {
        const d = JSON.parse(fs.readFileSync(h.filePath, 'utf8'));
        const targetDir = path.join(REVIEW_TEXTS_DIR, h.targetShowId);
        const normUrl = String(d.url).toLowerCase().replace(/[#?].*$/, '').replace(/\/+$/, '');
        let existingMatch = null; // { file, data } — the target-dir file with the same URL, if any
        if (fs.existsSync(targetDir)) {
          for (const tf of fs.readdirSync(targetDir).filter(x => x.endsWith('.json'))) {
            try {
              const td = JSON.parse(fs.readFileSync(path.join(targetDir, tf), 'utf8'));
              const tUrl = td.url ? String(td.url).toLowerCase().replace(/[#?].*$/, '').replace(/\/+$/, '') : null;
              if (tUrl && tUrl === normUrl) { existingMatch = { file: tf, data: td }; break; }
            } catch { /* skip unreadable */ }
          }
        }
        if (existingMatch) {
          if (isHigherQuality(d, existingMatch.data)) {
            // The misrouted copy is BETTER than what's already at the target
            // (e.g. complete text vs a stub) — overwrite the target with it
            // instead of discarding it, then remove the source.
            d.showId = h.targetShowId;
            fs.writeFileSync(path.join(targetDir, existingMatch.file), JSON.stringify(d, null, 2) + '\n');
            fs.unlinkSync(h.filePath);
            h.applied = `overwrote-lower-quality-duplicate:${path.join(h.targetShowId, existingMatch.file)}`;
          } else {
            fs.unlinkSync(h.filePath);
            h.applied = 'deleted-duplicate';
          }
        } else {
          fs.mkdirSync(targetDir, { recursive: true });
          d.showId = h.targetShowId;
          const destName = uniqueDestName(targetDir, h.file);
          fs.writeFileSync(path.join(targetDir, destName), JSON.stringify(d, null, 2) + '\n');
          fs.unlinkSync(h.filePath);
          h.applied = `moved-to:${path.join(h.targetShowId, destName)}`;
        }
      } catch (e) {
        h.applyError = e.message;
      }
    }
    for (const h of ambiguousHits) {
      try {
        const d = JSON.parse(fs.readFileSync(h.filePath, 'utf8'));
        d.wrongProduction = true;
        d.wrongProductionReason = h.reason || 'ambiguous-production';
        if (h.signalsByCandidate) d.ambiguousProductionSignals = h.signalsByCandidate;
        fs.writeFileSync(h.filePath, JSON.stringify(d, null, 2) + '\n');
        h.applied = 'flagged-wrongProduction';
      } catch (e) {
        h.applyError = e.message;
      }
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ scanned, reroute: rerouteHits, ambiguous: ambiguousHits, reject: rejectHits }, null, 2));
  } else {
    console.log(`Sibling-title misroute audit: scanned ${scanned} files across ${dirs.length} show dirs with same-title siblings`);
    console.log(`  reroute (wrong show today): ${rerouteHits.length}`);
    for (const h of rerouteHits) {
      console.log(`    ${h.showId} -> ${h.targetShowId}  ${h.file}  (${h.reason})${h.applied ? `  [${h.applied}]` : ''}${h.applyError ? `  [ERROR: ${h.applyError}]` : ''}`);
    }
    console.log(`  ambiguous (unflagged, should be wrongProduction): ${ambiguousHits.length}`);
    for (const h of ambiguousHits) {
      console.log(`    ${h.showId}  ${h.file}  (${h.reason})${h.applied ? `  [${h.applied}]` : ''}${h.applyError ? `  [ERROR: ${h.applyError}]` : ''}`);
    }
    if (rejectHits.length) {
      console.log(`  reject (no plausible target, not auto-fixed): ${rejectHits.length}`);
      for (const h of rejectHits) console.log(`    ${h.showId}  ${h.file}  (${h.reason})`);
    }
    if (FIX) console.log(`\n✓ Applied fixes to ${rerouteHits.filter(h => h.applied).length + ambiguousHits.filter(h => h.applied).length} file(s).`);
  }

  const total = rerouteHits.length + ambiguousHits.length;
  if (STRICT && total > MAX && !FIX) {
    console.error(`\n✗ STRICT: ${total} unhandled sibling-title misroute(s) > baseline ${MAX}.`);
    process.exit(1);
  }
}

main();
