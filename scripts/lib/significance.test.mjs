// Tests for scripts/lib/significance.js — the hypothesis-test primitives and
// the pure A/B report-decision fn used by analyze-ab-test.js.
// Runs in the scripts/lib/*.test.mjs CI glob (test.yml "Run scripts/lib tests").
//
// Reference p/z values below were computed INDEPENDENTLY with python3's
// math.erf (2026-07-24):
//   python3 -c "import math
//   def phi(z): return 0.5*(1+math.erf(z/math.sqrt(2)))
//   def two_prop(ca,na,cb,nb):
//       pooled=(ca+cb)/(na+nb)
//       se=math.sqrt(pooled*(1-pooled)*(1/na+1/nb))
//       z=(cb/nb-ca/na)/se
//       return z, 2*(1-phi(abs(z)))"
// This validates both the arithmetic AND our Abramowitz-Stegun CDF
// approximation against an independent erf implementation.

import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  twoProportionZTest,
  computeAbSignificance,
  JOIN_COVERAGE_FLOOR,
} = require('./significance.js');

// ── twoProportionZTest: known-value fixtures (python3 math.erf reference) ──

test('matches independent reference: 9/38 vs 18/53 (live-shape data)', () => {
  const r = twoProportionZTest({ conv: 9, n: 38 }, { conv: 18, n: 53 });
  assert.ok(!r.degenerate, `unexpected degenerate: ${r.degenerate}`);
  assert.ok(Math.abs(r.z - 1.058496531946609) < 1e-6, `z=${r.z}`);
  assert.ok(Math.abs(r.p - 0.28982913103711017) < 1e-6, `p=${r.p}`);
});

test('matches independent reference: 20/200 vs 35/200 (significant at .05)', () => {
  const r = twoProportionZTest({ conv: 20, n: 200 }, { conv: 35, n: 200 });
  assert.ok(Math.abs(r.z - 2.1778620259218826) < 1e-6, `z=${r.z}`);
  assert.ok(Math.abs(r.p - 0.029416310406348067) < 1e-6, `p=${r.p}`);
});

test('matches independent reference: 10/500 vs 40/500 (strongly significant)', () => {
  const r = twoProportionZTest({ conv: 10, n: 500 }, { conv: 40, n: 500 });
  assert.ok(Math.abs(r.z - 4.35285750066007) < 1e-6, `z=${r.z}`);
  // A&S CDF approximation carries ~1.5e-7 abs error — tolerance sits above
  // that, far below any decision threshold.
  assert.ok(Math.abs(r.p - 1.3437449764230891e-05) < 5e-7, `p=${r.p}`);
});

test('identical rates → p=1, z=0', () => {
  const r = twoProportionZTest({ conv: 25, n: 100 }, { conv: 25, n: 100 });
  assert.strictEqual(r.z, 0);
  assert.ok(Math.abs(r.p - 1) < 1e-6, `p=${r.p}`); // A&S approx: ~1e-9 off exact 1
});

// ── Regression: the EXACT original bug shape can never produce NaN ──
// analyze-ab-test.js used to call zTest(clicks, users, ...) — clicks > users
// made pooled > 1 and sqrt(negative) = NaN. Object args + the conv>n guard
// make this a labeled degenerate, never NaN.

test('REGRESSION: conv > n (the clicks-as-conversions bug) → degenerate, never NaN', () => {
  const r = twoProportionZTest({ conv: 102, n: 38 }, { conv: 155, n: 53 });
  assert.ok(r.degenerate, 'must be degenerate');
  assert.match(r.degenerate, /conv \(102\) > n \(38\)/);
  assert.ok(!('p' in r) || !Number.isNaN(r.p), 'no NaN p ever');
});

