// #1146/#1156 — an auto-clear path (allowEarlyDate/allowCrossMarket bypass,
// UK-URL/registry-region heuristic) must never silently strip wrongProduction/
// wrongShow off a file the LLM ensemble already unanimously rejected on
// content grounds. See scripts/lib/wrong-production-autoclear.js
// (hasEnsembleConsensus) and scripts/lib/autoclear-vs-ensemble-scan.js for
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
  hasEnsembleConsensus,
} = require('./wrong-production-autoclear.js');
const { scanAutoclearVsEnsembleViolations } = require('./autoclear-vs-ensemble-scan.js');

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts');
// Local affordance only — CI sets this on the job that runs
// checkout-review-texts, so "the test was green" can never mean "the corpus
// layer silently skipped" (same policy as review-guards.explain.test.mjs).
const REQUIRE_CORPUS = process.env.REQUIRE_REVIEW_CORPUS === '1';

test('hasEnsembleConsensus matches only rejectionReason + rejectedBy=ensemble-scoreability-check + 2+ distinct model tags', () => {
  const reasoning = 'claude: wrong production; openai: also wrong production';
  assert.strictEqual(hasEnsembleConsensus({ rejectionReason: 'wrong_production', rejectedBy: 'ensemble-scoreability-check', rejectionReasoning: reasoning }, 'wrong_production'), true);
  assert.strictEqual(hasEnsembleConsensus({ rejectionReason: 'wrong_production', rejectedBy: 'ensemble-scoreability-check', rejectionReasoning: reasoning }, 'wrong_show'), false);
  assert.strictEqual(hasEnsembleConsensus({ rejectionReason: 'wrong_production', rejectedBy: 'manual-review', rejectionReasoning: reasoning }, 'wrong_production'), false);
  assert.strictEqual(hasEnsembleConsensus({ rejectionReason: 'wrong_production', rejectedBy: 'ensemble-scoreability-check' }, 'wrong_production'), false);
  assert.strictEqual(hasEnsembleConsensus(null, 'wrong_production'), false);
});

test('shouldAutoClearWrongProduction refuses to clear a unanimous ensemble wrong_production verdict', () => {
  const data = {
    wrongProduction: true,
    allowCrossMarket: true, // the show-level override that would otherwise bypass the flag
    rejectionReason: 'wrong_production',
    rejectedBy: 'ensemble-scoreability-check',
    rejectionReasoning: 'claude: wrong production; openai: also wrong production',
  };
  assert.strictEqual(shouldAutoClearWrongProduction(data), false);
  // Sanity: without the ensemble rejection, the same allowCrossMarket bypass clears normally.
  assert.strictEqual(shouldAutoClearWrongProduction({ wrongProduction: true, allowCrossMarket: true }), true);
});

// BRO-2841 follow-up: a review-guard review of the initial fix (which only
// exempted shouldAutoClearWrongProductionUkDualMarket) found this SIBLING path
// completely unprotected — it runs in the same rebuild pass on the same data
// object (rebuild-all-reviews.js), is gated on allowEarlyDate/allowCrossMarket
// (plausible on exactly the cross-market shows this card is about), and never
// read wrongProductionNote at all. Before the fix, a file carrying
// adjudicate-review-queue.js's "Auto-adjudicated: ..." note but no
// wrongProductionReason would be silently cleared HERE, undoing the
// adjudicator's verdict through a different call site than the one BRO-2841
// originally reported. The systemic fix — adjudicate-review-queue.js now also
// sets wrongProductionReason alongside wrongProductionNote — closes this for
// free, since every auto-clear predicate in this file already gates on
// wrongProductionReason. This test pins that this path specifically is
// protected, using the adjudicator's actual value shape.
test('shouldAutoClearWrongProduction refuses to clear an adjudicated verdict (BRO-2841 sibling-path regression)', () => {
  const adjudicated = {
    wrongProduction: true,
    allowCrossMarket: true,
    wrongProductionNote: 'Auto-adjudicated: national-tour. The review explicitly states this is a performance at the Sheffield Lyceum',
    wrongProductionReason: 'contamination-adjudicated: national-tour',
  };
  assert.strictEqual(shouldAutoClearWrongProduction(adjudicated), false);
  // The note ALONE (the shape every file the adjudicator wrote BEFORE this
  // fix landed carries — no wrongProductionReason) must ALSO protect this
  // path: shouldAutoClearWrongProduction checks hasAdjudicatedNote
  // specifically so historical corpus files aren't left exposed just because
  // they predate the reason-field fix.
  const { wrongProductionReason, ...noteOnly } = adjudicated;
  assert.strictEqual(shouldAutoClearWrongProduction(noteOnly), false);
  // Sanity: an ordinary, non-adjudicated cross-market override with NEITHER
  // field still clears normally — the fix must not go blanket-inert.
  const { wrongProductionNote, ...neither } = noteOnly;
  assert.strictEqual(shouldAutoClearWrongProduction(neither), true);
});

test('shouldAutoClearWrongShow refuses to clear a unanimous ensemble wrong_show verdict', () => {
  const data = {
    wrongShow: true,
    allowEarlyDate: true,
    rejectionReason: 'wrong_show',
    rejectedBy: 'ensemble-scoreability-check',
    rejectionReasoning: 'claude: wrong show; openai: also wrong show',
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
