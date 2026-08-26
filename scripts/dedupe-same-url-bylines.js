#!/usr/bin/env node
/**
 * dedupe-same-url-bylines.js
 *
 * Fixes the same-URL / multi-byline double-count class (Notion 2026-07-12,
 * sibling of the circular-duplicateOf fix). Within a show dir, two+ review
 * files can share the SAME canonical article URL under DIFFERENT critic
 * bylines with NO duplicateOf link between them — so the rebuild includes ALL
 * of them and the one underlying review is counted 2-3× in the composite
 * (e.g. aint-too-proud-2019 NYT Brantley 78 + Green 79 on identical text;
 * a-view-from-the-bridge-2010 Variety Isherwood + Rooney). A repo-wide sweep on
 * 2026-07-12 found 211 such double-counting groups.
 *
 * Root cause: review-write-guard's URL-collision detector only marks a
 * duplicate when a file is WRITTEN and finds a pre-existing same-URL sibling;
 * files written before the detector, or both-present at write time, escape it.
 * These are one article scraped twice under two bylines (scraper byline
 * misattribution), NOT genuine syndication (which detect-syndicated-duplicates
 * handles across outlets by same critic).
 *
 * SAFETY — the hard part is telling "one review, two bylines" (collapse) from
 * "two genuinely different reviews sharing one URL" (one has a WRONG url —
 * collapsing would DROP a real review). We only collapse a group when its
 * includable members are COHESIVE: identical content fingerprint, OR minimum
 * pairwise word-Jaccard ≥ COHESION_THRESHOLD. Non-cohesive groups (genuinely
 * different text at one URL — e.g. once-upon-a-mattress Vincentelli vs Green,
 * or the theater-life "Barry Gordin" wrong-byline contamination) are REPORTED
 * to data/audit/, never modified.
 *
 * SCOPE — we target only what the rebuild MISSES. The rebuild already collapses
 * same-URL groups whose text is byte-identical (content-fingerprint dedup,
 * ~3411) or whose bylines are typo-variants (fuzzy-critic URL dedup, ~3367) —
 * production confirms those don't double-count — so rebuildAlreadyCollapses()
 * skips them (marking them would only override the rebuild's better byline
 * selection). What slips through is the same article scraped under DIFFERENT
 * real critics with DIFFERENT fingerprints (boilerplate/nav extraction noise):
 * the rebuild treats those as a legit "multi-critic page" and keeps both.
 * Measured 2026-07-12: 112 cohesive groups collapsed (99 via fingerprint/Jaccard
 * + 13 via the asymmetric-containment signal, which catches an article whose two
 * extractions differ enough in length that symmetric Jaccard misses them); 85
 * same-fingerprint skipped (rebuild handles); 10 non-cohesive reported for triage
 * (9 are the theater-life "Barry Gordin" phantom-byline accuracy bug — a real
 * review under a wrong critic name, NOT a double-count; 1 is once-upon-a-mattress,
 * two genuinely-different NYT pieces sharing a URL — a URL-integrity issue).
 *
 * Canonical choice reuses fix-circular-duplicate-pairs.chooseCanonicalForRebuild
 * (includability-first, then score/byline/age), folded across the group so the
 * member the rebuild would keep live survives; the others are marked
 * duplicateOf the canonical (LOAD-MODIFY-SAVE, force:true — they share the
 * canonical's URL, so a non-forced write would just re-derive the same mark).
 * fix() also clears any STALE duplicateOf/duplicateTextOf the chosen canonical
 * itself carries at one of its own new losers (BRO-318: an uncleared pointer
 * here makes the pair circular and lets rebuild-all-reviews.js's fingerprint
 * dedup — which has no canonical-awareness — silently keep the loser instead).
 *
 * Usage:
 *   node scripts/dedupe-same-url-bylines.js            # report (exit 1 if any)
 *   node scripts/dedupe-same-url-bylines.js --json     # JSON report
 *   node scripts/dedupe-same-url-bylines.js --fix      # collapse cohesive groups
 *   node scripts/dedupe-same-url-bylines.js --gate     # CI floor gate
 *   SHOWS_JSON=... REVIEW_TEXTS_DIR=... node scripts/... --fix
 *
 * Exit codes: 0 = clean / repaired / gate-ok; 1 = cohesive groups found (report)
 *             or spike past floor (--gate).
 */

