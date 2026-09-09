/**
 * audit-review-contamination.test.mjs — regression coverage for BRO-65
 * (Notion 345637c5-416f-81ef): a lone strict-class contamination hit must
 * never fail the per-push trunk gate, only the daily non-blocking triage.
 *
 * `audit-review-contamination.js` itself is a top-level CLI script (top-level
 * `process.exit()`, hardcoded `data/` paths relative to its own __dirname) so
 * it isn't require()-able as a module. The classification/gate DECISION logic
 * it uses is extracted to scripts/lib/contamination-gate.js (CLAUDE.md §15)
 * and tested directly here against synthetic `hits` objects — deterministic,
 * no private review-texts checkout required.
 *
 * The second test shells out to the real script against the real corpus to
 * confirm --strict and --gate agree on the underlying hit count (they must,
 * since both now read STRICT_CLASSES/countStrictHits from the same module) —
 * skipped when the private review-texts repo isn't checked out (this worktree,
 * most local dev). Mirrors verify-contamination-gate.test.mjs's skip pattern.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { STRICT_CLASSES, countStrictHits, shouldBlockContaminationGate } = require('./lib/contamination-gate.js');
const { normalizeOutlet, normalizeUrl, normalizeCritic } = require('./lib/review-normalization.js');
const { buildLiveScoredIndex, isGenuineDoubleCount } = require('./lib/c2-live-scored-check.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');
const CORPUS = path.join(REPO, 'data', 'review-texts');
const AUDIT = path.join(__dirname, 'audit-review-contamination.js');

function emptyHits() {
  return {
    A_cross_market: [],
    A2_cross_market_relative: [],
    B_false_positive_wp: [],
    C_domain_mismatch: [],
    C2_url_multi_critic: [],
    D_pre_opening_feature: [],
    E_unflagged_roundup: [],
    F_empty_unknown: [],
  };
}

test('STRICT_CLASSES is exactly {A, C, E, F} — B and D are report-only by design', () => {
  assert.deepEqual([...STRICT_CLASSES].sort(), ['A', 'C', 'E', 'F']);
  assert.equal(STRICT_CLASSES.has('B'), false, 'B (false-positive wrongProduction) is a coverage-miss signal, not integrity — report-only');
  assert.equal(STRICT_CLASSES.has('D'), false, 'D (pre-opening feature) mixes in legitimate embargoed reviews — report-only');
  assert.equal(STRICT_CLASSES.has('C2'), false, 'C2 (multi-critic URL collision) is ambiguous without byline metadata — report-only');
});

test('countStrictHits sums only strict-class buckets, ignoring report-only ones', () => {
  const hits = emptyHits();
  hits.A_cross_market.push({ showId: 'x' });
  hits.B_false_positive_wp.push({ showId: 'x' }, { showId: 'y' });
  hits.C_domain_mismatch.push({ showId: 'x' });
  hits.D_pre_opening_feature.push({ showId: 'x' }, { showId: 'y' }, { showId: 'z' });
  assert.equal(countStrictHits(hits), 2, 'only A(1) + C(1); the 2 B hits and 3 D hits are report-only');
});

test('countStrictHits on an all-clean corpus is 0', () => {
  assert.equal(countStrictHits(emptyHits()), 0);
});

test('BRO-65 regression: a single strict-class hit (the china-doll FT/Guardian case) does not block --gate', () => {
  const hits = emptyHits();
  hits.E_unflagged_roundup.push({ showId: 'china-doll-2026', file: 'ft--unknown.json', url: 'https://x/article/Review-Roundup-y' });
  const strictHits = countStrictHits(hits);
  assert.equal(strictHits, 1);
  const blocked = shouldBlockContaminationGate({ crossMarketLeaks: hits.A_cross_market.length, strictHits, floor: 25 });
  assert.equal(blocked, false, '1 strict hit under GATE_FLOOR (25) must not fail the per-push trunk gate');
  // ...but the same single hit DOES fail full --strict triage (check-corpus-drift.yml,
  // non-blocking) — that's the point of the split, not a contradiction.
  const STRICT_would_fail = strictHits > 0;
  assert.equal(STRICT_would_fail, true);
});

test('BRO-65: even one class-A cross-market leak blocks --gate regardless of the floor', () => {
  const hits = emptyHits();
  hits.A_cross_market.push({ showId: 'x' });
  const strictHits = countStrictHits(hits);
  const blocked = shouldBlockContaminationGate({ crossMarketLeaks: hits.A_cross_market.length, strictHits, floor: 25 });
  assert.equal(blocked, true, 'class A (wrong show\'s reviews shown) is zero-tolerance even at 1 hit');
});

// BRO-74: fixture-based coverage for c2-live-scored-check.js — the ground-
// truth gate the C2 detector uses instead of trusting duplicateOf/
// duplicateTextOf. Deterministic synthetic reviews + fake normalizers, so
// this exercises the real decision logic (CLAUDE.md §15: require() the real
// function, don't re-copy it into the test) without depending on the corpus
// or the real outlet registry. Covers the exact gaps two rounds of
// adversarial review found: an unnamed critic must never count as a second
// byline, outlet/critic aliases must still match, and — the sharpest gap,
// found by /code-review — checking a SPECIFIC pair's two critics must not be
// satisfied by some OTHER unrelated pair of live critics at the same URL.
const fakeNormalizers = {
  normalizeOutlet: (s) => (s === 'ny-times' ? 'nytimes' : s),
  normalizeUrl: (s) => (s || '').replace(/\/$/, '').toLowerCase(),
  normalizeCritic: (s) => (s || '').trim().toLowerCase() || 'unknown',
};

test('c2-live-scored-check: 2 distinct named critics on the same URL, both queried, is a genuine double-count', () => {
  const index = buildLiveScoredIndex([
    { showId: 'x', outletId: 'nytimes', url: 'https://a/1', criticName: 'Critic A' },
    { showId: 'x', outletId: 'nytimes', url: 'https://a/1', criticName: 'Critic B' },
  ], fakeNormalizers);
  assert.equal(isGenuineDoubleCount(index, { showId: 'x', outletId: 'nytimes', url: 'https://a/1', critic1: 'Critic A', critic2: 'Critic B' }, fakeNormalizers), true);
});

test('c2-live-scored-check: only 1 live critic (already resolved) is NOT a double-count — the BRO-74 case', () => {
  const index = buildLiveScoredIndex([
    { showId: 'x', outletId: 'nytimes', url: 'https://a/1', criticName: 'Critic A' },
  ], fakeNormalizers);
  assert.equal(isGenuineDoubleCount(index, { showId: 'x', outletId: 'nytimes', url: 'https://a/1', critic1: 'Critic A', critic2: 'Critic B' }, fakeNormalizers), false);
});

test('c2-live-scored-check: a named critic + an "Unknown"/unnamed entry does NOT count as 2 distinct bylines', () => {
  const index = buildLiveScoredIndex([
    { showId: 'x', outletId: 'nytimes', url: 'https://a/1', criticName: 'Critic A' },
    { showId: 'x', outletId: 'nytimes', url: 'https://a/1', criticName: 'Unknown' },
    { showId: 'x', outletId: 'nytimes', url: 'https://a/1', criticName: '' },
  ], fakeNormalizers);
  assert.equal(isGenuineDoubleCount(index, { showId: 'x', outletId: 'nytimes', url: 'https://a/1', critic1: 'Critic A', critic2: 'Unknown' }, fakeNormalizers), false);
});

test('c2-live-scored-check: outlet aliases on either side of the comparison still match', () => {
  const index = buildLiveScoredIndex([
    { showId: 'x', outletId: 'ny-times', url: 'https://a/1', criticName: 'Critic A' }, // raw alias, as reviews.json might carry pre-canonicalization
    { showId: 'x', outletId: 'nytimes', url: 'https://a/1', criticName: 'Critic B' },
  ], fakeNormalizers);
  // Query with the OTHER alias spelling than either fixture used, to prove both sides canonicalize.
  assert.equal(isGenuineDoubleCount(index, { showId: 'x', outletId: 'ny-times', url: 'https://a/1/', critic1: 'Critic A', critic2: 'Critic B' }, fakeNormalizers), true);
});

test('c2-live-scored-check: different shows or different URLs never collide', () => {
  const index = buildLiveScoredIndex([
    { showId: 'x', outletId: 'nytimes', url: 'https://a/1', criticName: 'Critic A' },
    { showId: 'y', outletId: 'nytimes', url: 'https://a/1', criticName: 'Critic B' },
    { showId: 'x', outletId: 'nytimes', url: 'https://a/2', criticName: 'Critic C' },
  ], fakeNormalizers);
  assert.equal(isGenuineDoubleCount(index, { showId: 'x', outletId: 'nytimes', url: 'https://a/1', critic1: 'Critic A', critic2: 'Critic B' }, fakeNormalizers), false);
});

// BRO-74 /code-review finding: with 3+ corpus files sharing one URL, a
// coarse "2+ critics exist somewhere for this URL" check flags EVERY pair —
// including one involving a critic that's actually excluded (e.g. via
// duplicateTextOf) — reintroducing a narrower version of the original false
// positive. isGenuineDoubleCount must require BOTH of the SPECIFIC pair's
// critics to be individually live, not merely that 2+ critics exist at all.
test('c2-live-scored-check: 3+ critics at one URL — a pair involving the excluded one is NOT flagged, the genuine pair is', () => {
  const index = buildLiveScoredIndex([
    { showId: 'x', outletId: 'nytimes', url: 'https://a/1', criticName: 'Critic A' },
    { showId: 'x', outletId: 'nytimes', url: 'https://a/1', criticName: 'Critic B' },
    // Critic C's corpus file carries duplicateTextOf in the real corpus, so it
    // never made it into reviews.json — simulated here by simply not including
    // Critic C in the live-scored fixture at all.
  ], fakeNormalizers);
  // The genuine live pair: flagged.
  assert.equal(isGenuineDoubleCount(index, { showId: 'x', outletId: 'nytimes', url: 'https://a/1', critic1: 'Critic A', critic2: 'Critic B' }, fakeNormalizers), true);
  // A pair involving the excluded third critic: NOT flagged, even though 2 live critics exist at this URL overall.
  assert.equal(isGenuineDoubleCount(index, { showId: 'x', outletId: 'nytimes', url: 'https://a/1', critic1: 'Critic A', critic2: 'Critic C' }, fakeNormalizers), false);
  assert.equal(isGenuineDoubleCount(index, { showId: 'x', outletId: 'nytimes', url: 'https://a/1', critic1: 'Critic B', critic2: 'Critic C' }, fakeNormalizers), false);
});

test('c2-live-scored-check: the same critic name compared against itself is never a double-count', () => {
  const index = buildLiveScoredIndex([
    { showId: 'x', outletId: 'nytimes', url: 'https://a/1', criticName: 'Critic A' },
  ], fakeNormalizers);
  assert.equal(isGenuineDoubleCount(index, { showId: 'x', outletId: 'nytimes', url: 'https://a/1', critic1: 'Critic A', critic2: 'Critic A' }, fakeNormalizers), false);
});

// audit-review-contamination.js prints two different GATE line shapes: the
// failing form ("N cross-market leak(s) ... + N strict hit(s) vs floor N")
// and the passing form ("0 cross-market leaks, N strict hit(s) ≤ floor N").
// Tolerates the "(s)" suffix / "+"/"," separator being optional so both parse.
function parseGateLine(out) {
  const m = out.match(/GATE:\s*(\d+)\s*cross-market leaks?(?:\(s\))?.*?(\d+)\s*strict hit\(s\)\s*(?:vs|≤)\s*floor\s*(\d+)/);
  return m ? { leaks: Number(m[1]), strict: Number(m[2]), floor: Number(m[3]) } : null;
}

function run(argv) {
  try {
    return { out: execFileSync('node', [AUDIT, ...argv], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 }), code: 0 };
  } catch (err) {
    return { out: `${err.stdout || ''}${err.stderr || ''}`, code: err.status ?? 1 };
  }
}

const corpusPresent = fs.existsSync(CORPUS) && fs.readdirSync(CORPUS).length > 10;

test('live corpus: --gate\'s strict-hit count matches --json\'s own countStrictHits total', { skip: !corpusPresent && 'review-texts corpus not checked out' }, () => {
  const gateRun = run(['--gate']);
  const gate = parseGateLine(gateRun.out);
  assert.ok(gate, `could not parse the GATE line from --gate output:\n${gateRun.out}`);

  const jsonRun = run(['--json']);
  const parsed = JSON.parse(jsonRun.out);
  const expectedStrict = countStrictHits(parsed.hits);

  assert.equal(gate.strict, expectedStrict, '--gate\'s printed strict-hit count must match countStrictHits() over the same scan — single source of truth (BRO-65)');
  assert.equal(gate.leaks, parsed.hits.A_cross_market.length);
});

// BRO-74 regression: the C2 detector must never report a URL-collision pair
// that isn't actually double-counted in the live rebuild output right now.
// Before this fix, C2 decided "already handled" from a static field
// (duplicateOf) that missed duplicateTextOf — the field
// dedupe-same-url-bylines.js writes on the loser of a same-URL pair — so an
// already-deduped pair (duplicateTextOf set, single scored entry) kept
// surfacing forever (the 7, later 11, cases named in BRO-74). The fix gates
// every hit on data/reviews.json ground truth (c2-live-scored-check.js)
// instead of any duplicate-pointer field. This test re-derives that ground
// truth by calling the REAL exported lib function against reviews.json read
// independently here (not by trusting the script's own reported hit list),
// so it's a real regression guard, not a tautology.
const reviewsJsonPresent = fs.existsSync(path.join(REPO, 'data', 'reviews.json'));

test('live corpus: every C2_url_multi_critic hit is a genuine 2+-critic double-count in reviews.json',
  { skip: (!corpusPresent && 'review-texts corpus not checked out') || (!reviewsJsonPresent && 'data/reviews.json not present') },
  () => {
    const jsonRun = run(['--json', '--classes', 'C2']);
    const parsed = JSON.parse(jsonRun.out);
    const hits = parsed.hits.C2_url_multi_critic;

    const reviewsData = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'reviews.json'), 'utf-8'));
    const liveScored = buildLiveScoredIndex(Object.values(reviewsData.reviews || {}), { normalizeOutlet, normalizeUrl, normalizeCritic });

    for (const h of hits) {
      const dir = path.join(CORPUS, h.showId);
      const f1 = JSON.parse(fs.readFileSync(path.join(dir, h.file1), 'utf-8'));
      const outletId = f1.outletId || h.file1.split('--')[0];
      assert.ok(isGenuineDoubleCount(liveScored, { showId: h.showId, outletId, url: f1.url, critic1: h.critic1, critic2: h.critic2 }, { normalizeOutlet, normalizeUrl, normalizeCritic }),
        `${h.showId} ${h.file1} (${h.critic1}) vs ${h.file2} (${h.critic2}): reviews.json does not carry BOTH as live distinct critics for this URL — C2 should not have flagged it`);
    }
  });
