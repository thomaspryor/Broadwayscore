// #1146/#1156 — an auto-clear path (allowEarlyDate/allowCrossMarket bypass,
// UK-URL/registry-region heuristic) must never silently strip wrongProduction/
// wrongShow off a file the LLM ensemble already unanimously rejected on
// content grounds. See scripts/lib/wrong-production-autoclear.js
// (hasEnsembleRejection) and scripts/lib/autoclear-vs-ensemble-scan.js for
// the full defect writeup.
//
// Two layers, cheapest first:
//   1. unit — the decision functions refuse to clear when an ensemble
//      rejection is present, even when every other override condition holds
//   2. corpus — 0 files on disk where an auto-clear overrode a live
//      (non-stale, non-human-overridden) unanimous ensemble verdict, for
//      BOTH wrongProduction and wrongShow
//
// Run: node --test scripts/lib/autoclear-vs-ensemble.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  shouldAutoClearWrongProduction,
  shouldAutoClearWrongShow,
  hasEnsembleRejection,
} = require('./wrong-production-autoclear.js');
const { scanAutoclearVsEnsembleViolations } = require('./autoclear-vs-ensemble-scan.js');

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts');
// Local affordance only — CI sets this on the job that runs
// checkout-review-texts, so "the test was green" can never mean "the corpus
// layer silently skipped" (same policy as review-guards.explain.test.mjs).
const REQUIRE_CORPUS = process.env.REQUIRE_REVIEW_CORPUS === '1';

test('hasEnsembleRejection matches only rejectionReason + rejectedBy=ensemble-scoreability-check', () => {
  assert.strictEqual(hasEnsembleRejection({ rejectionReason: 'wrong_production', rejectedBy: 'ensemble-scoreability-check' }, 'wrong_production'), true);
  assert.strictEqual(hasEnsembleRejection({ rejectionReason: 'wrong_production', rejectedBy: 'ensemble-scoreability-check' }, 'wrong_show'), false);
  assert.strictEqual(hasEnsembleRejection({ rejectionReason: 'wrong_production', rejectedBy: 'manual-review' }, 'wrong_production'), false);
  assert.strictEqual(hasEnsembleRejection({ rejectionReason: 'wrong_production' }, 'wrong_production'), false);
  assert.strictEqual(hasEnsembleRejection(null, 'wrong_production'), false);
});

test('shouldAutoClearWrongProduction refuses to clear a unanimous ensemble wrong_production verdict', () => {
  const data = {
    wrongProduction: true,
    allowCrossMarket: true, // the show-level override that would otherwise bypass the flag
    rejectionReason: 'wrong_production',
    rejectedBy: 'ensemble-scoreability-check',
  };
  assert.strictEqual(shouldAutoClearWrongProduction(data), false);
  // Sanity: without the ensemble rejection, the same allowCrossMarket bypass clears normally.
  assert.strictEqual(shouldAutoClearWrongProduction({ wrongProduction: true, allowCrossMarket: true }), true);
});

test('shouldAutoClearWrongShow refuses to clear a unanimous ensemble wrong_show verdict', () => {
  const data = {
    wrongShow: true,
    allowEarlyDate: true,
    rejectionReason: 'wrong_show',
    rejectedBy: 'ensemble-scoreability-check',
  };
  assert.strictEqual(shouldAutoClearWrongShow(data), false);
  assert.strictEqual(shouldAutoClearWrongShow({ wrongShow: true, allowEarlyDate: true }), true);
});

test('corpus: 0 files where an auto-clear overrode a live unanimous ensemble verdict (wrongProduction + wrongShow)', (t) => {
  let corpusEntries = 0;
  try { corpusEntries = fs.readdirSync(REVIEW_TEXTS_DIR).length; } catch { corpusEntries = 0; }
  if (corpusEntries === 0) {
    // Same policy as review-guards.explain.test.mjs: a missing/empty corpus is
    // a hard failure under REQUIRE_REVIEW_CORPUS=1 (the CI job that runs
    // checkout-review-texts), and a local skip everywhere else.
    assert.ok(
      !REQUIRE_CORPUS,
      `REQUIRE_REVIEW_CORPUS=1 but no corpus at ${REVIEW_TEXTS_DIR} — the review-texts checkout did not land, so this layer would have silently skipped. Fix the checkout rather than unsetting the flag.`
    );
    t.skip(`no corpus at ${REVIEW_TEXTS_DIR} (run ./scripts/setup-local-data.sh, or set REVIEW_TEXTS_DIR)`);
    return;
  }

  const { scanned, wpViolations, wsViolations } = scanAutoclearVsEnsembleViolations({ reviewTextsDir: REVIEW_TEXTS_DIR });
  assert.ok(scanned > 0, `scanned 0 files in a non-empty ${REVIEW_TEXTS_DIR} — scan logic is broken`);

  const describe = (v) => `${v.showId}/${v.file} (${v.breadcrumb})`;
  assert.deepStrictEqual(
    wpViolations.map(describe), [],
    `${wpViolations.length} wrongProduction auto-clear-vs-ensemble violation(s) — see scripts/audit-autoclear-vs-ensemble.js --fix`
  );
  assert.deepStrictEqual(
    wsViolations.map(describe), [],
    `${wsViolations.length} wrongShow auto-clear-vs-ensemble violation(s) — see scripts/audit-autoclear-vs-ensemble.js --fix`
  );
});
