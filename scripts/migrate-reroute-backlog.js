#!/usr/bin/env node
/**
 * One-time backlog migration: rescue ~155 wrongProduction-flagged review files
 * that are in the wrong sibling production directory.
 *
 * These reviews were correctly DETECTED as wrong-production by the date guard
 * or URL-year guard, but the system only flagged + dropped them. The correct
 * sibling production is known via multiProdYearGuard + pickRerouteTarget().
 *
 * Safety classifier (8 rules) ensures we only move files where we're CONFIDENT
 * the target is correct. See audit-reroute-backlog.js for the same logic used
 * to generate the initial counts.
 *
 * Modes:
 *   node scripts/migrate-reroute-backlog.js             # dry-run: writes plan
 *   node scripts/migrate-reroute-backlog.js --execute    # runs the migration
 *   node scripts/migrate-reroute-backlog.js --verify     # post-execute checks
 *
 * Flags:
 *   --cross-market  Rescue cross-market candidates (London outlets reviewing Broadway)
 *   --limit N       Only process first N safe candidates
 *   --show SHOW_ID  Only process a single source show
 */
const fs = require('fs');
const path = require('path');
const { pickRerouteTarget, buildShowKeywordSet, findShowKeywordInText, buildMultiProdYearGuard } = require('./lib/review-guards');
const { listShowDirs } = require('./lib/list-show-dirs');
const { clearWrongProductionFlags } = require('./lib/wrong-production-clear');

const REPO_ROOT = '/Users/tompryor/Broadwayscore';
const reviewTextsDir = path.join(REPO_ROOT, 'data', 'review-texts');
const showsPath = path.join(REPO_ROOT, '.core-data-checkout', 'shows.json');
const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
const showById = new Map(showsData.shows.map(s => [s.id, s]));

const args = process.argv.slice(2);
const MODE = args.includes('--execute') ? 'execute'
  : args.includes('--verify') ? 'verify' : 'dryrun';
const CROSS_MARKET = args.includes('--cross-market');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : Infinity;
const showIdx = args.indexOf('--show');
const SHOW_FILTER = showIdx >= 0 ? args[showIdx + 1] : null;

const planSuffix = CROSS_MARKET ? '-cross-market' : '';
const PLAN_PATH = path.join(REPO_ROOT, 'data', `reroute-migration-plan${planSuffix}.json`);
const LOG_PATH = path.join(REPO_ROOT, 'data', `reroute-migration-log${planSuffix}.json`);

// Load outlet registry for isDualMarket lookups
const outletRegistryPath = path.join(REPO_ROOT, 'data', 'outlet-registry.json');
const outletRegistry = JSON.parse(fs.readFileSync(outletRegistryPath, 'utf8'));
const outletData = outletRegistry.outlets || outletRegistry;

const multiProdYearGuard = buildMultiProdYearGuard(showsData.shows);

// ─── For --cross-market: WE sibling lookup ───
function getWeSiblings(showId) {
  const show = showById.get(showId);
  if (!show) return [];
  const normTitle = show.title.toLowerCase().replace(/[^a-z0-9]/g, '');
  const prods = titleGroups[normTitle] || [];
  return prods.filter(p => p.id !== showId && p.category === 'west-end')
    .map(p => ({
      id: p.id,
      year: p.openingDate ? parseInt(p.openingDate.slice(0, 4))
        : p.previewsStartDate ? parseInt(p.previewsStartDate.slice(0, 4)) : null,
    })).filter(p => p.year);
}

// ─── Date parsing for cross-market date proximity check ───
const { parseDate: parseReviewDate } = require('./lib/date-utils');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `migrate-reroute-backlog.js — One-time backlog migration: rescue ~155 wrongProduction-flagged review files.

Usage:
  node scripts/migrate-reroute-backlog.js [options]
  node scripts/migrate-reroute-backlog.js --help, -h    print this usage and exit
`;

// --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
// ─── Build target directory (outlet, critic) index for dedup ───
function buildTargetOutletCriticIndex(targetShowId) {
  const targetDir = path.join(reviewTextsDir, targetShowId);
  const index = new Set();
  if (!fs.existsSync(targetDir)) return index;
  for (const f of fs.readdirSync(targetDir).filter(x => x.endsWith('.json'))) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(targetDir, f), 'utf8'));
      const key = `${(d.outletId || d.outlet || '').toLowerCase()}|${(d.criticName || '').toLowerCase()}`;
      if (key !== '|') index.add(key);
    } catch { /* skip unreadable files */ }
  }
  return index;
}

