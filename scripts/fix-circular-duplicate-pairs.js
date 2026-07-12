#!/usr/bin/env node
/**
 * fix-circular-duplicate-pairs.js
 *
 * Repairs the circular-duplicateOf class: fileA.duplicateOf=fileB AND
 * fileB.duplicateOf=fileA in the same show dir. A 2-cycle makes the rebuild
 * exclude BOTH files (each is "a duplicate of the other"), so the review
 * vanishes from the site with no alarm. A repo-wide sweep on 2026-07-11 found
 * 242 such pairs (~150 shows) — including open shows (proof-2026 ×8,
 * war-horse-west-end-2026 ×7, cats-the-jellicle-ball-2026 ×7).
 *
 * Typical shape: a real-byline file + a scraper-invented "unknown"/misspelled
 * sibling for the SAME url, cross-marked at write time by review-write-guard's
 * URL-collision detector (duplicateReason "url-collision-detected-at-write").
 * Root cause: the write-guard auto-clears SELF-referential duplicateOf but had
 * no A↔B cycle detection (now added — see review-write-guard.js
 * wouldFormDuplicateCycle).
 *
 * Repair: pick ONE canonical per pair, clear ONLY the canonical's
 * duplicateOf + duplicateReason (and stamp duplicateClearReason — the
 * push-restore breadcrumb exception, review-write-guard.js:251, without which
 * the CI push action reverts the clear). The loser keeps pointing at the
 * canonical (already true in a 2-cycle); if it points elsewhere we repoint it.
 *
 * Canonical choice — INCLUDABILITY-FIRST (chooseCanonicalForRebuild):
 *   0. REBUILD TRUTH — if, with duplicateOf cleared, exactly ONE member would be
 *      includable-for-rebuild (isIncludableForRebuild + scoreable), that member
 *      is canonical. This is dominant and non-negotiable: it is the ONLY choice
 *      that never removes a currently-live review. A pure byline-first rule
 *      regresses 21/242 pairs because scraper-invented "named" bylines
 *      (paul-raven, sarah-crompton, nick-curtis — recurring across unrelated
 *      shows as wrongProduction junk) are NOT includable, so preferring them
 *      kills the real live "unknown" review. Measured on the 2026-07-11 corpus:
 *      includability-first → 0 regressions, +13 recovered, 52 double-counts
 *      collapsed; byline-first → 21 regressions.
 *   When both-or-neither member would be live, fall back to chooseCanonical:
 *   1. BYLINE — a named human beats "unknown"/staff/outlet-name/empty, and a
 *      correctly-spelled byline beats a near-misspelling sibling (Levenshtein ≤ 2).
 *   2. SCORE RICHNESS — more score signals (llm/assigned/human/…) wins.
 *   3. AGE — older publishDate wins.
 *   4. Filename — deterministic final tiebreak.
 *
 * NOTE: the rebuild already has circular-duplicate recovery (review-guards.js
 * BUG F, 2026-05-27) that surfaces one side of MOST pairs — so the true corpus
 * shape is NOT "242 suppressed reviews" but ~52 DOUBLE-COUNTED (both sides live
 * with the same url — distorting composite scores), ~68 wrongProduction/stub
 * noise correctly excluded, ~122 already single-live, and ~13 genuinely
 * suppressed. This repair collapses every pair to exactly one canonical: it
 * de-duplicates the 52, recovers the 13, and leaves the rest correct.
 *
 * CRITICAL: these pairs share an IDENTICAL url, so a plain safeWriteReview()
 * would re-fire the URL-collision detector and immediately re-mark the cleared
 * canonical as a duplicate. The canonical MUST be written with force:true to
 * bypass that block. LOAD-MODIFY-SAVE the full object — never copy one file's
 * fields onto another (a copy-over destroyed ensemble scores on JCS 2026-07-11).
 *
 * Usage:
 *   node scripts/fix-circular-duplicate-pairs.js            # report (exit 1 if any)
 *   node scripts/fix-circular-duplicate-pairs.js --json     # JSON report
 *   node scripts/fix-circular-duplicate-pairs.js --fix      # repair in place
 *   REVIEW_TEXTS_DIR=/path node scripts/... --fix           # target a clone
 *
 * Exit codes: 0 = no pairs (report) / repaired (--fix); 1 = pairs found (report).
 */

