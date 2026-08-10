// Guards a specific class of regression: a guard that decides whether a
// review may be WRITTEN lives only in gather-reviews.js's own write
// chokepoint (createReviewFile) and not in scripts/lib/review-file-writer.js's
// createOrMergeReviewFile — the shared chokepoint used by ~20 other writer
// scripts. 2026-08-09's main-red was exactly this shape: shouldSkipAggregatorUrlWrite
// lived only in gather-reviews.js, so audit-show-review-gap.js's ingest path
// (which writes through review-file-writer.js) had no equivalent guard and
// wrote five aggregator-URL-mismatch contamination files (fixed in
// aca35b3/7b9af4b1ff0 by hoisting the predicate to the shared chokepoint).
//
// This test does NOT hand-copy either file's import list — it parses the
// actual `require('.../review-guards')` destructuring lines from both source
// files, so a future import change is picked up automatically (CLAUDE.md
// rule 15: require() the real thing, never restate it in the test).
//
// WRITE_DECISION_GUARDS is the closed set of names this test polices — the 9
// guards gather-reviews.js's createReviewFile applies that review-guards.js
// exports (audited task #1150, 2026-08-09; see review-file-writer.js's Guard
// comments for the 4 that were hoisted, and the EXEMPTIONS reasons below for
// the 5 that were deliberately not). A name outside this set (e.g.
// isRoundupPageAsReview, already shared by both files; pickRerouteTarget,
// writer-only) is out of scope for this test.
//
// EXEMPTIONS is not a blanket escape hatch — every entry must justify why the
// guard belongs ONLY in gather-reviews.js's chokepoint (or already has
// equivalent coverage some other way). A hygiene check below asserts every
// exemption stays honest: it must still name a guard gather-reviews.js
// actually imports (a dead exemption is stale documentation) and must still
// be ABSENT from review-file-writer.js's imports (an exemption whose guard
// has since been hoisted must be deleted, not left to silently mask a real
// gap reopening).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const GATHER_PATH = path.join(REPO_ROOT, 'scripts', 'gather-reviews.js');
const WRITER_PATH = path.join(REPO_ROOT, 'scripts', 'lib', 'review-file-writer.js');

// Every write-decision guard gather-reviews.js's createReviewFile applies
// from review-guards.js, whether hoisted into review-file-writer.js or
// deliberately exempted. Discovered by reading both chokepoint functions in
// full (gather-reviews.js:createReviewFile, review-file-writer.js:
// createOrMergeReviewFile/_mergeIntoExisting) — task #1150.
const WRITE_DECISION_GUARDS = new Set([
  'isLikelyTourReview',
  'getWrongProductionReasonForUnknownCritic',
  'isWrongShowUnknownLocked',
  'isRoundupUrl',
  'shouldRouteUnknownCriticToPending',
  'shouldSkipWrongProductionAudit',
  'shouldSkipCrossShowUrlFlag',
  'urlLooksLikeReview',
  'urlOrTitleLooksLikeReview',
]);

// name -> why this guard is intentionally NOT required to appear in
// review-file-writer.js's import set. Every reason must point at either (a)
// architectural scope too large to hoist as a predicate call, (b) evidence
// the guard is already effectively shared some other way, or (c) evidence
// it isn't actually a write-decision guard (used only during discovery,
// before a URL is ever handed to the write chokepoint).
const EXEMPTIONS = {
  isRoundupUrl:
    'Coverage already achieved indirectly: isRoundupUrl(url).isRoundup is the ' +
    'inner check inside isRoundupPageAsReview (review-guards.js), which additionally ' +
    'requires outletId to be in ROUNDUP_HOST_OUTLETS for that URL\'s host — the same 6 ' +
    'hosts isRoundupUrl checks. review-file-writer.js already imports and calls ' +
    'isRoundupPageAsReview (Guard E1). Calling the bare isRoundupUrl predicate directly ' +
    'would DROP that outlet-gating and regress the documented 2026-07-11 policy that a ' +
    'named critic quoted FROM a roundup page still counts as a review (see ' +
    'ROUNDUP_HOST_OUTLETS comment in review-guards.js).',
  shouldRouteUnknownCriticToPending:
    'Routes NEW files to a `_pending/{showId}/` directory instead of the show\'s main ' +
    'review-texts dir (raw fs.writeFileSync, bypassing even safeWriteReview) — a ' +
    'destination change, not an accept/reject/flag decision. review-file-writer.js has ' +
    'zero concept of _pending/ routing for any of its ~20 callers. Architecturally bigger ' +
    'than a predicate call; needs its own design note + a corpus scan of what would newly ' +
    'route to _pending across those callers before it can be hoisted safely.',
  shouldSkipWrongProductionAudit:
    'False positive in the "only gather-reviews.js imports this" heuristic: grep shows ' +
    'it is directly imported and called by 15+ OTHER scripts (rebuild-all-reviews.js at ' +
    '9+ call sites, audit-wrong-production.js, flag-we-cross-production.js, ' +
    'apply-cross-production-llm-flags.js, scoring-delta.js, etc) — those are ' +
    'wrongProduction-flagging AUDIT scripts, not review-file-writer.js callers. Already ' +
    'broadly and correctly shared, just not through this particular chokepoint.',
  shouldSkipCrossShowUrlFlag:
    'gather-reviews.js uses this inside its OWN legacy cross-show-URL-collision ' +
    'resolution (year-proximity heuristic). review-file-writer.js solves the identical ' +
    'problem with a structurally different, newer mechanism: a persistent cross-show ' +
    'URL-ownership index (Guard I, url-ownership.js: findCrossShowOwners/' +
    'shouldBlockCrossShowCreate). Not a like-for-like predicate gap — two different ' +
    'designs for the same problem, and grafting the older heuristic onto the newer ' +
    'index needs its own architecture comparison, not a quick hoist.',
  urlLooksLikeReview:
    'Confirmed via line-range check: every gather-reviews.js call site is OUTSIDE the ' +
    'createReviewFile function body — these are candidate-URL filters used during SERP/' +
    'site-search DISCOVERY, deciding whether to even attempt fetching a URL, not whether ' +
    'a review "may be written". Not a write-decision guard by this test\'s own definition. ' +
    'review-file-writer.js\'s callers (aggregator scrapers) already do their own upstream ' +
    'candidate filtering before ever calling createOrMergeReviewFile with a URL.',
  urlOrTitleLooksLikeReview:
    'Same reasoning as urlLooksLikeReview above — a discovery-time candidate filter, ' +
    'never called inside gather-reviews.js\'s write chokepoint.',
};

