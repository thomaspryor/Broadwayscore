// BRO-7171 item (a): exclusion verdicts judged on a saved error page.
// Run: node --test scripts/lib/error-page-verdict.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('./error-page-verdict.js');
const C = require('./text-gap-classify.js');
const L = require('./gap-recovery-ledger.js');
const G = require('./review-write-guard.js');

// The real USA Today not-found template body (Elysa Gardner rows).
const USAT_404 = 'Page Not Found (404) | USA TODAY Skip to main content Home U.S. Sports Entertainment Life Money Tech Travel Opinion '
  + 'Sorry, we can\'t find the page you are looking for. '.repeat(3);
const rec = (extra = {}) => ({
  showId: 'south-pacific-2008', outletId: 'usatoday', criticName: 'Elysa Gardner',
  url: 'https://www.usatoday.com/life/theater/reviews/2008-04-03-south-pacific_N.htm',
  fullText: USAT_404, contentTier: 'invalid', ...extra,
});
const GEMINI = { isNonReview: true, nonReviewType: 'news', nonReviewClassifiedBy: 'gemini' };

test('fixture is a saved error page', () => {
  assert.equal(require('./soft-404-body.js').isSoft404Body(USAT_404), true);
});

test('basis: body-judged verdicts are voidable; human and non-body verdicts block', () => {
  assert.equal(E.isErrorPageVerdictOnly(rec(GEMINI)), true);
  assert.equal(E.isErrorPageVerdictOnly(rec({ wrongShow: true, wrongShowReason: "LLM: This is a 'page not found' error message" })), true);
  assert.equal(E.isErrorPageVerdictOnly(rec({ wrongShow: true, wrongShowReason: 'Write guard (BRO-4383): fullText never names "X"' })), true);
  assert.equal(E.isErrorPageVerdictOnly(rec({ isNonReview: true })), true); // reasonless model flag
  // human
  assert.equal(E.isErrorPageVerdictOnly(rec({ ...GEMINI, manualContentTier: 'complete' })), false);
  assert.equal(E.isErrorPageVerdictOnly(rec({ isNonReview: true, isNonReviewReason: 'manual (not a review): contact page' })), false);
  // evidence other than the body
  assert.equal(E.isErrorPageVerdictOnly(rec({ wrongProduction: true, wrongProductionNote: 'Cross-market: US outlet "amny" reviewing London show' })), false);
  assert.equal(E.isErrorPageVerdictOnly(rec({ wrongProduction: true })), false);
  assert.equal(E.isErrorPageVerdictOnly(rec({ ...GEMINI, duplicateOf: 'x.json' })), false);
  // a real body: nothing to void
  assert.equal(E.isErrorPageVerdictOnly(rec({ ...GEMINI, fullText: 'South Pacific is back, and Kelli O\'Hara is radiant. '.repeat(40) })), false);
});

test('classify: an error-page-only exclusion is a dead url (URL_DEAD saved_error_page), not EXCLUDED', () => {
  const r = C.classifyTextGap(rec(GEMINI), null, { show: { openingDate: '2008-04-03' } });
  assert.equal(r.gapClass, 'URL_DEAD');
  assert.equal(r.subclass, 'saved_error_page');
  assert.equal(C.classifyTextGap(rec({ wrongProduction: true, wrongProductionNote: 'Cross-market: x' }), null, {}).gapClass, 'EXCLUDED');
});

test('driver: an error-page-only exclusion is not an owned record', () => {
  assert.equal(L.ownedRecordReason(rec({ wrongShow: true, wrongShowReason: '404 page - not a review' })), null);
  assert.equal(L.ownedRecordReason(rec({ wrongProduction: true, wrongProductionNote: 'Date guard: x' })), 'excluded_record');
});

test('void: verdicts move into the breadcrumb (null-assigned), the push restore honours exactly those values', () => {
  const d = rec({ ...GEMINI, wrongShow: true, wrongShowReason: '404 page - not a review' });
  const committed = JSON.parse(JSON.stringify(d));
  const kinds = E.voidErrorPageVerdicts(d, { at: '2026-11-10T00:00:00Z' });
  assert.deepEqual(kinds.sort(), ['isNonReview', 'wrongShow']);
  assert.equal(d.isNonReview, null);
  assert.equal(d.wrongShow, null);
  assert.ok('wrongShow' in d, 'null-assigned, never deleted');
  assert.equal(d.errorPageVerdictVoid.prior.isNonReview, true);
  assert.equal(d.errorPageVerdictVoid.prior.wrongShowReason, '404 page - not a review');
  for (const f of ['isNonReview', 'isNonReviewReason', 'wrongShow', 'wrongShowReason']) {
    if (committed[f] == null) continue;
    assert.equal(G.isIntentionalClear(f, d, committed), true, f);
  }
  // a later, different re-flag on the committed side is restored
  assert.equal(G.isIntentionalClear('wrongShowReason', d, { ...committed, wrongShowReason: 'Write guard (BRO-4383): new text never names it' }), false);
  // the breadcrumb is not a human clear: the BRO-4383 guard still judges arriving text
  assert.equal(require('./review-guards.js').wrongShowExplicitlyCleared(d), false);
  assert.ok(G.PROTECTED_FIELDS.includes('errorPageVerdictVoid'));
  // human-owned: no-op
  assert.deepEqual(E.voidErrorPageVerdicts(rec({ ...GEMINI, _locked: true })), []);
});