const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');
const { isIncludableForRebuild } = require('./lib/review-guards');

const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const JSON_OUT = args.includes('--json');
const GATE = args.includes('--gate');

// CI floor: the write-guard now refuses to form new 2-cycles (review-write-guard.js
// wouldFormDuplicateCycle), so steady state is 0. But review-texts is a separate
// private repo that data bots mutate every ~2min, and a legacy pointer can appear
// in the window before the daily self-heal (fix-circular-duplicate-pairs.yml --fix)
// clears it. Mirroring audit-duplicate-of-url-mismatch.js's --gate: single-pair
// drift is auto-healable and must NOT red an unrelated code push; only a SPIKE
// (producer regression re-forming cycles at scale) blocks the trunk.
const GATE_FLOOR = 10;

// Bylines that carry no human identity — an "unknown" for canonical-choice
// purposes. Kept lowercase; compared against the slug after `outlet--`.
const UNKNOWN_SLUGS = new Set([
  'unknown', 'staff', 'editor', 'editors', 'news-desk', 'newsdesk',
  'bww-news-desk', 'admin', 'contributor', 'guest', 'anonymous', 'team',
]);

/** The byline slug from a review filename: `outlet--first-last.json` -> `first-last`. */
function bylineSlug(name) {
  const base = name.replace(/\.json$/i, '');
  const idx = base.indexOf('--');
  return idx === -1 ? '' : base.slice(idx + 2);
}

/** The outlet slug from a review filename: `outlet--first-last.json` -> `outlet`. */
function outletSlug(name) {
  const base = name.replace(/\.json$/i, '');
  const idx = base.indexOf('--');
  return idx === -1 ? base : base.slice(0, idx);
}

/**
 * True when a byline slug carries no human identity: empty, a known
 * placeholder, purely numeric, or identical to the outlet name
 * (broadwayworld--broadwayworld).
 */
function isUnknownByline(slug, outlet) {
  if (!slug) return true;
  const s = slug.toLowerCase();
  if (UNKNOWN_SLUGS.has(s)) return true;
  if (/^\d+$/.test(s)) return true;
  if (outlet && s === outlet.toLowerCase()) return true;
  return false;
}

