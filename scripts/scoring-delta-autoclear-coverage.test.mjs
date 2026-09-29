import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideInclusion } = require('./scoring-delta.js');
const reviewGuards = require('./lib/review-guards.js');
const dateGuard = require('./lib/date-guard.js');
const realAutoClear = require('./lib/wrong-production-autoclear.js');

// Task #1163: scoring-delta.js's mandated inclusion replay previously treated
// review.wrongShow/review.wrongProduction as static flags, identical on both
// the baseline and working-tree side of every diff — it never replayed
// rebuild-all-reviews.js's auto-clear predicates (shouldAutoClearWrongShow,
// shouldAutoClearWrongShowUkUrl, shouldAutoClearWrongProduction). A change to
// those predicates (e.g. task #1146's regression) always reported "0 diff /
// safe" even when it silently disabled or broke a real auto-clear path. This
// builds two synthetic guards modules that differ ONLY in
// shouldAutoClearWrongShowUkUrl's behavior and asserts decideInclusion's
// verdict flips between them — the exact false-negative this card fixes.

function buildGuards(autoClearOverrides) {
  return {
    ...reviewGuards,
    __dateGuard: dateGuard,
    __priorRunLib: { ...realAutoClear, ...autoClearOverrides },
  };
}

const show = { id: 'test-show-west-end-2026', category: 'west-end', earliestDate: null };

// UK outlet URL on a London-market show, wrongShow=true, no manual reason,
// no ensemble consensus, no stale-text rewrite — the exact shape
// shouldAutoClearWrongShowUkUrl is designed to clear.
const review = {
  wrongShow: true,
  url: 'https://www.thetimes.co.uk/theatre/some-review-slug',
  assignedScore: 75,
  contentTier: 'complete',
};

describe('scoring-delta.js decideInclusion auto-clear replay', () => {
  test('flips inclusion when shouldAutoClearWrongShowUkUrl behavior is swapped', () => {
    const guardsAlwaysClears = buildGuards({ shouldAutoClearWrongShowUkUrl: () => true });
    const guardsNeverClears = buildGuards({ shouldAutoClearWrongShowUkUrl: () => false });

    const withClear = decideInclusion(review, show, guardsAlwaysClears);
    const withoutClear = decideInclusion(review, show, guardsNeverClears);

    assert.notStrictEqual(
      withClear.included,
      withoutClear.included,
      `expected inclusion to flip when shouldAutoClearWrongShowUkUrl changes; got ${JSON.stringify({ withClear, withoutClear })}`
    );
    assert.strictEqual(withClear.included, true, 'auto-clear=true should include the review (other guards pass)');
    assert.strictEqual(withoutClear.included, false, 'auto-clear=false should keep the wrongShow exclusion');
    assert.strictEqual(withoutClear.reason, 'wrongShow');
  });

  test('does not auto-clear when a manual wrongShowReason is set, regardless of predicate override', () => {
    const guardsAlwaysClears = buildGuards({ shouldAutoClearWrongShowUkUrl: () => true, shouldAutoClearWrongShow: () => true });
    const manuallyFlagged = { ...review, wrongShowReason: 'confirmed via audit' };

    // The real shouldAutoClearWrongShowUkUrl/shouldAutoClearWrongShow both
    // internally respect wrongShowReason — verify the REAL predicates (not a
    // stub) still exclude, guarding against a future change accidentally
    // dropping that check.
    const realGuards = buildGuards({});
    const decision = decideInclusion(manuallyFlagged, show, realGuards);
    assert.strictEqual(decision.included, false);
    assert.strictEqual(decision.reason, 'wrongShow');
  });

  test('shouldAutoClearWrongProduction swap also flips inclusion', () => {
    const wpReview = {
      wrongProduction: true,
      allowEarlyDate: true,
      assignedScore: 60,
      contentTier: 'complete',
    };
    const guardsAlwaysClears = buildGuards({ shouldAutoClearWrongProduction: () => true });
    const guardsNeverClears = buildGuards({ shouldAutoClearWrongProduction: () => false });

    const withClear = decideInclusion(wpReview, show, guardsAlwaysClears);
    const withoutClear = decideInclusion(wpReview, show, guardsNeverClears);

    assert.strictEqual(withClear.included, true);
    assert.strictEqual(withoutClear.included, false);
    assert.strictEqual(withoutClear.reason, 'wrongProduction');
  });

  test('requiring scoring-delta.js has no side effects (main() does not run)', () => {
    // decideInclusion must be importable without scoring-delta.js's main()
    // reading real shows.json/review-texts or calling process.exit — this is
    // what makes this file testable at all (require.main === module guard).
    assert.strictEqual(typeof decideInclusion, 'function');
  });

  // Task #1180: wrongAttribution was listed in FLAG_FIELDS (the set of fields
  // whose changes trigger this replay) but decideInclusion never actually
  // checked it — so the gate could detect the field changed yet never model
  // an actual flip. Discovered while clearing a false-positive wrongAttribution
  // flag on 6 nytimes--tim-teeman.json files (Tim Teeman's byline was real,
  // confirmed via the live NYT page's own GraphQL data).
  test('wrongAttribution:true excludes a review that otherwise passes all guards', () => {
    const flagged = { wrongAttribution: true, assignedScore: 49, contentTier: 'complete' };
    const decision = decideInclusion(flagged, show, buildGuards({}));
    assert.strictEqual(decision.included, false);
    assert.strictEqual(decision.reason, 'wrongAttribution');
  });

  test('clearing wrongAttribution (manual-verify shape) restores inclusion', () => {
    const cleared = {
      assignedScore: 49,
      contentTier: 'complete',
      crossOutletVerified: true,
      wrongArticleManualClear: true,
      // wrongAttribution intentionally absent — safeWriteReview's post-clear shape.
    };
    const decision = decideInclusion(cleared, show, buildGuards({}));
    assert.strictEqual(decision.included, true);
  });
});