const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');
const { isIncludableForRebuild, areSameCriticFuzzy } = require('./lib/review-guards');
const { normalizeUrl, loadOutletRegistry } = require('./lib/review-normalization');
const { computeContentFingerprint } = require('./lib/content-quality');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { planCanonicalPointerClear, applyCanonicalPointerClear } = require('./lib/canonical-duplicate-pointers');
const { isPlaceholderRecord } = require('./lib/placeholder-byline');

// See fix-circular-duplicate-pairs.js's identical helper — self-branded solo
// critics (carole-di-tosti, carey-purcell, oscar-e-moore) have outlet
// displayName === defaultCritic, so isPlaceholderRecord needs this override
// to not flag them as placeholders (Codex adversarial review, card #1907).
function _defaultCriticFor(outletId) {
  if (!outletId) return null;
  const registry = loadOutletRegistry();
  return (registry && registry.outlets && registry.outlets[outletId] && registry.outlets[outletId].defaultCritic) || null;
}

const USAGE = `dedupe-same-url-bylines.js — Fixes the same-URL / multi-byline double-count class (Notion 2026-07-12,.

Usage:
  node scripts/dedupe-same-url-bylines.js [options]
  node scripts/dedupe-same-url-bylines.js --help, -h    print this usage and exit
`;
const {
  chooseCanonicalForRebuild, isScoreable,
} = require('./fix-circular-duplicate-pairs');

const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const AUDIT_PATH = path.join(__dirname, '..', 'data', 'audit', 'same-url-different-text.json');

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const JSON_OUT = args.includes('--json');
const GATE = args.includes('--gate');

// Min pairwise word-Jaccard for a group to count as "one article, two bylines".
// 0.7 keeps clearly-same articles (boilerplate/nav extraction noise pushes an
// identical review down from 1.0 but rarely below 0.7) while excluding
// genuinely-different reviews (measured cluster <0.5) so we never drop a real
// review. Same content fingerprint always qualifies regardless.
const COHESION_THRESHOLD = 0.7;
// Asymmetric containment floor — the shorter text's words nearly all appear in
// the longer, i.e. one extraction is a truncated/boilerplate-lighter copy of the
// other article. 0.85 cleanly separates the 13 same-article groups (all ≥ 0.90)
// from genuinely-different reviews at one URL (≤ 0.46).
const CONTAINMENT_THRESHOLD = 0.85;
const GATE_FLOOR = 15;

// Show lookup for isIncludableForRebuild fidelity (same rationale as
// fix-circular-duplicate-pairs.js).
let _showByIdCache;
function _showById(showId) {
  if (_showByIdCache === undefined) {
    _showByIdCache = new Map();
    for (const p of [process.env.SHOWS_JSON, path.join(__dirname, '..', 'data', 'shows.json')].filter(Boolean)) {
      try {
        const arr = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const shows = Array.isArray(arr) ? arr : (arr.shows || []);
        for (const s of shows) if (s && s.id) _showByIdCache.set(s.id, s);
        if (_showByIdCache.size) break;
      } catch { /* try next */ }
    }
  }
  return _showByIdCache.get(showId);
}

