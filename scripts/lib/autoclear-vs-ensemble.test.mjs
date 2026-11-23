// LIVE-DATA-LANE: reads data/review-texts (read by the test). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
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
  shouldAutoClearDatelessRevival,
  hasEnsembleConsensus,
} = require('./wrong-production-autoclear.js');
const autoclear = require('./wrong-production-autoclear.js');
const { scanAutoclearVsEnsembleViolations, classifyAutoclearVsEnsemble } = require('./autoclear-vs-ensemble-scan.js');

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

// BRO-3343: shouldAutoClearStaleDateGuard shipped with no ensemble guard and
// nothing caught it. Every exported shouldAutoClear* predicate must consult
// hasEnsembleConsensus, so the next new predicate cannot skip it either.
test('every exported shouldAutoClear* predicate consults hasEnsembleConsensus', () => {
  const names = Object.keys(autoclear).filter((k) => /^shouldAutoClear/.test(k) && typeof autoclear[k] === 'function');
  assert.ok(names.length >= 9, `expected the full predicate family, got ${names.join(', ')}`);
  const missing = names.filter((k) => !autoclear[k].toString().includes('hasEnsembleConsensus('));
  assert.deepStrictEqual(missing, []);
});

test('shouldAutoClearStaleDateGuard refuses to clear a unanimous ensemble verdict even when the date is back in-window (BRO-3343)', () => {
  const base = { wrongProduction: true, wrongProductionNote: 'Pre-opening guard: pre-window date' };
  assert.strictEqual(autoclear.shouldAutoClearStaleDateGuard(base, { nowInWindow: true }), true);
  const ensemble = {
    ...base,
    rejectionReason: 'wrong_production',
    rejectedBy: 'ensemble-scoreability-check',
    rejectionReasoning: 'claude: wrong production; openai: also wrong production',
  };
  assert.strictEqual(autoclear.shouldAutoClearStaleDateGuard(ensemble, { nowInWindow: true }), false);
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

// BRO-3328: much-ado-about-nothing-2026's london-theatre--marianka-swain.json
// had a live unanimous ensemble wrong_production rejection restored the
// moment the show gained a usable date — shouldAutoClearDatelessRevival was
// the one sibling auto-clear predicate in this file with no hasEnsembleConsensus
// guard. Pins that it now refuses, while still honoring an explicit human
// override even over an ensemble verdict (this function's original contract).
test('shouldAutoClearDatelessRevival refuses to clear a unanimous ensemble wrong_production verdict, but a human override still wins', () => {
  const ensembleRejected = {
    wrongProduction: true,
    wrongProductionNote: 'Dateless revival guard: no usable date on a recent revival title',
    rejectionReason: 'wrong_production',
    rejectedBy: 'ensemble-scoreability-check',
    rejectionReasoning: 'claude: wrong production; openai: also wrong production',
  };
  assert.strictEqual(shouldAutoClearDatelessRevival(ensembleRejected, { hasUsableDate: true }), false);
  // Sanity: without the ensemble rejection, gaining a usable date still clears normally.
  const { rejectionReason, rejectedBy, rejectionReasoning, ...noEnsemble } = ensembleRejected;
  assert.strictEqual(shouldAutoClearDatelessRevival(noEnsemble, { hasUsableDate: true }), true);
  // A human override always wins, even over a live ensemble verdict.
  assert.strictEqual(
    shouldAutoClearDatelessRevival({ ...ensembleRejected, wrongProductionManualClear: true }, { hasUsableDate: false }),
    true
  );
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

// BRO-7906: the self-release predicates (not named shouldAutoClear*) cleared
// wrongProduction under a live ensemble verdict because the meta-test above
// only covers the shouldAutoClear* family. Every wrongProduction-releasing
// predicate must refuse a unanimous ensemble verdict.
test('shouldRelease* wrongProduction self-release predicates refuse a unanimous ensemble verdict (BRO-7906)', () => {
  const { shouldReleaseOtherProductionUrl } = require('./other-production-signal.js');
  const { shouldReleasePriorRunRepublish } = require('./prior-run-republish-guard.js');
  const ensemble = {
    rejectionReason: 'wrong_production',
    rejectedBy: 'ensemble-scoreability-check',
    rejectionAgreeCount: 3,
    rejectionReasoning: 'claude: other production; openai: other production',
  };
  const show = { id: 'x', openingDate: '2021-11-14', closingDate: '2022-01-25' };
  const url = { wrongProduction: true, wrongProductionReason: 'other-production-url', url: 'https://example.com/2022/03/16/x/', publishDate: '2022-03-16' };
  assert.strictEqual(shouldReleaseOtherProductionUrl({ ...url, ...ensemble }, show), false);
  assert.strictEqual(shouldReleaseOtherProductionUrl(url, show), true, 'control: releases without a verdict');
  const rep = { wrongProduction: true, wrongProductionReason: 'prior-run-republish', fullText: 'x' };
  assert.strictEqual(shouldReleasePriorRunRepublish({ ...rep, ...ensemble }, show), false);
  assert.strictEqual(shouldReleasePriorRunRepublish(rep, show), true, 'control: releases without a verdict');
});

// BRO-8093 (mexodus NYT, 2026-11-22): the ensemble writer records an Off-Broadway
// wrong_production verdict but never applies the flag (OB carve-out). An earlier
// priorRun auto-clear stamp on the same file then read as a violation and turned
// every land floor red. The writer now stamps rejectionFlagNotApplied='ob-exempt'
// and the scanner exempts exactly that pair.
test('BRO-8093: an OB-exempt (never applied) ensemble verdict is not an autoclear violation', () => {
  const opts = { reason: 'wrong_production', autoClearedField: 'wrongProductionAutoCleared', flagField: 'wrongProduction' };
  const base = {
    wrongProduction: false,
    wrongProductionAutoCleared: true,
    rejectionReason: 'wrong_production',
    rejectedBy: 'ensemble-scoreability-check',
    rejectionAgreeCount: 3,
    rejectionReasoning: 'claude: wrong_production | gpt-4o: wrong_production | gemini: wrong_production',
    rejectedAt: '2026-11-22T17:50:00Z',
  };
  assert.strictEqual(classifyAutoclearVsEnsemble(base, opts).isViolation, true, 'unmarked pair is still a violation');
  const ob = { ...base, rejectionFlagNotApplied: 'ob-exempt', rejectionFlagNotAppliedAt: base.rejectedAt };
  // a marker left over from an EARLIER verdict exempts nothing
  assert.strictEqual(classifyAutoclearVsEnsemble({ ...ob, rejectedAt: '2026-11-25T00:00:00Z' }, opts).isViolation, true);
  assert.strictEqual(classifyAutoclearVsEnsemble({ ...ob, rejectionFlagNotAppliedAt: undefined }, opts).isViolation, true);
  const r = classifyAutoclearVsEnsemble(ob, opts);
  assert.strictEqual(r.isViolation, false);
  assert.strictEqual(r.exemptReason, 'ob-exempt-verdict-not-applied');
  // the marker only exempts wrong_production; a wrong_show verdict is never OB-exempt
  const ws = { ...ob, rejectionReason: 'wrong_show', wrongShow: false, wrongShowAutoCleared: true };
  assert.strictEqual(classifyAutoclearVsEnsemble(ws, { reason: 'wrong_show', autoClearedField: 'wrongShowAutoCleared', flagField: 'wrongShow' }).isViolation, true);
});

test('BRO-8093: the ensemble OB-exempt branch stamps rejectionFlagNotApplied and every other rejection clears it', () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'llm-scoring', 'index.ts'), 'utf8');
  const i = src.indexOf("rejection === 'wrong_production' && isOffBroadway) {\n          (fileData as any).rejectionFlagNotApplied = 'ob-exempt';");
  assert.ok(src.lastIndexOf("fileData.rejectedAt = new Date().toISOString();", i) > i - 200, 'rejectedAt is set right before the marker so the At stamp matches it');
  assert.ok(i > 0, 'OB-exempt branch must stamp rejectionFlagNotApplied = ob-exempt');
  const tail = src.slice(i, i + 600);
  assert.match(tail, /rejectionFlagNotAppliedAt = fileData\.rejectedAt;/);
  assert.match(tail, /delete \(fileData as any\)\.rejectionFlagNotApplied;/, 'applied verdicts must drop a stale ob-exempt marker');
  // the stamp sits inside the same rejection block, before rejectedBy and the save
  const by = src.indexOf("fileData.rejectedBy = 'ensemble-scoreability-check';", i);
  assert.ok(by > i && by - i < 900);
});