function extractReviewGuardsImports(source) {
  const names = new Set();
  const re = /const\s*\{([^}]+)\}\s*=\s*require\(\s*['"][^'"]*review-guards(?:\.js)?['"]\s*\)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

function readImports(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  return extractReviewGuardsImports(source);
}

test('both source files exist and the require-parser finds real imports', () => {
  assert.ok(fs.existsSync(GATHER_PATH), `missing ${GATHER_PATH}`);
  assert.ok(fs.existsSync(WRITER_PATH), `missing ${WRITER_PATH}`);
  const gatherImports = readImports(GATHER_PATH);
  const writerImports = readImports(WRITER_PATH);
  // Sanity floor: if these come back empty/tiny, the regex broke silently
  // (e.g. the require line changed shape) and every assertion below would
  // vacuously pass. Fail loud instead.
  assert.ok(gatherImports.size >= 5, `gather-reviews.js review-guards import parse looks broken (found ${gatherImports.size} names)`);
  assert.ok(writerImports.has('isRoundupPageAsReview'), 'review-file-writer.js review-guards import parse looks broken (expected isRoundupPageAsReview)');
});

test('every write-decision guard gather-reviews.js imports is either hoisted into review-file-writer.js or documented as exempt', () => {
  const gatherImports = readImports(GATHER_PATH);
  const writerImports = readImports(WRITER_PATH);

  const missing = [];
  for (const name of WRITE_DECISION_GUARDS) {
    if (!gatherImports.has(name)) continue; // not (or no longer) imported by gather — nothing to police
    if (writerImports.has(name)) continue; // hoisted
    if (Object.prototype.hasOwnProperty.call(EXEMPTIONS, name)) continue; // documented exemption
    missing.push(name);
  }

  assert.deepEqual(
    missing,
    [],
    `write-decision guard(s) imported by gather-reviews.js but missing from review-file-writer.js ` +
    `with no documented exemption: ${missing.join(', ')}. Either hoist the guard into ` +
    `review-file-writer.js (with corpus evidence, per task #1150) or add a reasoned entry to ` +
    `EXEMPTIONS in this test file.`
  );
});

test('every EXEMPTIONS entry stays honest (not stale, not dead)', () => {
  const gatherImports = readImports(GATHER_PATH);
  const writerImports = readImports(WRITER_PATH);

  const stale = []; // exemption whose guard has since been hoisted — remove the exemption
  const dead = []; // exemption for a guard gather no longer even imports — remove the exemption
  for (const name of Object.keys(EXEMPTIONS)) {
    assert.ok(WRITE_DECISION_GUARDS.has(name), `EXEMPTIONS has an entry "${name}" not in WRITE_DECISION_GUARDS — add it there too`);
    if (writerImports.has(name)) stale.push(name);
    if (!gatherImports.has(name)) dead.push(name);
  }

  assert.deepEqual(stale, [], `exemption(s) now also imported by review-file-writer.js — remove from EXEMPTIONS, the gap is closed: ${stale.join(', ')}`);
  assert.deepEqual(dead, [], `exemption(s) for guard(s) gather-reviews.js no longer imports — remove from EXEMPTIONS: ${dead.join(', ')}`);
});
