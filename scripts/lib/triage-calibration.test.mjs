// Calibration guard for the autonomous-loop triage (S1-T5).
//
// The LLM half of calibration is recorded by `node scripts/autonomous-calibrate.js`
// (live Sonnet, ~20 calls) into tests/fixtures/triage-calibration.json. This
// test is CI-safe: it re-runs only the PURE layer live and holds the recorded
// results to the sprint bars. After ANY buildTriagePrompt change, re-run the
// calibrator and commit the updated fixture — this test fails on stale bars.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { isCardEligible, DENY_TAGS, EXCLUDED_CATEGORIES } = require('./autonomous-eligibility.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'tests', 'fixtures', 'triage-calibration.json'), 'utf8'));

const isAbsolute = c =>
  (c.tags || []).some(t => DENY_TAGS.has(String(t).toLowerCase())) ||
  EXCLUDED_CATEGORIES.has(String(c.category || '').toLowerCase());

test('fixture shape: two real cohorts + synthetic eligible cards, all labeled and recorded', () => {
  assert.ok(fixture.cards.length >= 30, `expected ≥30 cards, got ${fixture.cards.length}`);
  assert.ok(fixture.cards.filter(c => c.status === 'Done').length >= 15, '≥15 recently-Done cards');
  assert.ok(fixture.cards.filter(c => c.status === 'Not started').length >= 15, '≥15 backlog cards');
  assert.ok(fixture.cards.filter(c => c.synthetic).length >= 3, '≥3 synthetic Tier-1 cards');
  for (const c of fixture.cards) {
    assert.ok(c.golden && typeof c.golden.eligible === 'boolean', `${c.name}: golden label missing`);
    assert.ok(c.recorded, `${c.name}: no recorded verdict — run node scripts/autonomous-calibrate.js`);
  }
});

test('absolute exclusions hold at 100% — pure layer, recomputed live', () => {
  const absolutes = fixture.cards.filter(isAbsolute);
  assert.ok(absolutes.length >= 10, `corpus should carry ≥10 absolute-exclusion cards, got ${absolutes.length}`);
  for (const c of absolutes) {
    assert.equal(isCardEligible(c).eligible, false, `${c.name} must be refused by the pre-filter`);
    assert.notEqual(c.recorded.eligible, true, `${c.name} was recorded eligible — absolute exclusion violated`);
    assert.equal(c.golden.eligible, false, `${c.name} golden label contradicts an absolute exclusion`);
  }
});

test('recorded eligibility never widens beyond golden', () => {
  for (const c of fixture.cards) {
    if (c.recorded.eligible === true) {
      assert.equal(c.golden.eligible, true, `${c.name}: recorded eligible but golden says no`);
    }
  }
});

test('calibration bars: size ≥80%, eligibility ≥90%, no triage failures', () => {
  const s = fixture.lastCalibration;
  assert.ok(s, 'no lastCalibration summary — run node scripts/autonomous-calibrate.js');
  assert.ok(s.sizeAgreement.of >= 15, `size measured on ≥15 cards, got ${s.sizeAgreement.of}`);
  assert.ok(s.sizeAgreement.pct >= 80, `size agreement ${s.sizeAgreement.pct}% < 80% — iterate buildTriagePrompt and re-record`);
  assert.ok(s.eligibilityAgreement.pct >= 90, `eligibility agreement ${s.eligibilityAgreement.pct}% < 90%`);
  assert.equal(s.absoluteExclusions.violations.length, 0, `absolute-exclusion violations: ${s.absoluteExclusions.violations.join(', ')}`);
  assert.equal(s.triageFailures.length, 0, `triage failures in calibration: ${s.triageFailures.join(', ')}`);
});

test('the eligible path exists: synthetic Tier-1 cards were recorded attemptable', () => {
  const synthetic = fixture.cards.filter(c => c.synthetic);
  for (const c of synthetic) {
    assert.equal(c.recorded.decision, 'attempt', `${c.name}: expected decision "attempt", got "${c.recorded.decision}"`);
  }
});
