/**
 * Self-contradictory clear-breadcrumb detector (tasks #1020 / #1022 / #1023).
 *
 * Requires the REAL functions (CLAUDE.md §15) — no logic is restated here, so a
 * production change to SELF_CLEAR_PAIRS or the truthiness predicate fails these.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  detectSelfContradictoryClear,
  detectAllSelfContradictoryClears,
  retractStaleClearBreadcrumb,
  hasClearBreadcrumbValue,
  SELF_CLEAR_PAIRS,
} = require('../../scripts/lib/flag-contradiction.js');

test('a record with two contradictions is fully resolved in ONE pass', () => {
  // Returning only the first pair would make --fix need repeated runs to
  // converge while reporting partial progress in between.
  const file = {
    wrongProduction: true,
    wrongProductionAutoCleared: 'rebuild: allowEarlyDate bypasses wrongProduction',
    wrongAttribution: true,
    crossOutletVerified: true,
  };
  const hits = detectAllSelfContradictoryClears(file);
  assert.equal(hits.length, 2, 'both pairs must be reported');

  for (const hit of hits) retractStaleClearBreadcrumb(file, hit);
  assert.deepEqual(detectAllSelfContradictoryClears(file), [], 'one pass must converge');
  assert.equal(file.wrongProduction, true);
  assert.equal(file.wrongAttribution, true);
  assert.deepEqual(
    file.clearBreadcrumbRetractedFields,
    ['crossOutletVerified', 'wrongProductionAutoCleared'],
    'the stamp lists exactly the fields actually removed, across both pairs',
  );
});

test('the retraction stamp does NOT authorize deleting a field it does not name', () => {
  // A blanket "stamp exists" exception would be a standing bypass: one
  // retraction would thereafter bless losing any other protected field.
  const { isIntentionalClear } = require('../../scripts/lib/review-write-guard.js');

  const file = {
    wrongProduction: true,
    wrongProductionAutoCleared: 'rebuild: allowEarlyDate bypasses wrongProduction',
  };
  const committed = { ...file, crossOutletVerified: true };
  retractStaleClearBreadcrumb(file, detectSelfContradictoryClear(file));

  assert.equal(isIntentionalClear('wrongProductionAutoCleared', file, committed), true);
  assert.equal(
    isIntentionalClear('crossOutletVerified', file, committed), false,
    'a wrongProduction retraction must not bless losing crossOutletVerified',
  );
});

test('hasClearBreadcrumbValue accepts both written shapes', () => {
  // The corpus carries 445 boolean and 283 string stamps. A reader testing
  // `=== true` misses the string majority — that was the live bug in
  // scripts/lib/manual-review-fields.js.
  assert.equal(hasClearBreadcrumbValue(true), true);
  assert.equal(hasClearBreadcrumbValue('rebuild: allowEarlyDate bypasses wrongProduction'), true);
  assert.equal(hasClearBreadcrumbValue(false), false);
  assert.equal(hasClearBreadcrumbValue(undefined), false);
  assert.equal(hasClearBreadcrumbValue(null), false);
  assert.equal(hasClearBreadcrumbValue(''), false);
  assert.equal(hasClearBreadcrumbValue('   '), false);
});

test('wrongProduction + auto-clear stamp is a contradiction in both shapes (#1020)', () => {
  for (const stamp of [true, 'rebuild: allowCrossMarket bypasses wrongProduction']) {
    const hit = detectSelfContradictoryClear({
      wrongProduction: true,
      wrongProductionAutoCleared: stamp,
    });
    assert.ok(hit, `expected a hit for stamp shape ${typeof stamp}`);
    assert.equal(hit.flag, 'wrongProduction');
    assert.equal(hit.breadcrumb, 'wrongProductionAutoCleared');
  }
});

test('the flag alone, or the breadcrumb alone, is not a contradiction', () => {
  assert.equal(detectSelfContradictoryClear({ wrongProduction: true }), null);
  assert.equal(detectSelfContradictoryClear({ wrongProductionAutoCleared: true }), null);
});

test('wrongShow promotion only contradicts when its own CV now affirms the review (#1022)', () => {
  const affirming = {
    wrongShow: true,
    contentVerificationPromoted: true,
    contentVerification: { isValid: true, wrongArticle: false, wrongProduction: false },
  };
  assert.equal(detectSelfContradictoryClear(affirming).flag, 'wrongShow');

  // Same promotion stamp, but the CV still says the review is wrong — the stamp
  // is provenance, not a retraction, so this must NOT fire.
  const stillWrong = {
    wrongShow: true,
    contentVerificationPromoted: true,
    contentVerification: { isValid: false, wrongArticle: true, wrongProduction: false },
  };
  assert.equal(detectSelfContradictoryClear(stillWrong), null);

  // No CV block at all → nothing to contradict the flag with.
  assert.equal(detectSelfContradictoryClear({
    wrongShow: true, contentVerificationPromoted: true,
  }), null);
});

test('wrongAttribution + crossOutletVerified is a contradiction (#1023)', () => {
  const hit = detectSelfContradictoryClear({
    wrongAttribution: true,
    crossOutletVerified: true,
  });
  assert.equal(hit.flag, 'wrongAttribution');
  assert.equal(hit.task, '#1023');
});

test('a human ruling exempts the file — machine breadcrumbs never re-litigate it', () => {
  assert.equal(detectSelfContradictoryClear({
    wrongProduction: true,
    wrongProductionAutoCleared: true,
    humanReviewScore: 80,
  }), null);
  assert.equal(detectSelfContradictoryClear({
    wrongProduction: true,
    wrongProductionAutoCleared: true,
    humanReviewedWrongProduction: true,
  }), null);
});

test('retraction removes the breadcrumb and its timestamp, never the flag', () => {
  const file = {
    wrongProduction: true,
    wrongProductionNote: 'Date guard: 34d before opening',
    wrongProductionAutoCleared: 'rebuild: allowEarlyDate bypasses wrongProduction',
    wrongProductionAutoClearedAt: '2026-07-11',
  };
  const removed = retractStaleClearBreadcrumb(file, detectSelfContradictoryClear(file));

  assert.deepEqual(removed.sort(), ['wrongProductionAutoCleared', 'wrongProductionAutoClearedAt']);
  assert.equal(file.wrongProduction, true, 'the live verdict must survive');
  assert.equal(file.wrongProductionNote, 'Date guard: 34d before opening', 'flag provenance must survive');
  assert.equal('wrongProductionAutoCleared' in file, false);
  assert.equal('wrongProductionAutoClearedAt' in file, false);
  // Idempotent: a second pass finds nothing left to do.
  assert.equal(detectSelfContradictoryClear(file), null);
});

test('a retraction survives the push-time restore (would otherwise be a no-op)', () => {
  // wrongProductionAutoCleared(+At) and crossOutletVerified are PROTECTED_FIELDS.
  // Deleting a protected field reads as data loss unless isIntentionalClear()
  // recognizes a breadcrumb — that is why the stale-duplicateOf gate stayed red
  // indefinitely. Pin the contract: the retraction stamp must satisfy it.
  const { isIntentionalClear, PROTECTED_FIELDS } = require('../../scripts/lib/review-write-guard.js');

  for (const breadcrumb of ['wrongProductionAutoCleared', 'crossOutletVerified']) {
    assert.ok(
      PROTECTED_FIELDS.includes(breadcrumb),
      `${breadcrumb} left PROTECTED_FIELDS — this test's premise needs revisiting`,
    );
  }

  const file = {
    wrongProduction: true,
    wrongProductionAutoCleared: 'rebuild: allowEarlyDate bypasses wrongProduction',
    wrongProductionAutoClearedAt: '2026-07-11',
  };
  const committed = { ...file };
  retractStaleClearBreadcrumb(file, detectSelfContradictoryClear(file));

  for (const field of ['wrongProductionAutoCleared', 'wrongProductionAutoClearedAt']) {
    assert.equal(
      isIntentionalClear(field, file, committed), true,
      `restore would resurrect ${field}, making --fix a permanent no-op`,
    );
  }

  // Without the stamp the same emptiness must still be protected as data loss.
  const unstamped = { wrongProduction: true };
  assert.equal(isIntentionalClear('wrongProductionAutoCleared', unstamped, committed), false);
});

test('every declared pair is reachable by the detector', () => {
  // Guards against a table row that can never fire (a typo'd field name would
  // otherwise sit in SELF_CLEAR_PAIRS looking like coverage it does not provide).
  assert.ok(SELF_CLEAR_PAIRS.length >= 3);
  for (const pair of SELF_CLEAR_PAIRS) {
    const file = { [pair.flag]: true, [pair.breadcrumb]: true };
    if (pair.flag === 'wrongShow') {
      file.contentVerification = { isValid: true, wrongArticle: false, wrongProduction: false };
    }
    const hit = detectSelfContradictoryClear(file);
    assert.ok(hit, `pair ${pair.flag}+${pair.breadcrumb} never fires`);
    assert.equal(hit.flag, pair.flag);
  }
});

test('non-object input is handled without throwing', () => {
  assert.equal(detectSelfContradictoryClear(null), null);
  assert.equal(detectSelfContradictoryClear(undefined), null);
  assert.equal(detectSelfContradictoryClear('nope'), null);
  assert.deepEqual(retractStaleClearBreadcrumb(null, null), []);
});
