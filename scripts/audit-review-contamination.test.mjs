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
