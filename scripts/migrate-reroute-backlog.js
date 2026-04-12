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
 *   --limit N      Only process first N safe candidates
 *   --show SHOW_ID Only process a single source show
 */
const fs = require('fs');
const path = require('path');
const { pickRerouteTarget, buildShowKeywordSet, findShowKeywordInText } = require('./lib/review-guards');

const REPO_ROOT = '/Users/tompryor/Broadwayscore';
const reviewTextsDir = path.join(REPO_ROOT, 'data', 'review-texts');
const showsPath = path.join(REPO_ROOT, '.core-data-checkout', 'shows.json');
const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
const showById = new Map(showsData.shows.map(s => [s.id, s]));

const PLAN_PATH = path.join(REPO_ROOT, 'data', 'reroute-migration-plan.json');
const LOG_PATH = path.join(REPO_ROOT, 'data', 'reroute-migration-log.json');

const args = process.argv.slice(2);
const MODE = args.includes('--execute') ? 'execute'
  : args.includes('--verify') ? 'verify' : 'dryrun';
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : Infinity;
const showIdx = args.indexOf('--show');
const SHOW_FILTER = showIdx >= 0 ? args[showIdx + 1] : null;

// ─── Build multiProdYearGuard identically to rebuild-all-reviews.js ───
const multiProdYearGuard = {};
{
  const titleGroups = {};
  for (const s of showsData.shows) {
    const normTitle = s.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!titleGroups[normTitle]) titleGroups[normTitle] = [];
    titleGroups[normTitle].push(s);
  }
  for (const [, prods] of Object.entries(titleGroups)) {
    if (prods.length < 2) continue;
    for (const show of prods) {
      const showYear = show.openingDate ? parseInt(show.openingDate.slice(0, 4))
        : show.previewsStartDate ? parseInt(show.previewsStartDate.slice(0, 4)) : null;
      if (!showYear) continue;
      const showCat = show.category || 'broadway';
      const nycMarket = showCat === 'broadway' || showCat === 'off-broadway';
      const siblings = prods.filter(p => {
        if (p.id === show.id) return false;
        const pCat = p.category || 'broadway';
        if (nycMarket) return pCat === 'broadway' || pCat === 'off-broadway';
        return pCat === showCat;
      }).map(p => ({
        id: p.id,
        year: p.openingDate ? parseInt(p.openingDate.slice(0, 4)) : null,
      })).filter(p => p.year);
      if (siblings.length > 0) multiProdYearGuard[show.id] = { showYear, siblings };
    }
  }
}

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
function classifyCandidate(showId, file, data, guard, decision) {
  // Rule 1: Must be flagged wrongProduction or wrongShow
  if (!data.wrongProduction && !data.wrongShow) return { safe: false, reason: 'not_flagged' };

  // Rule 2: Bypass flags
  if (data.wrongProductionManualClear || data.wrongProductionOverride
      || data.allowEarlyDate || data.allowLateDate) return { safe: false, reason: 'bypass_flag' };

  // Rule 3: Distance to target must be <= 2
  if (decision.distance > 2) return { safe: false, reason: 'distance_too_far' };

  // Rule 4: showNotMentioned is a title-level red flag
  if (data.showNotMentioned === true) return { safe: false, reason: 'show_not_mentioned' };

  // Rule 5: Flag note must be year-based, not cross-market or other
  const note = (data.wrongProductionNote || '').toLowerCase();
  const isYearBased = /date guard|url year|publishdate|url contains year|-year|closer to sibling/.test(note);
  if (/cross-market|cross market/.test(note)) return { safe: false, reason: 'cross_market' };
  if (!isYearBased) return { safe: false, reason: 'non_year_flag' };

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
  const targetKeywords = targetShow ? buildShowKeywordSet(targetShow) : new Set();
  const reviewText = [data.fullText, data.wrongFullText, data.bwwExcerpt, data.dtliExcerpt,
    data.showScoreExcerpt, data.llmPullQuote].filter(Boolean).join(' ');
  if (targetKeywords.size > 0 && reviewText.trim().length > 100) {
    const matched = findShowKeywordInText(reviewText, targetKeywords);
    if (!matched) return { safe: false, reason: 'keyword_mismatch' };
  }

  // Rule 8 (BLOCKER fix): No (outlet, critic) duplicate at target
  // Deferred to call site because it requires I/O on target dir

  return { safe: true };
}