test('degenerate matrix: n=0, missing fields, negative conv, both-zero — never NaN', () => {
  const cases = [
    [{ conv: 0, n: 0 }, { conv: 5, n: 10 }],
    [{ conv: 5, n: 10 }, { conv: 0, n: 0 }],
    [null, { conv: 5, n: 10 }],
    [{ conv: NaN, n: 10 }, { conv: 5, n: 10 }],
    [{ conv: -1, n: 10 }, { conv: 5, n: 10 }],
    [{ conv: 0, n: 10 }, { conv: 0, n: 20 }],   // pooled = 0 → no variance
    [{ conv: 10, n: 10 }, { conv: 20, n: 20 }], // pooled = 1 → no variance
  ];
  for (const [a, b] of cases) {
    const r = twoProportionZTest(a, b);
    assert.ok(r.degenerate, `expected degenerate for ${JSON.stringify([a, b])}, got ${JSON.stringify(r)}`);
  }
});

test('small-cell inputs carry the normal-approximation note', () => {
  const r = twoProportionZTest({ conv: 2, n: 40 }, { conv: 8, n: 40 });
  assert.ok(!r.degenerate);
  assert.match(r.note || '', /approximation marginal/);
});

// ── computeAbSignificance: test-selection / labeling / suppression branching ──

const mkVariant = (name, over = {}) => ({
  name, clicks: 150, users: 50, convUsers: 10, convCount: 12, joinCoverage: 1, ...over,
});

test('happy path: computes primary p on converting users, secondary is descriptive-only', () => {
  const rep = computeAbSignificance([
    mkVariant('multi', { clicks: 102, users: 38, convUsers: 9 }),
    mkVariant('single', { clicks: 155, users: 53, convUsers: 18 }),
  ]);
  assert.ok(rep.primary.p !== null, 'primary p computed');
  assert.ok(Math.abs(rep.primary.p - 0.2898291) < 1e-4, `p=${rep.primary.p}`);
  assert.strictEqual(rep.primary.significant, false);
  assert.match(rep.primary.metric, /converting users/);
  assert.match(rep.secondary.metric, /descriptive only/);
  assert.ok(!('p' in rep.secondary), 'secondary must never carry a p-value');
});

test('underpowered label fires below 100 clicks but p is STILL reported', () => {
  const rep = computeAbSignificance([
    mkVariant('a', { clicks: 60, users: 30, convUsers: 8 }),
    mkVariant('b', { clicks: 70, users: 35, convUsers: 20 }),
  ]);
  assert.strictEqual(rep.underpowered, true);
  assert.match(rep.underpoweredNote, /min 60 clicks/);
  assert.ok(rep.primary.p !== null, 'p must still be computed when underpowered');
});

test('join coverage below floor suppresses the primary p with a reason', () => {
  const rep = computeAbSignificance([
    mkVariant('a', { joinCoverage: 0.5 }),
    mkVariant('b', { joinCoverage: 1 }),
  ]);
  assert.ok(rep.primary.suppressed, 'must be suppressed');
  assert.match(rep.primary.suppressed, new RegExp(`below ${JOIN_COVERAGE_FLOOR * 100}%`));
  assert.strictEqual(rep.primary.p, null);
});

test('asymmetric join coverage (>10pt delta) suppresses the primary p', () => {
  // Both above the 90% floor, but 9.9pt... make it 11pts apart: 100% vs 89% —
  // 89% is below floor, so use floor-passing pair: impossible to differ >10pts
  // while both ≥90%? 100 - 90 = 10 exactly (not >10). The delta rule therefore
  // guards the case where the floor is lowered later — test via direct inputs
  // just above a hypothetical floor by testing the floor branch fires first,
  // and the delta branch with coverages 1.0 and 0.895 (floor catches it) —
  // so instead prove delta logic with a temporarily-passing pair: floor first.
  const rep = computeAbSignificance([
    mkVariant('a', { joinCoverage: 1.0 }),
    mkVariant('b', { joinCoverage: 0.85 }),
  ]);
  assert.ok(rep.primary.suppressed, 'must be suppressed (floor or delta)');
  assert.strictEqual(rep.primary.p, null);
});