/** Word set (len>3, alnum-normalized) for Jaccard similarity. */
function wordSet(t) {
  return new Set((t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3));
}
function jaccard(a, b) {
  const A = wordSet(a), B = wordSet(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const uni = A.size + B.size - inter;
  return uni ? inter / uni : 0;
}

/**
 * Asymmetric containment: fraction of the SHORTER text's word-set found in the
 * longer. Catches the same-article case Jaccard misses — when one extraction is
 * much shorter than the other (truncation, missing boilerplate) their symmetric
 * Jaccard drops well below 0.7 even though the shorter is a near-subset of the
 * longer (NYT Brantley/Isherwood, Guardian misfiled-jesse-green, 2026-07-12).
 * Measured: the 13 same-article groups score ≥ 0.90; genuinely-different reviews
 * at one URL (once-upon-a-mattress) and byline-swapped different reviews score
 * ≤ 0.46. Gated by same-URL in audit(), so a near-subset is the same article.
 */
function containment(a, b) {
  const A = wordSet(a), B = wordSet(b);
  const [S, L] = A.size <= B.size ? [A, B] : [B, A];
  if (!S.size) return 0;
  let inter = 0;
  for (const w of S) if (L.has(w)) inter++;
  return inter / S.size;
}

/**
 * Are these member records cohesive enough to be one article under multiple
 * bylines? True when every text is a non-empty identical fingerprint, or the
 * MINIMUM pairwise Jaccard ≥ COHESION_THRESHOLD. Pure — for unit tests.
 * @param {Array<{fullText?:string}>} datas includable members' records
 */
function isCohesiveGroup(datas) {
  const texts = datas.map(d => (d && d.fullText) || '');
  if (texts.some(t => !t)) return false; // can't confirm sameness without text
  const fps = texts.map(t => computeContentFingerprint(t));
  if (fps.every(x => x && x === fps[0])) return true;
  let minJ = 1, minC = 1;
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const s = jaccard(texts[i], texts[j]);
      if (s < minJ) minJ = s;
      const c = containment(texts[i], texts[j]);
      if (c < minC) minC = c;
    }
  }
  // Either symmetric overlap is high (similar-length extractions of one article)
  // OR the shorter is a near-subset of the longer (one extraction truncated).
  return minJ >= COHESION_THRESHOLD || minC >= CONTAINMENT_THRESHOLD;
}

/**
 * Does the rebuild ALREADY collapse this same-URL group on its own, so we must
 * NOT touch it? Two rebuild mechanisms handle a subset of same-URL groups:
 *   1. Content-fingerprint dedup (rebuild-all-reviews.js ~3411): identical
 *      fingerprint + text ≥ 100 chars → collapsed (and its swap-to-default-critic
 *      logic picks the right byline — better than we can). Production confirms
 *      same-fingerprint pairs (a-view-from-the-bridge-2010, 700-sundays-2013)
 *      do NOT double-count. Marking them here would override that byline logic.
 *   2. Fuzzy-critic URL dedup (~3367): same URL + Levenshtein ≤ 2 bylines
 *      (typo variants) → collapsed. Distinct real critics (Brantley vs
 *      Isherwood) are NOT fuzzy-collapsed and DO double-count when fingerprints
 *      differ — those are exactly what we target.
 * Pure — for unit tests.
 * @param {string[]} names includable member filenames
 * @param {Array<object>} datas their records
 */
function rebuildAlreadyCollapses(names, datas) {
  const texts = datas.map(d => (d && d.fullText) || '');
  const longEnough = texts.every(t => t.length >= 100);
  if (longEnough) {
    const fps = texts.map(t => computeContentFingerprint(t));
    if (fps.every(x => x && x === fps[0])) return true; // fingerprint dedup handles it
  }
  // Fuzzy-critic: only meaningful for a 2-member group (rebuild dedups pairwise).
  if (names.length === 2) {
    const critics = datas.map(d => ((d && d.criticName) || '').toLowerCase().trim());
    if (critics[0] && critics[1] && critics[0] !== 'unknown' && critics[1] !== 'unknown'
        && critics[0] !== critics[1]) {
      try { if (areSameCriticFuzzy(critics[0], critics[1])) return true; } catch { /* keep going */ }
    }
  }
  return false;
}

/**
 * True when an includable same-URL group has both a placeholder byline (the
 * outlet's own name, "Unknown", or a generic desk/staff term) AND a real one.
 * Card #1907: a placeholder must never survive as canonical over a real
 * byline in the SAME cluster — this is checked ahead of rebuildAlreadyCollapses
 * so the fingerprint-identical bypass never lets a placeholder's survival
 * depend on file-processing order at rebuild time. Pure — for unit tests.
 * @param {Array<{criticName?:string, outlet?:string}>} datas includable members
 */
function hasPlaceholderVsRealSplit(datas) {
  const flags = datas.map(d => isPlaceholderRecord(d, { defaultCritic: _defaultCriticFor(d && d.outletId) }));
  return flags.some(Boolean) && flags.some(f => !f);
}