/** Classic Levenshtein edit distance (small strings; iterative DP). */
function levenshtein(a, b) {
  a = a || ''; b = b || '';
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    let cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/** Count the distinct score signals present on a review record. */
function scoreSignals(d) {
  if (!d) return [];
  const sig = [];
  if (d.assignedScore != null) sig.push('assignedScore');
  if (d.llmScore) sig.push('llmScore');
  if (d.humanReviewScore != null) sig.push('humanReviewScore');
  if (d.adjudicatedScore != null) sig.push('adjudicatedScore');
  if (d.originalScore != null) sig.push('originalScore');
  if (d.aggregatorStars != null) sig.push('aggregatorStars');
  return sig;
}

/** A record is "scoreable" (recovery-relevant) if it carries any score signal. */
function isScoreable(d) {
  return scoreSignals(d).length > 0;
}

/** Parse a publishDate/parsedDate into a comparable epoch, or +Infinity if absent/unparseable. */
function dateEpoch(d) {
  const raw = d && (d.publishDate || d.parsedDate);
  if (!raw) return Infinity;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : Infinity;
}

/**
 * Choose the canonical member of a mutual duplicateOf pair. PURE — no I/O.
 * Returns { canonical, loser, reason } where canonical/loser are filenames.
 *
 * @param {string} aName filename A
 * @param {object} aData parsed record A
 * @param {string} bName filename B
 * @param {object} bData parsed record B
 */
function chooseCanonical(aName, aData, bName, bData) {
  const aScoreable = isScoreable(aData);
  const bScoreable = isScoreable(bData);

  // 1. Recovery guard: an unscoreable canonical recovers nothing.
  if (aScoreable && !bScoreable) return pick(aName, bName, 'recovery: only this member is scoreable');
  if (bScoreable && !aScoreable) return pick(bName, aName, 'recovery: only this member is scoreable');

  // 2. Byline quality.
  const aOutlet = outletSlug(aName), bOutlet = outletSlug(bName);
  const aSlug = bylineSlug(aName), bSlug = bylineSlug(bName);
  const aUnknown = isUnknownByline(aSlug, aOutlet);
  const bUnknown = isUnknownByline(bSlug, bOutlet);
  if (!aUnknown && bUnknown) return pick(aName, bName, 'byline: named human beats unknown/placeholder');
  if (!bUnknown && aUnknown) return pick(bName, aName, 'byline: named human beats unknown/placeholder');

  // 2b. Both named: a near-misspelling of the sibling loses to the correct
  // spelling. We can't consult a dictionary, so the more-substantive spelling
  // (richer score, else longer, else older) is treated as correct. Only engages
  // when the two slugs are close (edit distance ≤ 2) — genuinely different
  // critics on one URL fall through to the score/age tiebreak below.
  if (!aUnknown && !bUnknown && aSlug !== bSlug && levenshtein(aSlug, bSlug) <= 2) {
    const aRich = scoreSignals(aData).length, bRich = scoreSignals(bData).length;
    if (aRich !== bRich) {
      return aRich > bRich
        ? pick(aName, bName, 'byline: near-misspelling sibling, richer-scored spelling wins')
        : pick(bName, aName, 'byline: near-misspelling sibling, richer-scored spelling wins');
    }
    if (aSlug.length !== bSlug.length) {
      return aSlug.length > bSlug.length
        ? pick(aName, bName, 'byline: near-misspelling sibling, longer spelling wins')
        : pick(bName, aName, 'byline: near-misspelling sibling, longer spelling wins');
    }
  }

  // 3. Score richness.
  const aRich = scoreSignals(aData).length, bRich = scoreSignals(bData).length;
  if (aRich !== bRich) {
    return aRich > bRich
      ? pick(aName, bName, 'score: richer score signal')
      : pick(bName, aName, 'score: richer score signal');
  }

  // 4. Age — older wins.
  const aEpoch = dateEpoch(aData), bEpoch = dateEpoch(bData);
  if (aEpoch !== bEpoch) {
    return aEpoch < bEpoch
      ? pick(aName, bName, 'age: older publishDate')
      : pick(bName, aName, 'age: older publishDate');
  }

  // 5. Deterministic filename tiebreak.
  return aName < bName
    ? pick(aName, bName, 'tiebreak: filename order')
    : pick(bName, aName, 'tiebreak: filename order');
}

function pick(canonical, loser, reason) {
  return { canonical, loser, reason };
}

// Show lookup by id, memoized. The rebuild passes showById[showId] to
// isIncludableForRebuild (scripts/rebuild-all-reviews.js ~1870); the show-aware
// guards (wrongShow stale-recovery review-guards.js:2389, revival/date checks)
// diverge when show is undefined, so passing it keeps this sim faithful to the
// real keep-side (ship-check Codex finding, 2026-07-12). Best-effort: falls back
// to undefined (prior behavior) when shows.json can't be located — the script
// then still runs, just without show-context fidelity.
let _showByIdCache; // undefined = not loaded; Map (possibly empty) once attempted
function _showById(showId) {
  if (_showByIdCache === undefined) {
    _showByIdCache = new Map();
    const candidates = [
      process.env.SHOWS_JSON,
      path.join(__dirname, '..', 'data', 'shows.json'),
    ].filter(Boolean);
    for (const p of candidates) {
      try {
        const arr = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const shows = Array.isArray(arr) ? arr : (arr.shows || []);
        for (const s of shows) if (s && s.id) _showByIdCache.set(s.id, s);
        if (_showByIdCache.size) break;
      } catch { /* try next candidate */ }
    }
  }
  return _showByIdCache.get(showId);
}

/**
 * Would this record be includable-for-rebuild if its duplicateOf were cleared?
 * This is the rebuild's KEEP predicate — deliberately NOT gated on a score.
 * isIncludableForRebuild does not require a score (a body-bearing, unflagged,
 * not-yet-scored review still passes), so gating on isScoreable here would
 * mislabel an includable-but-unscored review (e.g. a fresh opening-night review
 * between ingest and scoring) as "not live" and let the byline tiebreak demote
 * it under scored-but-not-includable junk — the exact regression this design
 * prevents (ship-check 2026-07-12, 2nd-reviewer P1). Score is applied only as a
 * SUB-tiebreak among includables in chooseCanonicalForRebuild.
 *
 * I/O: reads sibling files (isIncludableForRebuild resolves duplicate pointers)
 * and passes the show object so show-aware guards match the rebuild.
 */
function wouldBeIncludableIfCleared(data, filePath) {
  const sim = { ...data, duplicateOf: null, duplicateReason: null, duplicateClearReason: 'sim' };
  const showId = path.basename(path.dirname(filePath));
  try {
    return !!isIncludableForRebuild(sim, _showById(showId), filePath);
  } catch {
    return false;
  }
}

/**
 * Includability-first canonical choice (see module header). I/O-bound; the pure
 * chooseCanonical is the tiebreak when the rebuild-truth layer can't decide.
 *
 * @param {string} aName @param {object} aData
 * @param {string} bName @param {object} bData
 * @param {string} showDir absolute path to the show directory
 */
function chooseCanonicalForRebuild(aName, aData, bName, bData, showDir) {
  const aIncl = wouldBeIncludableIfCleared(aData, path.join(showDir, aName));
  const bIncl = wouldBeIncludableIfCleared(bData, path.join(showDir, bName));
  // Dominant: never demote the only member the rebuild would keep.
  if (aIncl && !bIncl) return pick(aName, bName, 'rebuild: only this member is includable after clear');
  if (bIncl && !aIncl) return pick(bName, aName, 'rebuild: only this member is includable after clear');
  // Both includable (double-count) — prefer the scored one so the surviving
  // review carries a composite-affecting score; only then fall to byline/age.
  if (aIncl && bIncl) {
    const aS = isScoreable(aData), bS = isScoreable(bData);
    if (aS && !bS) return pick(aName, bName, 'rebuild: both includable, only this one scored');
    if (bS && !aS) return pick(bName, aName, 'rebuild: both includable, only this one scored');
  }
  // Both includable+scored (or neither includable — cosmetic) → pure rule.
  return chooseCanonical(aName, aData, bName, bData);
}

function walkShowDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== '_pending')
    .map(e => path.join(root, e.name));
}