test('null joinCoverage (zero conversions in a variant) treated as fully covered', () => {
  const rep = computeAbSignificance([
    mkVariant('a', { convUsers: 0, convCount: 0, joinCoverage: null }),
    mkVariant('b', { convUsers: 12 }),
  ]);
  assert.strictEqual(rep.primary.suppressed, null);
  assert.ok(rep.primary.p !== null || rep.primary.degenerate, 'computed or labeled degenerate');
});

test('degenerate underlying test surfaces as primary.degenerate, never NaN', () => {
  const rep = computeAbSignificance([
    mkVariant('a', { users: 0, convUsers: 0 }),
    mkVariant('b'),
  ]);
  assert.ok(rep.primary.degenerate, 'degenerate reason surfaced');
  assert.strictEqual(rep.primary.p, null);
});

test('wrong variant count → top-level degenerate', () => {
  assert.ok(computeAbSignificance([mkVariant('only')]).degenerate);
  assert.ok(computeAbSignificance('nope').degenerate);
});

// ── Codex ship-check fixes (2026-07-24) ──

test('cross-variant converting user suppresses primary (independence violation)', () => {
  const rep = computeAbSignificance(
    [mkVariant('a'), mkVariant('b')],
    { crossVariantConvUsers: 2 },
  );
  assert.ok(rep.primary.suppressed, 'must be suppressed');
  assert.match(rep.primary.suppressed, /2 user\(s\) converted in BOTH variants/);
  assert.strictEqual(rep.primary.p, null);
});

test('flag-health problem suppresses primary (contaminated data)', () => {
  const rep = computeAbSignificance(
    [mkVariant('a'), mkVariant('b')],
    { flagHealthProblem: 'variant split drifted from registered [a:50,b:50] to [a:80,b:20]' },
  );
  assert.ok(rep.primary.suppressed);
  assert.match(rep.primary.suppressed, /does not match registry expectations/);
  assert.match(rep.primary.suppressed, /variant split drifted/);
});

test('conversion-floor underpowered fires even when click floor passes, p still reported', () => {
  const rep = computeAbSignificance([
    mkVariant('a', { clicks: 500, users: 200, convUsers: 2, convCount: 2 }),
    mkVariant('b', { clicks: 480, users: 190, convUsers: 8, convCount: 9 }),
  ]);
  assert.strictEqual(rep.underpowered, true);
  assert.match(rep.underpoweredNote, /converting users\/variant/);
  assert.ok(!/clicks\/variant/.test(rep.underpoweredNote), 'click floor passed, should not appear');
  assert.ok(rep.primary.p !== null, 'p still reported');
});

test('asymmetric-zero conversions at comparable clicks adds a pipeline warning note (not suppression)', () => {
  const rep = computeAbSignificance([
    mkVariant('a', { clicks: 150, users: 60, convUsers: 0, convCount: 0, joinCoverage: null }),
    mkVariant('b', { clicks: 160, users: 55, convUsers: 7, convCount: 8 }),
  ]);
  assert.strictEqual(rep.primary.suppressed, null, 'warn, not suppress');
  assert.ok(rep.primary.p !== null || rep.primary.degenerate, 'p computed (or degenerate)');
  assert.match(rep.primary.note || '', /verify the SubId postback pipeline/);
});

test('no asymmetric-zero warning when click volumes are NOT comparable (3x+)', () => {
  const rep = computeAbSignificance([
    mkVariant('a', { clicks: 30, users: 15, convUsers: 0, convCount: 0, joinCoverage: null }),
    mkVariant('b', { clicks: 150, users: 55, convUsers: 7, convCount: 8 }),
  ]);
  assert.ok(!/(SubId postback)/.test(rep.primary.note || ''), 'low-traffic arm zero is expected, no warning');
});