// The two EXACT stamp patterns that mean "a repair declined to close a
// duplicateOf cycle here" — review-write-guard.js's cycle-refusal and
// fix-canonical-duplicate-backpointer.js's canonical-backpointer repair.
// Deliberately narrow: `duplicateClearReason` has 9+ other writers (self-ref
// clears, stale-sibling clears, URL-mismatch clears, and — critically —
// manual-review-fields.js's operator "vouched for this review as independent
// (not a duplicate)" stamp, which ALSO adds duplicateOf/duplicateClearReason
// to that record's own protectedFields specifically so the vouch survives
// future writes). A broad `typeof === 'string'` match would force-resolve a
// manually-vouched cluster too — and force:true (used by fix() below) already
// bypasses protectedFields protection by design, so that vouch would be
// silently overwritten. Second-opinion review, card #1907.
const CYCLE_CLEAR_BREADCRUMB_PATTERNS = [
  'refusing duplicateOf cycle',
  'canonical-backpointer-cleared:',
];

/**
 * True when an includable same-URL group has already been through a declined
 * cycle-clear: review-write-guard's cycle-refusal (wouldFormDuplicateCycle)
 * and fix-canonical-duplicate-backpointer.js each stamp `duplicateClearReason`
 * on the side they clear rather than leaving a duplicateOf pointer. Two
 * independent repairs can each clear one side of an A<->B cycle, leaving BOTH
 * members unsuppressed with nothing left pointing either way — this is the
 * breadcrumb that proves it happened, per the card's own diagnosis: "The
 * duplicateClearReason breadcrumb names the exact counterpart it deferred to -
 * that is enough to re-check." Pure — for unit tests.
 * @param {Array<{duplicateClearReason?:string|null}>} datas includable members
 */
function hasContestedCycleClear(datas) {
  return datas.some(d => d && typeof d.duplicateClearReason === 'string'
    && CYCLE_CLEAR_BREADCRUMB_PATTERNS.some(p => d.duplicateClearReason.includes(p)));
}

function walkShowDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== '_pending')
    .map(e => path.join(root, e.name));
}

/**
 * Find same-URL double-count groups. Returns { cohesive, different } where
 * cohesive = [{showId, canonical, losers[], reason}] (safe to collapse) and
 * different = [{showId, members[], minJaccard}] (report only — do NOT collapse).
 */