// Task #1180 follow-up (second-opinion warning): a FLAG_FIELDS entry with no
// matching decideInclusion branch is exactly how the wrongAttribution gap
// above went unnoticed — assert every FLAG_FIELDS name is at least referenced
// somewhere in decideInclusion's own source, so the next silent addition
// fails a test instead of shipping a dead trigger.
//
// KNOWN_UNCOVERED: this same audit found 4 PRE-EXISTING dead triggers beyond
// wrongAttribution — suspectedMisattribution, isNonReview, fabricatedEntry,
// rejectedAt (the last has 4 exception branches in review-guards.js's
// explainExclusion, of comparable complexity to the wrongProduction auto-clear
// replay decideInclusion already does — not a one-line fix). Fixing those is
// scoped to a dedicated follow-up (Notion, filed alongside task #1180) rather
// than bundled into this card's wrongAttribution fix. Listed explicitly here
// (not silently allowed) so this test still fails the moment a FIFTH field is
// added without a branch, and so removing an entry from this list is a visible
// diff when the follow-up lands.
//
// isNonReview closed (BRO-3862): decideInclusion was blind to every
// isNonReview-driven flip — the exact class of change this ticket's audit
// sweeps make — so scoring-delta.js always reported "0 flips" for them. Fixed
// by mirroring rebuild-all-reviews.js:3570 (incl. isNonReviewDemotedByFreshCV).
const KNOWN_UNCOVERED = new Set(['suspectedMisattribution', 'fabricatedEntry', 'rejectedAt']);
describe('scoring-delta.js FLAG_FIELDS / decideInclusion coverage', () => {
  test('every FLAG_FIELDS name is referenced inside decideInclusion, or explicitly listed as a known gap', () => {
    const { FLAG_FIELDS } = require('./scoring-delta.js');
    const body = decideInclusion.toString();
    const unreferenced = [...FLAG_FIELDS].filter((field) => !body.includes(field) && !KNOWN_UNCOVERED.has(field));
    assert.deepStrictEqual(
      unreferenced,
      [],
      `FLAG_FIELDS entries not referenced in decideInclusion and not in KNOWN_UNCOVERED (dead trigger — add a branch or add to KNOWN_UNCOVERED with a reason): ${unreferenced.join(', ')}`
    );
  });

  test('KNOWN_UNCOVERED has no stale entries (fails once a listed field gets a real branch)', () => {
    const body = decideInclusion.toString();
    const staleEntries = [...KNOWN_UNCOVERED].filter((field) => body.includes(field));
    assert.deepStrictEqual(
      staleEntries,
      [],
      `These KNOWN_UNCOVERED fields now have a decideInclusion branch — remove from the allowlist: ${staleEntries.join(', ')}`
    );
  });
});

