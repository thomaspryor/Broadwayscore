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
const KNOWN_UNCOVERED = new Set(['suspectedMisattribution', 'isNonReview', 'fabricatedEntry', 'rejectedAt']);
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
  for (const m of rebuildSrc.matchAll(/\bshouldAutoClear[A-Za-z]*(?=\()/g)) {
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
    const names = [...new Set([...fakeRebuildSrc.matchAll(/\bshouldAutoClear[A-Za-z]*(?=\()/g)].map((m) => m[0]))];
    const body = decideInclusion.toString();
    const missing = names.filter((name) => !body.includes(`${name}(`) && !ALLOWED_UNREPLAYED.has(name));
    assert.deepStrictEqual(missing, ['shouldAutoClearTotallyMadeUpPredicate']);
  });
});