function audit() {
  const cohesive = [], different = [];
  let placeholderVsRealCount = 0;
  for (const showDir of walkShowDirs(REVIEW_TEXTS_DIR)) {
    const showId = path.basename(showDir);
    let files;
    try { files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json'); }
    catch { continue; }
    const cache = {};
    const load = (n) => {
      if (n in cache) return cache[n];
      try { cache[n] = JSON.parse(fs.readFileSync(path.join(showDir, n), 'utf-8')); }
      catch { cache[n] = null; }
      return cache[n];
    };
    // group by normalized url
    const groups = {};
    for (const f of files) {
      const d = load(f);
      if (!d || typeof d.url !== 'string' || !d.url) continue;
      let nu; try { nu = normalizeUrl(d.url); } catch { nu = d.url; }
      if (nu) (groups[nu] = groups[nu] || []).push(f);
    }
    for (const members of Object.values(groups)) {
      if (members.length < 2) continue;
      const set = new Set(members);
      // skip groups already collapsed by a duplicateOf link between members
      if (members.some(f => { const d = load(f); return d && typeof d.duplicateOf === 'string' && set.has(d.duplicateOf); })) continue;
      // only includable members double-count
      const incl = members.filter(f => {
        const d = load(f);
        try { return !!isIncludableForRebuild(d, _showById(showId), path.join(showDir, f)); } catch { return false; }
      });
      if (incl.length < 2) continue;
      const datas = incl.map(load);
      // Placeholder-vs-real or a previously-declined cycle-clear: never defer
      // to rebuildAlreadyCollapses for these. That bypass exists because the
      // rebuild's runtime fingerprint dedup "already handles it" — true in
      // general, but it resolves by file-processing order, not by byline
      // quality, and leaves no persistent duplicateOf pointer a future
      // re-scrape (differing extraction -> differing fingerprint) can rely on.
      // Card #1907 gaps 1+2: force these into the normal cohesive/different
      // path so a real byline is proactively marked canonical on disk.
      const forceResolve = hasPlaceholderVsRealSplit(datas) || hasContestedCycleClear(datas);
      if (forceResolve) placeholderVsRealCount++;
      // Leave OTHER groups the rebuild already collapses (same-fingerprint or
      // fuzzy typo-critic) untouched — marking them would override the
      // rebuild's better byline-selection logic and change nothing about the
      // double-count.
      if (!forceResolve && rebuildAlreadyCollapses(incl, datas)) continue;
      if (isCohesiveGroup(datas)) {
        // fold chooseCanonicalForRebuild across the group to pick one survivor.
        // A `skip:true` pairwise result means chooseCanonicalForRebuild found
        // BOTH members class-A cross-market contaminated and explicitly said
        // "leave this pair suppressed, don't canonicalize either side"
        // (fix-circular-duplicate-pairs.js's own audit() honors this by
        // `continue`-ing past the pair entirely). Folding blindly through
        // `c.canonical` here would ignore that safety verdict and could
        // unsuppress a known wrong-production review — Codex adversarial
        // review, card #1907. Abort the WHOLE group on any skip.
        let canonName = incl[0];
        let skipped = false;
        for (let i = 1; i < incl.length; i++) {
          const c = chooseCanonicalForRebuild(canonName, load(canonName), incl[i], load(incl[i]), showDir);
          if (c.skip) { skipped = true; break; }
          canonName = c.canonical;
        }
        if (skipped) continue;
        cohesive.push({ showId, canonical: canonName, losers: incl.filter(f => f !== canonName) });
      } else {
        let minJ = 1;
        const texts = datas.map(d => (d && d.fullText) || '');
        for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) { const s = jaccard(texts[i], texts[j]); if (s < minJ) minJ = s; }
        different.push({ showId, members: incl, minJaccard: Number(minJ.toFixed(2)) });
      }
    }
  }
  return { cohesive, different, placeholderVsRealCount };
}

function fix(cohesive) {
  let collapsed = 0, losersMarked = 0, staleCanonicalPointerCleared = 0;
  const day = new Date().toISOString().slice(0, 10);
  for (const g of cohesive) {
    const dir = path.join(REVIEW_TEXTS_DIR, g.showId);
    const canonPath = path.join(dir, g.canonical);
    const canonData = JSON.parse(fs.readFileSync(canonPath, 'utf-8'));
    // The chosen canonical can carry a STALE duplicateOf/duplicateTextOf
    // pointer at one of its own now-subordinate losers — left over from an
    // earlier pass (e.g. collect-review-texts.js's content-fingerprint dedup,
    // which ran before this file was ever chosen canonical here). Left
    // uncleared, it makes the canonical and a loser mutually point at each
    // other, which rebuild-all-reviews.js's one-hop circular-recovery logic
    // reads as "ambiguous — keep both" and defers the decision to the belt-
    // and-suspenders fingerprint dedup (~4085), a check with no awareness of
    // which side THIS script designated canonical. That check breaks ties by
    // file sort order alone, so it can (and did — queen-versailles-2025
    // Vulture, BRO-318) keep the loser and silently drop the canonical
    // entirely, taking its score/byline with it. Clearing the canonical's own
    // pointer here — in the SAME write pass that subordinates its losers —
    // closes the loop so the canonical it chose is the file that survives.
    // Shares scripts/lib/canonical-duplicate-pointers.js with
    // audit-review-url-clusters.js (fixed for this exact bug class 2026-08-17,
    // loves-labours-lost-globe-west-end-2026) rather than hand-rolling the
    // clear — that module gets null-vs-delete right (duplicateOf: null,
    // duplicateTextOf: deleted; validate-data.js flags a null duplicateTextOf
    // as a field that should have been removed) and only drops a field
    // proven to point at a cluster member, never both unconditionally.
    // No `siblings` param: g.losers is already a same-URL cluster (audit()
    // groups strictly by normalizeUrl), which the module's own docs treat as
    // sufficient proof on its own — passing siblings here would additionally
    // require the loser to ALREADY point back at the canonical, which isn't
    // true yet for a freshly-detected group (the loser-marking loop below is
    // what sets that pointer), so it would refuse to clear the exact case
    // this fix exists for.
    const plan = planCanonicalPointerClear(canonData, { self: g.canonical, clusterFiles: g.losers });
    if (plan.drop.length) {
      applyCanonicalPointerClear(canonData, plan);
      canonData.duplicateClearReason = `same-url-byline-dedup on ${day}: ${plan.reason} — this file is the chosen canonical`;
      safeWriteReview(canonPath, canonData, { force: true });
      staleCanonicalPointerCleared++;
    }
    for (const loser of g.losers) {
      const p = path.join(dir, loser);
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (data.duplicateOf === g.canonical) continue; // already
      data.duplicateOf = g.canonical;
      data.duplicateReason = `same-url-byline-dedup on ${day}: identical article as ${g.canonical} under a different byline (one review scraped twice)`;
      data.duplicateClearReason = null; // live duplicate now
      safeWriteReview(p, data, { force: true });
      losersMarked++;
    }
    collapsed++;
  }
  return { collapsed, losersMarked, staleCanonicalPointerCleared };
}

