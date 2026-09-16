#!/usr/bin/env node
/**
 * fix-unflagged-same-url-clusters.js
 *
 * BRO-2409: repairs the class fix-circular-duplicate-pairs.js and the CI
 * duplicateOf self-heals cannot see at all — a same-(show,outlet,url)
 * cluster where NO member carries a duplicateOf/duplicateTextOf pointer to
 * another member. Every existing dedup mechanism requires an EXISTING
 * pointer to find a pair; `rebuild-reviews.yml` runs
 * audit-duplicate-of-url-mismatch.js --fix and heal-orphaned-duplicate-
 * pointers.js --fix back to back as independent pre-rebuild steps, and each
 * can legitimately clear its OWN half of an A<->B cycle with no knowledge of
 * the other's action. The result — zero pointers on either side — is
 * invisible to both of those repairs going forward, so both members
 * silently score forever (rebuild-all-reviews.js emits the article twice).
 * Confirmed live: the-winslow-boy-2013 nytimes--ben-brantley.json /
 * nytimes--charles-isherwood.json, one shared URL, neither field ever set.
 *
 * Detection + canonical choice: scripts/lib/suppression-logic.js
 * (findFullyUnsuppressedSameUrlGroups + chooseSameUrlCanonical). The
 * canonical choice reuses fix-circular-duplicate-pairs.js's
 * chooseCanonicalForRebuild — includability-first, cross-market-aware, and
 * placeholder-byline aware (card #1907) — via a pairwise fold, rather than
 * re-deriving a ranking here. Only groups where 2+ members would currently
 * be includable are repaired; a cluster where a sibling is already excluded
 * by an unrelated guard (wrongProduction, non-review, …) with no pointer at
 * all isn't this bug and is left alone.
 *
 * Usage:
 *   node scripts/fix-unflagged-same-url-clusters.js            # report (exit 1 if any)
 *   node scripts/fix-unflagged-same-url-clusters.js --json     # JSON report
 *   node scripts/fix-unflagged-same-url-clusters.js --fix      # repair in place
 *   node scripts/fix-unflagged-same-url-clusters.js --gate     # CI floor (see GATE_FLOOR)
 *   REVIEW_TEXTS_DIR=/path node scripts/... --fix              # target a clone
 *
 * Exit codes: 0 = no groups (report) / repaired (--fix) / under floor (--gate);
 *             1 = groups found (report) / spike past floor (--gate).
 */

const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');
const { isIncludableForRebuild } = require('./lib/review-guards');
const {
  chooseCanonicalForRebuild,
  showsDataAvailable,
} = require('./fix-circular-duplicate-pairs');
const { findFullyUnsuppressedSameUrlGroups, chooseSameUrlCanonical } = require('./lib/suppression-logic');
const { listShowDirs } = require('./lib/list-show-dirs');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `fix-unflagged-same-url-clusters.js — Repairs same-URL review clusters left with ZERO duplicate.

Usage:
  node scripts/fix-unflagged-same-url-clusters.js [options]
  node scripts/fix-unflagged-same-url-clusters.js --help, -h    print this usage and exit
`;
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const JSON_OUT = args.includes('--json');
const GATE = args.includes('--gate');

// Mirrors fix-circular-duplicate-pairs.js's GATE_FLOOR reasoning: the write-time
// guard prevents NEW cycles, and this class only forms via two independent
// self-heals racing each other on pre-existing legacy state — steady state is a
// handful per day, not a flood. A spike means a producer regression (e.g. one of
// the two self-heals clearing pointers far more aggressively than intended).
const GATE_FLOOR = 10;

// Buckets under review-texts/ this audit must not scan or mutate — mirrors
// audit-duplicate-of-url-mismatch.js's NON_SHOW_DIRS. `_superseded-
// misattributed` is a TOMBSTONE dir: its entries are frozen historical
// records of a past misattribution, not live scoring candidates, and --fix
// stamping a fresh duplicateOf onto one would rewrite a record that is
// supposed to stay exactly as archived.
const NON_SHOW_DIRS = new Set(['_pending', '_superseded-misattributed']);

function walkShowDirs(root) {
  if (!fs.existsSync(root)) return [];
  // listShowDirs (not a plain readdirSync+isDirectory filter): tolerates a
  // dangling symlink per-entry (warns + skips) instead of throwing and
  // crashing the whole run — the 2026-05-27 stray-symlink incident this
  // helper exists to prevent (scripts/lib/list-show-dirs.js).
  return listShowDirs(root).filter((name) => !NON_SHOW_DIRS.has(name) && !name.startsWith('.'));
}

