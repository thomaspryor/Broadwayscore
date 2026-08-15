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
        let alreadyAtTarget = false;
        if (fs.existsSync(targetDir)) {
          for (const tf of fs.readdirSync(targetDir).filter(x => x.endsWith('.json'))) {
            try {
              const td = JSON.parse(fs.readFileSync(path.join(targetDir, tf), 'utf8'));
              const tUrl = td.url ? String(td.url).toLowerCase().replace(/[#?].*$/, '').replace(/\/+$/, '') : null;
              if (tUrl && tUrl === normUrl) { alreadyAtTarget = true; break; }
            } catch { /* skip unreadable */ }
          }
        }
        if (alreadyAtTarget) {
          fs.unlinkSync(h.filePath);
          h.applied = 'deleted-duplicate';
        } else {
          fs.mkdirSync(targetDir, { recursive: true });
          d.showId = h.targetShowId;
          let destName = h.file;
          let destPath = path.join(targetDir, destName);
          if (fs.existsSync(destPath)) {
            destName = destName.replace(/\.json$/, `-rerouted.json`);
            destPath = path.join(targetDir, destName);
          }
          fs.writeFileSync(destPath, JSON.stringify(d, null, 2) + '\n');
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