// BRO-3338: the tests above exercise a HAND-PICKED subset of
// wrong-production-autoclear.js's predicates (WrongShowUkUrl, WrongShow,
// WrongProduction) — nothing previously enumerated rebuild-all-reviews.js's
// REAL shouldAutoClear* call list, so decideInclusion silently fell behind
// (4 of 10 replayed) with every test here still green, and a NEW 11th
// predicate added to rebuild-all-reviews.js with no scoring-delta.js handling
// would pass silently too. This closes that gap: it parses
// rebuild-all-reviews.js for every shouldAutoClear*( call site rather than
// trusting a hand-maintained list (the two-copies-of-one-policy trap this
// repo already has a memory for, one level up — in the gate, not the
// pipeline) and requires each name to appear CALL-SHAPED (name + '(', not a
// bare substring that could match only a comment) inside decideInclusion's
// own source, mirroring the FLAG_FIELDS coverage test's
// decideInclusion.toString() pattern above rather than checking the whole
// scoring-delta.js file (which would also match the file's own descriptive
// comments naming predicates it does NOT replay).
//
// ALLOWED_UNREPLAYED: predicates intentionally left out of decideInclusion,
// each with why. Empty as of BRO-3338 — all 10 real predicates are replayed
// — but kept as an explicit escape hatch (with a required reason) rather
// than silently widening the substring check, so the NEXT genuinely
// provenance-bound predicate has one documented place to land instead of a
// silent gap.
const ALLOWED_UNREPLAYED = new Set([]);