/** Find all mutual duplicateOf pairs. Returns [{showId, canonical, loser, reason, ...}]. */
function audit() {
  const results = [];
  for (const showDir of walkShowDirs(REVIEW_TEXTS_DIR)) {
    let files;
    try { files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json'); }
    catch { continue; }
    const cache = {};
    const load = (name) => {
      if (name in cache) return cache[name];
      try { cache[name] = JSON.parse(fs.readFileSync(path.join(showDir, name), 'utf-8')); }
      catch { cache[name] = null; }
      return cache[name];
    };
    const seen = new Set();
    for (const file of files) {
      const d = load(file);
      if (!d || typeof d.duplicateOf !== 'string' || !d.duplicateOf.endsWith('.json')) continue;
      const sibName = d.duplicateOf;
      if (sibName === file) continue; // self-ref: handled by audit-duplicate-of-url-mismatch
      const sd = load(sibName);
      if (!sd || sd.duplicateOf !== file) continue; // not mutual
      const key = [file, sibName].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const choice = chooseCanonicalForRebuild(file, d, sibName, sd, showDir);
      results.push({
        showId: path.basename(showDir),
        canonical: choice.canonical,
        loser: choice.loser,
        reason: choice.reason,
        url: d.url || sd.url || null,
      });
    }
  }
  return results;
}

function fix(pairs) {
  let clearedCanonicals = 0, repointedLosers = 0;
  const day = new Date().toISOString().slice(0, 10);
  for (const p of pairs) {
    const dir = path.join(REVIEW_TEXTS_DIR, p.showId);
    const canonPath = path.join(dir, p.canonical);
    const loserPath = path.join(dir, p.loser);

    // --- Canonical: clear its duplicateOf. LOAD-MODIFY-SAVE the full object. ---
    const canon = JSON.parse(fs.readFileSync(canonPath, 'utf-8'));
    canon.duplicateClearReason =
      `fix-circular-duplicate-pairs.js on ${day}: canonical of mutual pair with ${p.loser} (${p.reason})`;
    canon.duplicateOf = null;
    canon.duplicateReason = null;
    // force:true — the loser shares this file's url, so a non-forced write would
    // re-fire review-write-guard's URL-collision detector and re-mark us dup.
    safeWriteReview(canonPath, canon, { force: true });
    clearedCanonicals++;

    // --- Loser: must point at the canonical. In a pure 2-cycle it already does
    // (that's what made the pair mutual), so this is a defensive repoint only. ---
    const loser = JSON.parse(fs.readFileSync(loserPath, 'utf-8'));
    if (loser.duplicateOf !== p.canonical) {
      const wasPointingAt = loser.duplicateOf;
      loser.duplicateOf = p.canonical;
      loser.duplicateReason =
        `repointed by fix-circular-duplicate-pairs.js on ${day}: was ${JSON.stringify(wasPointingAt)}, now points at canonical ${p.canonical}`;
      // Clear any stale clear-breadcrumb — this file is a live duplicate.
      loser.duplicateClearReason = null;
      safeWriteReview(loserPath, loser, { force: true });
      repointedLosers++;
    }
  }
  return { clearedCanonicals, repointedLosers };
}

function main() {
  const pairs = audit();
  if (JSON_OUT) {
    console.log(JSON.stringify({ count: pairs.length, pairs }, null, 2));
    process.exit(pairs.length === 0 ? 0 : 1);
  }
  if (pairs.length === 0) {
    console.log('OK: no circular (mutual) duplicateOf pairs found');
    process.exit(0);
  }
  console.log(`Found ${pairs.length} circular duplicateOf pair(s):\n`);
  for (const p of pairs) {
    console.log(`  ${p.showId}`);
    console.log(`    canonical: ${p.canonical}  (${p.reason})`);
    console.log(`    loser:     ${p.loser}  → stays duplicateOf ${p.canonical}`);
  }
  if (FIX) {
    const r = fix(pairs);
    console.log(`\nCleared ${r.clearedCanonicals} canonical(s); repointed ${r.repointedLosers} loser(s).`);
    console.log('Re-run the rebuild to collapse each pair to its canonical.');
    process.exit(0);
  }
  if (GATE) {
    if (pairs.length > GATE_FLOOR) {
      console.error(`\n❌ GATE: ${pairs.length} circular duplicateOf pair(s) > floor ${GATE_FLOOR}. A spike this large signals a producer regression re-forming 2-cycles at scale — failing the trunk before the double-counts distort composite scores. Investigate, then run --fix.`);
      process.exit(1);
    }
    console.log(`\n✅ GATE: ${pairs.length} circular pair(s) ≤ floor ${GATE_FLOOR}. Auto-healable churn — fix-circular-duplicate-pairs.yml --fix clears these; not blocking the trunk.`);
    process.exit(0);
  }
  console.log('\nRun with --fix to repair.');
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  bylineSlug, outletSlug, isUnknownByline, levenshtein, scoreSignals,
  isScoreable, chooseCanonical, chooseCanonicalForRebuild, wouldBeIncludableIfCleared,
  audit, fix,
};