function loadShowRecords(showDir) {
  let files;
  try { files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json'); }
  catch { return []; }
  const records = [];
  for (const file of files) {
    try { records.push({ file, data: JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf-8')) }); }
    catch { /* unreadable — skip, matches other audits' behavior */ }
  }
  return records;
}

let _showByIdCache;
function showById(id) {
  if (_showByIdCache === undefined) {
    _showByIdCache = new Map();
    const candidates = process.env.SHOWS_JSON
      ? [process.env.SHOWS_JSON]
      : [path.join(__dirname, '..', 'data', 'shows.json')];
    for (const p of candidates) {
      try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const shows = Array.isArray(raw) ? raw : (raw.shows || []);
        for (const s of shows) if (s && s.id) _showByIdCache.set(s.id, s);
        if (_showByIdCache.size) break;
      } catch { /* try next candidate */ }
    }
  }
  return _showByIdCache.get(id);
}

/**
 * Find every fully-unsuppressed same-URL group, corpus-wide, that is actually
 * repairable: 2+ members are currently includable (so the double-count is
 * real) and the canonical choice isn't skip-worthy (both cross-market
 * contaminated).
 *
 * @returns {{results: Array, scanned: number}} scanned is the total review
 *   file count examined — 0 means review-texts is missing/empty (a failed
 *   checkout, a worktree without the private clone), which --gate must
 *   refuse to treat as "0 issues found" (see assertCorpusScanned in main()).
 */
function audit() {
  const results = [];
  let scanned = 0;
  for (const showId of walkShowDirs(REVIEW_TEXTS_DIR)) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const records = loadShowRecords(showDir);
    scanned += records.length;
    if (records.length < 2) continue;
    const groups = findFullyUnsuppressedSameUrlGroups(records);
    for (const group of groups) {
      const includableCount = group.members.filter((m) => {
        try { return !!isIncludableForRebuild(m.data, showById(showId), path.join(showDir, m.file)); }
        catch { return false; }
      }).length;
      if (includableCount < 2) continue; // not actually double-counting today
      const chooseFn = (aName, aData, bName, bData) => chooseCanonicalForRebuild(aName, aData, bName, bData, showDir);
      const verdict = chooseSameUrlCanonical(group.members, chooseFn);
      if (verdict.skip) {
        if (!JSON_OUT) {
          console.error(`  skip (cross-market class-A): ${showId} — ${group.members.map((m) => m.file).join(', ')} left unsuppressed`);
        }
        continue;
      }
      results.push({
        showId,
        outlet: group.outlet,
        url: group.url,
        canonical: verdict.canonical,
        losers: verdict.losers,
        reason: verdict.reason,
      });
    }
  }
  return { results, scanned };
}

function fix(groups) {
  let clearedGroups = 0, repointedLosers = 0;
  const day = new Date().toISOString().slice(0, 10);
  for (const g of groups) {
    const dir = path.join(REVIEW_TEXTS_DIR, g.showId);
    for (const loserFile of g.losers) {
      const loserPath = path.join(dir, loserFile);
      const loser = JSON.parse(fs.readFileSync(loserPath, 'utf-8'));
      loser.duplicateOf = g.canonical;
      loser.duplicateReason =
        `fix-unflagged-same-url-clusters.js on ${day}: same URL as canonical ${g.canonical}, neither carried a duplicate pointer (${g.reason})`;
      loser.duplicateClearReason = null;
      // force:true — canonical and loser share this URL, so a non-forced write
      // would immediately re-trip review-write-guard's URL-collision detector
      // and mark the CANONICAL as the duplicate instead (fix-circular-duplicate-
      // pairs.js's fix() uses the identical override for the identical reason).
      safeWriteReview(loserPath, loser, { force: true });
      repointedLosers++;
    }
    clearedGroups++;
  }
  return { clearedGroups, repointedLosers };
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const { results: groups, scanned } = audit();

  // A missing/empty review-texts checkout scans 0 files and audit() then
  // vacuously returns 0 groups — indistinguishable from a genuinely clean
  // corpus unless something checks scanned > 0. Report/--fix modes still see
  // it (an empty "OK" or "no groups" output is a visible signal to a human
  // running this locally); --gate must FAIL LOUD instead of silently passing.
  try {
    assertCorpusScanned(scanned, { gate: GATE });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`\nFAIL: ${e.message}`);
    process.exit(1);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ count: groups.length, groups }, null, 2));
    process.exit(groups.length === 0 ? 0 : 1);
  }
  if (groups.length === 0) {
    console.log('OK: no fully-unsuppressed same-URL clusters found');
    process.exit(0);
  }
  console.log(`Found ${groups.length} fully-unsuppressed same-URL cluster(s):\n`);
  for (const g of groups) {
    console.log(`  ${g.showId} :: ${g.outlet} :: ${g.url}`);
    console.log(`    canonical: ${g.canonical}  (${g.reason})`);
    for (const loser of g.losers) console.log(`    loser:     ${loser}  -> duplicateOf ${g.canonical}`);
  }
  if (FIX) {
    // Same fail-closed rationale as fix-circular-duplicate-pairs.js --fix: the
    // cross-market class-A guard inside chooseCanonicalForRebuild is inert
    // without shows.json, and repairing blind risks canonicalizing a wrong-show
    // review.
    if (!showsDataAvailable()) {
      console.error('\n❌ REFUSING --fix: shows.json (core-data) could not be loaded, so the cross-market class-A canonical guard is inert. Check out core-data (shows.json) and retry.');
      process.exit(1);
    }
    const r = fix(groups);
    console.log(`\nRepaired ${r.clearedGroups} cluster(s); repointed ${r.repointedLosers} loser(s).`);
    console.log('Re-run the rebuild to collapse each cluster to its canonical.');
    process.exit(0);
  }
  if (GATE) {
    if (groups.length > GATE_FLOOR) {
      console.error(`\n❌ GATE: ${groups.length} fully-unsuppressed same-URL cluster(s) > floor ${GATE_FLOOR}. A spike this large signals one of the two independent duplicateOf self-heals clearing pointers too aggressively — investigate before running --fix.`);
      process.exit(1);
    }
    console.log(`\n✅ GATE: ${groups.length} cluster(s) ≤ floor ${GATE_FLOOR}. Not blocking the trunk.`);
    process.exit(0);
  }
  console.log('\nRun with --fix to repair.');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { audit, fix, walkShowDirs, loadShowRecords };