// ─── Safety classifier (mirrors audit-reroute-backlog.js) ───
// Returns { safe, reason, overrideTarget? }
// overrideTarget is set when --cross-market reroutes to a WE sibling instead of
// the same-market sibling that pickRerouteTarget() chose.
function classifyCandidate(showId, file, data, guard, decision) {
  // Rule 1: Must be flagged wrongProduction or wrongShow
  if (!data.wrongProduction && !data.wrongShow) return { safe: false, reason: 'not_flagged' };

  // Rule 2: Bypass flags
  if (data.wrongProductionManualClear || data.wrongProductionOverride
      || data.allowEarlyDate || data.allowLateDate) return { safe: false, reason: 'bypass_flag' };

  // Rule 4: showNotMentioned is a title-level red flag
  if (data.showNotMentioned === true) return { safe: false, reason: 'show_not_mentioned' };

  // Rule 5: Flag note must be year-based OR cross-market (when --cross-market mode)
  const note = (data.wrongProductionNote || '').toLowerCase();
  const isYearBased = /date guard|url year|publishdate|url contains year|-year|closer to sibling/.test(note);
  const isCrossMarket = /cross-market|cross market/.test(note);
  if (isCrossMarket && !CROSS_MARKET) return { safe: false, reason: 'cross_market' };
  if (!isYearBased && !isCrossMarket) return { safe: false, reason: 'non_year_flag' };

  // Rule 3: Distance to target must be <= 2
  // Deferred after Rule 5 because cross-market candidates may override the target
  // (London outlet → WE sibling with different distance)
  if (!isCrossMarket && decision.distance > 2) return { safe: false, reason: 'distance_too_far' };

  // ─── Cross-market specific routing (--cross-market mode) ───
  // London outlets reviewing Broadway shows need special handling:
  // Path A: Route to WE sibling if outlet is London and WE sibling exists + year match
  // Path B: Route to Broadway sibling only if review date is within ±90 days of opening
  if (isCrossMarket) {
    const outletId = (data.outletId || data.outlet || '').toLowerCase();
    const outletEntry = outletData[outletId];
    const outletRegion = outletEntry && outletEntry.region ? outletEntry.region : null;
    const reviewText = [data.fullText, data.wrongFullText, data.bwwExcerpt, data.dtliExcerpt,
      data.showScoreExcerpt, data.llmPullQuote].filter(Boolean).join(' ');

    if (reviewText.trim().length < 100) return { safe: false, reason: 'cross_market_no_text' };

    // Path A: London outlet → try WE sibling
    if (outletRegion === 'london') {
      const weSibs = getWeSiblings(showId);
      if (weSibs.length > 0) {
        let detectedYear = null;
        if (data.publishDate) { const m = data.publishDate.match(/(20\d\d|19\d\d)/); if (m) detectedYear = parseInt(m[0]); }
        if (!detectedYear && data.url) { const m = data.url.match(/\/(20\d\d|19\d\d)\//); if (m) detectedYear = parseInt(m[1]); }

        if (detectedYear) {
          const weDecision = pickRerouteTarget(guard.showYear, weSibs, detectedYear);
          if (weDecision.action === 'reroute' && weDecision.distance <= 2) {
            // Keyword verify against WE target
            const weTarget = showById.get(weDecision.targetShowId);
            const weKeywords = weTarget ? buildShowKeywordSet(weTarget) : new Set();
            const matched = weKeywords.size > 0 ? findShowKeywordInText(reviewText, weKeywords) : null;
            if (matched) {
              return {
                safe: true,
                overrideTarget: weDecision.targetShowId,
                overrideDistance: weDecision.distance,
              };
            }
          }
        }
      }
    }

    // Path B: Broadway sibling — only if review date within ±90 days of target opening
    const targetShow = showById.get(decision.targetShowId);
    const reviewDate = parseReviewDate(data.publishDate);
    const openingDate = targetShow && targetShow.openingDate ? new Date(targetShow.openingDate) : null;
    const previewDate = targetShow && targetShow.previewsStartDate ? new Date(targetShow.previewsStartDate) : null;
    const refDate = previewDate || openingDate;
    if (reviewDate && refDate) {
      const daysDiff = Math.round((reviewDate - refDate) / (1000 * 60 * 60 * 24));
      if (daysDiff >= -60 && daysDiff <= 180) {
        // Keyword verify against Broadway target
        const targetKeywords = targetShow ? buildShowKeywordSet(targetShow) : new Set();
        const matched = findShowKeywordInText(reviewText, targetKeywords);
        if (matched) return { safe: true };
      }
    }

    return { safe: false, reason: 'cross_market_unresolvable' };
  }

  // ──�� Standard (non-cross-market) safety checks ───

  // Rule 6: URL must not contain tokens from other (non-sibling) show titles
  const targetShow = showById.get(decision.targetShowId);
  const targetTitleSlug = targetShow
    ? targetShow.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '';
  const targetTitleWords = new Set(targetTitleSlug.split('-').filter(w => w.length >= 3));
  const allOtherSlugs = new Set();
  for (const s of showsData.shows) {
    if (s.id === decision.targetShowId || s.id === showId) continue;
    for (const w of s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-')) {
      if (w.length >= 4 && !targetTitleWords.has(w)) allOtherSlugs.add(w);
    }
  }
  const url = (data.url || '').toLowerCase();
  const trUrl = (data.theatreRecordUrl || '').toLowerCase();
  for (const w of allOtherSlugs) {
    if (url.includes(`-${w}-`) || url.includes(`/${w}/`) || url.includes(`-${w}.`)
        || trUrl.includes(`-${w}-`)) {
      return { safe: false, reason: 'url_other_title' };
    }
  }

  // Rule 7: Target show keywords should appear in review text (if text exists)
  const targetKeywordsStd = targetShow ? buildShowKeywordSet(targetShow) : new Set();
  const reviewTextStd = [data.fullText, data.wrongFullText, data.bwwExcerpt, data.dtliExcerpt,
    data.showScoreExcerpt, data.llmPullQuote].filter(Boolean).join(' ');
  if (targetKeywordsStd.size > 0 && reviewTextStd.trim().length > 100) {
    const matched = findShowKeywordInText(reviewTextStd, targetKeywordsStd);
    if (!matched) return { safe: false, reason: 'keyword_mismatch' };
  }

  // Rule 8 (BLOCKER fix): No (outlet, critic) duplicate at target
  // Deferred to call site because it requires I/O on target dir

  return { safe: true };
}

// ─── Build cross-market scan set (shows with any title sibling, any market) ───
const crossMarketScanIds = new Set();
if (CROSS_MARKET) {
  for (const [, prods] of Object.entries(titleGroups)) {
    if (prods.length < 2) continue;
    for (const show of prods) {
      crossMarketScanIds.add(show.id);
    }
  }
}

// ─── DRY-RUN MODE ───
if (MODE === 'dryrun') {
  console.log('=== DRY-RUN: Building migration plan ===\n');
  const guardedShowIds = new Set(Object.keys(multiProdYearGuard));
  // In --cross-market mode, also scan shows with cross-market siblings
  const scanIds = CROSS_MARKET
    ? new Set([...guardedShowIds, ...crossMarketScanIds])
    : guardedShowIds;
  const showDirs = listShowDirs(reviewTextsDir).filter(f => {
    if (SHOW_FILTER && f !== SHOW_FILTER) return false;
    const fp = path.join(reviewTextsDir, f);
    try {
      if (fs.lstatSync(fp).isSymbolicLink()) return false;
      return fs.statSync(fp).isDirectory() && scanIds.has(f);
    } catch { return false; }
  });

  const plan = [];
  const stats = { scanned: 0, safe: 0, unsafe: {}, collision: 0, outletCriticDupe: 0 };
  // Cache target (outlet,critic) indexes to avoid re-reading target dirs
  const targetIndexCache = new Map();

  for (const showId of showDirs) {
    const showDir = path.join(reviewTextsDir, showId);
    const guard = multiProdYearGuard[showId];
    // In cross-market mode, shows may lack same-market siblings but have WE siblings
    if (!guard && !CROSS_MARKET) continue;
    let files;
    try { files = fs.readdirSync(showDir).filter(f => f.endsWith('.json')); }
    catch { continue; }

    for (const file of files) {
      if (plan.length >= LIMIT) break;
      stats.scanned++;
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8')); }
      catch { continue; }

      // Extract year
      let detectedYear = null, yearSource = null;
      if (data.publishDate) {
        const m = data.publishDate.match(/(20\d\d|19\d\d)/);
        if (m) { detectedYear = parseInt(m[0]); yearSource = 'publishDate'; }
      }
      if (!detectedYear && data.url) {
        const m = data.url.match(/\/(20\d\d|19\d\d)\//);
        if (m) { detectedYear = parseInt(m[1]); yearSource = 'urlYear'; }
      }
      if (!detectedYear) continue;

      // For shows without same-market siblings, use a synthetic guard for cross-market routing
      const show = showById.get(showId);
      const showYear = show && show.openingDate ? parseInt(show.openingDate.slice(0, 4))
        : show && show.previewsStartDate ? parseInt(show.previewsStartDate.slice(0, 4)) : null;
      const effectiveGuard = guard || { showYear: showYear || 0, siblings: [] };

      const decision = guard
        ? pickRerouteTarget(guard.showYear, guard.siblings, detectedYear)
        : { action: 'reroute', targetShowId: null, distance: Infinity };
      // For cross-market-only shows (no guard), the classifier's Path A handles routing
      if (!guard && !CROSS_MARKET) continue;
      if (guard && decision.action !== 'reroute') continue;

      // Safety classifier
      const classification = classifyCandidate(showId, file, data, effectiveGuard, decision);
      if (!classification.safe) {
        stats.unsafe[classification.reason] = (stats.unsafe[classification.reason] || 0) + 1;
        continue;
      }

      // If classifier overrode the target (e.g., WE sibling), use that instead
      const effectiveTargetId = classification.overrideTarget || decision.targetShowId;
      if (!effectiveTargetId) continue; // No valid target resolved
      const effectiveDistance = classification.overrideDistance != null
        ? classification.overrideDistance : decision.distance;

      // Filename collision
      const targetPath = path.join(reviewTextsDir, effectiveTargetId, file);
      if (fs.existsSync(targetPath)) { stats.collision++; continue; }

      // (outlet, critic) dedup at target (BLOCKER fix from reviewer)
      if (!targetIndexCache.has(effectiveTargetId)) {
        targetIndexCache.set(effectiveTargetId, buildTargetOutletCriticIndex(effectiveTargetId));
      }
      const targetOC = targetIndexCache.get(effectiveTargetId);
      const myKey = `${(data.outletId || data.outlet || '').toLowerCase()}|${(data.criticName || '').toLowerCase()}`;
      if (myKey !== '|' && targetOC.has(myKey)) {
        stats.outletCriticDupe++;
        continue;
      }

      const targetShow = showById.get(effectiveTargetId);
      plan.push({
        sourceShowId: showId,
        targetShowId: effectiveTargetId,
        file,
        sourcePath: path.join(showDir, file),
        targetPath,
        detectedYear,
        yearSource,
        distance: effectiveDistance,
        assignedScore: data.assignedScore || null,
        outletId: data.outletId || data.outlet,
        criticName: data.criticName,
        targetOpeningDate: targetShow ? targetShow.openingDate : null,
        wrongProductionNote: data.wrongProductionNote,
      });
    }
    if (plan.length >= LIMIT) break;
  }

  // Deduplicate: same file+target from multiple source dirs → keep first (earliest source)
  const seenTargets = new Set();
  const dedupPlan = [];
  for (const p of plan) {
    const key = `${p.file}|${p.targetShowId}`;
    if (seenTargets.has(key)) { stats.collision++; continue; }
    seenTargets.add(key);
    dedupPlan.push(p);
  }
  const finalPlan = dedupPlan;

  const scored = finalPlan.filter(p => p.assignedScore >= 1 && p.assignedScore <= 100).length;
  console.log(`Scanned: ${stats.scanned}`);
  console.log(`Safe to migrate: ${finalPlan.length} (${scored} already scored)`);
  console.log(`Filename collision: ${stats.collision}`);
  console.log(`Outlet+critic dupe at target: ${stats.outletCriticDupe}`);
  console.log(`Unsafe breakdown:`, stats.unsafe);
  console.log(`\nWriting plan to ${PLAN_PATH}...`);

  fs.writeFileSync(PLAN_PATH, JSON.stringify(finalPlan, null, 2) + '\n');

  // Per-show summary
  const byTarget = {};
  for (const p of finalPlan) {
    if (!byTarget[p.targetShowId]) byTarget[p.targetShowId] = { count: 0, scored: 0 };
    byTarget[p.targetShowId].count++;
    if (p.assignedScore >= 1 && p.assignedScore <= 100) byTarget[p.targetShowId].scored++;
  }
  console.log('\nPer-target show breakdown:');
  for (const [tid, s] of Object.entries(byTarget).sort((a, b) => b[1].count - a[1].count).slice(0, 20)) {
    console.log(`  ${s.count.toString().padStart(3)} (${s.scored} scored) → ${tid}`);
  }
  if (Object.keys(byTarget).length > 20) console.log(`  ...and ${Object.keys(byTarget).length - 20} more targets`);

  console.log(`\nDry-run complete. Review ${PLAN_PATH}, then run with --execute.`);
  process.exit(0);
}

// ─── EXECUTE MODE ───
if (MODE === 'execute') {
  console.log('=== EXECUTE: Running migration ===\n');
  if (!fs.existsSync(PLAN_PATH)) {
    console.error('No plan file found. Run dry-run first.');
    process.exit(1);
  }
  const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
  console.log(`Plan has ${plan.length} moves.`);

  const log = [];
  let moved = 0, skipped = 0, failed = 0;

  for (const entry of plan) {
    const { sourcePath, targetPath, targetShowId, sourceShowId, file, distance } = entry;

    // Pre-flight: source still exists?
    if (!fs.existsSync(sourcePath)) {
      console.log(`  SKIP ${sourceShowId}/${file}: source no longer exists`);
      skipped++;
      continue;
    }
    // Pre-flight: target still free?
    if (fs.existsSync(targetPath)) {
      console.log(`  SKIP ${sourceShowId}/${file}: target now occupied`);
      skipped++;
      continue;
    }

    try {
      // Re-read fresh from disk
      const sourceData = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

      // Save full before-snapshot for rollback
      const before = JSON.parse(JSON.stringify(sourceData));

      // Apply migration transforms
      sourceData.showId = targetShowId;
      sourceData.routedFromShowId = sourceShowId;
      sourceData.routedFromNote = sourceData.wrongProductionNote || sourceData.wrongProductionReason || null;
      const migrationLabel = CROSS_MARKET ? 'cross-market rescue 2026-04-12' : 'backlog migration 2026-04-11';
      sourceData.routedReason = `${migrationLabel}: ${entry.yearSource}=${entry.detectedYear} matches sibling ${targetShowId} (distance ${distance})`;
      sourceData.routedAt = new Date().toISOString();
      clearWrongProductionFlags(sourceData, { source: 'migrate-reroute-backlog.js', reason: sourceData.routedReason });

      // Stamp allowEarlyDate for distance >= 2 to prevent the early-date guard
      // from re-flagging at the target. Distance 0-1 are close enough that
      // date guards at the target should still apply normally.
      if (distance >= 2) {
        sourceData.allowEarlyDate = true;
      }

      // Write target
      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(targetPath, JSON.stringify(sourceData, null, 2) + '\n');

      // Delete source
      fs.unlinkSync(sourcePath);

      log.push({
        sourceShowId, targetShowId, file, sourcePath, targetPath,
        before, timestamp: sourceData.routedAt,
        assignedScore: entry.assignedScore,
      });
      moved++;
      if (moved % 20 === 0) console.log(`  ... ${moved} moved`);
    } catch (e) {
      console.error(`  FAIL ${sourceShowId}/${file}: ${e.message}`);
      // Clean up target if written
      try { if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath); } catch { /* best-effort */ }
      failed++;
    }
  }

  console.log(`\nMigration complete: ${moved} moved, ${skipped} skipped, ${failed} failed.`);
  console.log(`Writing log to ${LOG_PATH}...`);
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2) + '\n');
  console.log('Done. Run with --verify to confirm, then trigger a rebuild.');
  process.exit(failed > 0 ? 1 : 0);
}