function extractRebuildAutoClearCallSites() {
  const rebuildSrc = require('fs').readFileSync(
    require.resolve('./rebuild-all-reviews.js'),
    'utf8'
  );
  const names = new Set();
  for (const m of rebuildSrc.matchAll(/\bshouldAutoClear[A-Za-z]*(?=\s*\()/g)) {
    names.add(m[0]);
  }
  return [...names];
}

describe('scoring-delta.js auto-clear predicate drift guard (BRO-3338)', () => {
  test('every shouldAutoClear* predicate rebuild-all-reviews.js actually calls is replayed in decideInclusion, or explicitly allowlisted', () => {
    const rebuildNames = extractRebuildAutoClearCallSites();
    assert.ok(rebuildNames.length >= 10, `expected to find rebuild-all-reviews.js's real shouldAutoClear* call sites (got ${rebuildNames.length}: ${rebuildNames.join(', ')}) — regex may be broken`);

    const body = decideInclusion.toString();
    const missing = rebuildNames.filter((name) => !body.includes(`${name}(`) && !ALLOWED_UNREPLAYED.has(name));
    assert.deepStrictEqual(
      missing,
      [],
      `rebuild-all-reviews.js calls these shouldAutoClear* predicates but decideInclusion doesn't replay them and they're not in ALLOWED_UNREPLAYED (drift — add a branch or an allowlist entry with a reason): ${missing.join(', ')}`
    );
  });

  test('a fake 11th shouldAutoClear* predicate in rebuild-all-reviews.js source is detected as unreplayed', () => {
    // Same detection the test above uses, run against a SYNTHETIC rebuild
    // source string (never touches the real file) to prove the drift guard
    // actually fires on an addition, not just passes today by coincidence.
    const fakeRebuildSrc = "if (shouldAutoClearTotallyMadeUpPredicate(d, showRecord)) { d.wrongProduction = false; }";
    const names = [...new Set([...fakeRebuildSrc.matchAll(/\bshouldAutoClear[A-Za-z]*(?=\s*\()/g)].map((m) => m[0]))];
    const body = decideInclusion.toString();
    const missing = names.filter((name) => !body.includes(`${name}(`) && !ALLOWED_UNREPLAYED.has(name));
    assert.deepStrictEqual(missing, ['shouldAutoClearTotallyMadeUpPredicate']);
  });
});

// ship-check adversarial finding (BRO-3338): decideInclusion replaying a
// predicate is NOT sufficient on its own — main()'s `guardsIdentical`
// fast-path (a separate, hand-maintained AND-chain of baseline/working
// .toString() comparisons) decides whether Phase A's per-review replay even
// RUNS. A predicate added to decideInclusion but left out of guardsIdentical
// means: a session editing ONLY that predicate (e.g. BRO-3328 editing
// shouldAutoClearDatelessRevival) sees every OTHER compared function still
// byte-identical, guardsIdentical stays true, and scoring-delta.js prints
// "decisions identical — skipping inclusion replay" despite the edit — this
// is the exact #1163/#1190 blind spot the file's own comments warn about
// repeatedly, one level further out than the drift guard above (which only
// checks decideInclusion, not the fast-path gate around it).
function extractGuardsIdenticalBlockSource() {
  const src = require('fs').readFileSync(require.resolve('./scoring-delta.js'), 'utf8');
  const start = src.indexOf('const guardsIdentical =');
  assert.ok(start >= 0, 'could not find `const guardsIdentical =` in scoring-delta.js — has it been renamed?');
  const end = src.indexOf('registryComparable && registryHash === baselineRegistryHash;', start);
  assert.ok(end >= 0, 'could not find guardsIdentical block terminator in scoring-delta.js — has it been restructured?');
  return src.slice(start, end);
}

describe('scoring-delta.js guardsIdentical fast-path coverage (BRO-3338)', () => {
  test('every shouldAutoClear* predicate decideInclusion calls is also compared by guardsIdentical', () => {
    const body = decideInclusion.toString();
    const calledNames = [...new Set([...body.matchAll(/\bshouldAutoClear[A-Za-z]*(?=\s*\()/g)].map((m) => m[0]))];
    assert.ok(calledNames.length >= 8, `expected decideInclusion to call at least 8 shouldAutoClear* predicates (got ${calledNames.length}: ${calledNames.join(', ')}) — did the replay shrink?`);

    const guardsIdenticalSrc = extractGuardsIdenticalBlockSource();
    // Require the CALL-SHAPED `.toString()` comparison, not a bare name
    // substring — a bare-substring check would (and, caught in review, DID)
    // pass on a name mentioned only in a comment inside the block, exactly
    // the "checks spelling, not coverage" weakness ship-check flagged for
    // the drift-guard test above, applied to a case that actually bit this
    // very test during development.
    const missing = calledNames.filter((name) => !guardsIdenticalSrc.includes(`${name}?.toString()`));
    assert.deepStrictEqual(
      missing,
      [],
      `decideInclusion replays these predicates but guardsIdentical's fast-path comparison doesn't check them — a change to ONLY one of these would silently skip Phase A's replay ("decisions identical"). Add a baseline/working .toString() comparison line: ${missing.join(', ')}`
    );
  });

  test('evaluateDateGuard is compared by guardsIdentical when shouldAutoClearStaleDateGuard is replayed', () => {
    // shouldAutoClearStaleDateGuard's nowInWindow ctx is computed by
    // evaluateDateGuard, not by the predicate itself — a change to
    // evaluateDateGuard changes inclusion just as much as a change to the
    // predicate (same rationale already applied to
    // outletIsUkSideSelfHealRegion for the UK-dual-market replay).
    const body = decideInclusion.toString();
    if (!body.includes('shouldAutoClearStaleDateGuard(')) return; // nothing to check if the replay itself is gone
    const guardsIdenticalSrc = extractGuardsIdenticalBlockSource();
    assert.ok(
      guardsIdenticalSrc.includes('evaluateDateGuard'),
      'shouldAutoClearStaleDateGuard is replayed but guardsIdentical never compares evaluateDateGuard — a change to it would silently skip Phase A\'s replay'
    );
  });

  test('a synthetic guardsIdentical block missing a replayed predicate is detected, and a comment mention alone does not count', () => {
    // Proves the detection itself fires on an omission, not just passes
    // today by coincidence — mirrors the fake-11th-predicate test above.
    // Also proves the call-shaped `?.toString()` requirement actually bites:
    // shouldAutoClearWrongProduction appears in a COMMENT here (bare name,
    // no `?.toString()`), which a bare-substring check would have wrongly
    // accepted as "covered" — this is the exact false pass a bare-substring
    // version of this test suffered during development.
    const fakeGuardsIdenticalSrc = [
      'const guardsIdentical =',
      '  baseline.applyTemporalOverrides.toString() === working.applyTemporalOverrides.toString()',
      "  && (baseline.__priorRunLib?.shouldAutoClearDatelessRevival?.toString() || '') === (working.__priorRunLib?.shouldAutoClearDatelessRevival?.toString() || '')",
      '  // TODO: also compare shouldAutoClearWrongProduction here',
      '  ;',
    ].join('\n');
    const fakeCalledNames = ['shouldAutoClearDatelessRevival', 'shouldAutoClearWrongProduction'];
    const missing = fakeCalledNames.filter((name) => !fakeGuardsIdenticalSrc.includes(`${name}?.toString()`));
    assert.deepStrictEqual(missing, ['shouldAutoClearWrongProduction']);
  });
});