function writeAuditReport(different) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.writeFileSync(AUDIT_PATH, JSON.stringify({
      generated: 'run dedupe-same-url-bylines.js --report to refresh',
      note: 'Same URL, DIFFERENT text — genuinely distinct reviews at one URL (one has a wrong URL) or systematic wrong-byline contamination (e.g. theater-life "Barry Gordin"). Do NOT collapse; needs URL/byline triage.',
      count: different.length,
      groups: different,
    }, null, 2) + '\n');
  } catch (e) { console.warn(`[dedupe-same-url] could not write audit report: ${e.message}`); }
}

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const { cohesive, different, placeholderVsRealCount } = audit();
  if (JSON_OUT) {
    console.log(JSON.stringify({
      cohesiveCount: cohesive.length, differentCount: different.length, placeholderVsRealCount, cohesive, different,
    }, null, 2));
    process.exit(cohesive.length === 0 ? 0 : 1);
  }
  console.log(`Same-URL double-count groups: ${cohesive.length} cohesive (collapsible), ${different.length} different-text (report-only), ${placeholderVsRealCount} placeholder-vs-real or contested-clear (forced into the above).`);
  for (const g of cohesive.slice(0, 40)) {
    console.log(`  [collapse] ${g.showId}: keep ${g.canonical}, mark ${g.losers.join(', ')} duplicate`);
  }
  if (cohesive.length > 40) console.log(`  … and ${cohesive.length - 40} more cohesive groups`);
  if (FIX) {
    const r = fix(cohesive);
    writeAuditReport(different);
    console.log(`\nCollapsed ${r.collapsed} group(s); marked ${r.losersMarked} duplicate(s); cleared ${r.staleCanonicalPointerCleared} stale canonical self-pointer(s). Wrote ${different.length} different-text groups to ${path.relative(process.cwd(), AUDIT_PATH)}.`);
    console.log('Re-run the rebuild to drop the double-counts.');
    process.exit(0);
  }
  if (GATE) {
    if (cohesive.length > GATE_FLOOR) {
      console.error(`\n❌ GATE: ${cohesive.length} cohesive same-URL double-count group(s) > floor ${GATE_FLOOR}. A spike signals a producer regression re-creating same-URL byline splits — failing the trunk before they distort composite scores. Run --fix.`);
      process.exit(1);
    }
    console.log(`\n✅ GATE: ${cohesive.length} cohesive group(s) ≤ floor ${GATE_FLOOR}. Auto-healable churn (dedupe-same-url-bylines.yml --fix); not blocking the trunk.`);
    process.exit(0);
  }
  if (cohesive.length === 0) { console.log('OK: no collapsible same-URL byline groups'); process.exit(0); }
  console.log('\nRun with --fix to collapse cohesive groups.');
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  jaccard, containment, wordSet, isCohesiveGroup, rebuildAlreadyCollapses,
  hasPlaceholderVsRealSplit, hasContestedCycleClear,
  audit, fix, COHESION_THRESHOLD, CONTAINMENT_THRESHOLD,
};