// ─── VERIFY MODE ───
if (MODE === 'verify') {
  console.log('=== VERIFY: Post-migration checks ===\n');
  if (!fs.existsSync(LOG_PATH)) {
    console.error('No log file found. Run --execute first.');
    process.exit(1);
  }
  const log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  let issues = 0;

  for (const entry of log) {
    // Check target exists
    if (!fs.existsSync(entry.targetPath)) {
      console.error(`  MISSING TARGET: ${entry.targetPath}`);
      issues++;
    }
    // Check source deleted
    if (fs.existsSync(entry.sourcePath)) {
      console.error(`  SOURCE NOT DELETED: ${entry.sourcePath}`);
      issues++;
    }
    // Check target has correct showId and no wrongProduction
    if (fs.existsSync(entry.targetPath)) {
      try {
        const d = JSON.parse(fs.readFileSync(entry.targetPath, 'utf8'));
        if (d.wrongProduction === true) {
          console.error(`  STILL FLAGGED: ${entry.targetPath}`);
          issues++;
        }
        if (d.showId !== entry.targetShowId) {
          console.error(`  WRONG SHOWID: ${entry.targetPath} has ${d.showId}, expected ${entry.targetShowId}`);
          issues++;
        }
      } catch (e) {
        console.error(`  UNREADABLE: ${entry.targetPath}: ${e.message}`);
        issues++;
      }
    }
  }

  if (issues === 0) {
    console.log(`All ${log.length} moves verified. Source files deleted, targets present and clean.`);
  } else {
    console.error(`\n${issues} issues found. Review above.`);
  }
  process.exit(issues > 0 ? 1 : 0);
}