// ─── DRY-RUN MODE ───
if (MODE === 'dryrun') {
  console.log('=== DRY-RUN: Building migration plan ===\n');
  const guardedShowIds = new Set(Object.keys(multiProdYearGuard));
  const showDirs = fs.readdirSync(reviewTextsDir).filter(f => {
    if (SHOW_FILTER && f !== SHOW_FILTER) return false;
    const fp = path.join(reviewTextsDir, f);
    try {
      if (fs.lstatSync(fp).isSymbolicLink()) return false;
      return fs.statSync(fp).isDirectory() && guardedShowIds.has(f);
    } catch { return false; }
  });

  const plan = [];
  const stats = { scanned: 0, safe: 0, unsafe: {}, collision: 0, outletCriticDupe: 0 };
  // Cache target (outlet,critic) indexes to avoid re-reading target dirs
  const targetIndexCache = new Map();

  for (const showId of showDirs) {
    const showDir = path.join(reviewTextsDir, showId);
    const guard = multiProdYearGuard[showId];
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

      const decision = pickRerouteTarget(guard.showYear, guard.siblings, detectedYear);
      if (decision.action !== 'reroute') continue;

      // Safety classifier
      const classification = classifyCandidate(showId, file, data, guard, decision);
      if (!classification.safe) {
        stats.unsafe[classification.reason] = (stats.unsafe[classification.reason] || 0) + 1;
        continue;
      }

      // Filename collision
      const targetPath = path.join(reviewTextsDir, decision.targetShowId, file);
      if (fs.existsSync(targetPath)) { stats.collision++; continue; }

      // (outlet, critic) dedup at target (BLOCKER fix from reviewer)
      if (!targetIndexCache.has(decision.targetShowId)) {
        targetIndexCache.set(decision.targetShowId, buildTargetOutletCriticIndex(decision.targetShowId));
      }
      const targetOC = targetIndexCache.get(decision.targetShowId);
      const myKey = `${(data.outletId || data.outlet || '').toLowerCase()}|${(data.criticName || '').toLowerCase()}`;
      if (myKey !== '|' && targetOC.has(myKey)) {
        stats.outletCriticDupe++;
        continue;
      }

      const targetShow = showById.get(decision.targetShowId);
      plan.push({
        sourceShowId: showId,
        targetShowId: decision.targetShowId,
        file,
        sourcePath: path.join(showDir, file),
        targetPath,
        detectedYear,
        yearSource,
        distance: decision.distance,
        assignedScore: data.assignedScore || null,
        outletId: data.outletId || data.outlet,
        criticName: data.criticName,
        targetOpeningDate: targetShow ? targetShow.openingDate : null,
        wrongProductionNote: data.wrongProductionNote,
      });
    }
    if (plan.length >= LIMIT) break;
  }

  const scored = plan.filter(p => p.assignedScore >= 1 && p.assignedScore <= 100).length;
  console.log(`Scanned: ${stats.scanned}`);
  console.log(`Safe to migrate: ${plan.length} (${scored} already scored)`);
  console.log(`Filename collision: ${stats.collision}`);
  console.log(`Outlet+critic dupe at target: ${stats.outletCriticDupe}`);
  console.log(`Unsafe breakdown:`, stats.unsafe);
  console.log(`\nWriting plan to ${PLAN_PATH}...`);

  fs.writeFileSync(PLAN_PATH, JSON.stringify(plan, null, 2) + '\n');

  // Per-show summary
  const byTarget = {};
  for (const p of plan) {
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
      sourceData.routedFromNote = sourceData.wrongProductionNote || null;
      sourceData.routedReason = `backlog migration 2026-04-11: ${entry.yearSource}=${entry.detectedYear} matches sibling ${targetShowId} (distance ${distance})`;
      sourceData.routedAt = new Date().toISOString();
      delete sourceData.wrongProduction;
      delete sourceData.wrongProductionNote;

      // Reviewer warning #2: stamp allowEarlyDate for distance > 0 to prevent
      // the early-date guard from re-flagging at the target
      if (distance > 0) {
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
