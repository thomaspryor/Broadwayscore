// TESTS-VS-DERIVED-DATA-EXEMPT: pure-function unit tests against synthetic fixtures, no live shows.json facts asserted.
/**
 * Unit tests for content-verifier.js's WE long-runner CV hardening (Notion
 * card 34c637c5-416f-812b / task #1615).
 *
 * verifyContent() itself calls out to LLM providers, so these tests exercise
 * buildVerificationPrompt() — the pure prompt-builder extracted specifically
 * so this hardening is testable without mocking network calls (see
 * memory/feedback_test_pure_function_at_io_boundary.md).
 *
 * Coverage maps to the 5 acceptance-criteria checks on task #1615:
 *   1. originalOpeningDate fallback — this repo fixed openingDate directly on
 *      shows.json rather than adding a separate field (see
 *      scripts/lib/long-runner-registry.js header comment); covered here by
 *      confirming buildVerificationPrompt correctly threads the corrected
 *      openingDate into the prompt's dateContext and long-runner hint.
 *   2. venue alias matching
 *   3. long-runner flag handling
 *   4. URL-year preference logic
 *   5. no regression on existing content verification
 *
 * Run: node --test scripts/lib/content-verifier.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  verifyContent,
  heuristicVerify,
  quickValidityCheck,
  resolveCvMarket,
  buildVerificationPrompt,
  buildPriorRunHint,
  isCvVerdictFromPartialWindow,
} = require('./content-verifier.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// 0. Declared priorRuns / tourLegs reach the prompt
// ============================================================

test('prompt lists declared priorRuns and tourLegs as THIS production', () => {
  const { prompt } = buildVerificationPrompt({
    scrapedText: 'x'.repeat(300),
    showTitle: 'My Neighbour Totoro',
    outletName: 'The Telegraph',
    openingDate: '2025-12-10',
    market: 'west-end',
    priorRuns: [{ venue: 'Barbican Theatre', openingDate: '2022-10-08', closingDate: '2023-01-21' }],
    tourLegs: [{ venue: 'Curran Theatre', startDate: '2026-11-01', endDate: '2027-01-05' }],
  });
  assert.match(prompt, /DECLARED EARLIER RUNS \/ TOUR LEGS OF THIS PRODUCTION/);
  assert.match(prompt, /Barbican Theatre \(2022-10-08 to 2023-01-21\)/);
  assert.match(prompt, /Curran Theatre \(2026-11-01 to 2027-01-05\)/);
  assert.match(prompt, /IS a review of THIS production/);
  assert.match(prompt, /is still wrongProduction/);
});

test('prompt carries no prior-run hint when the show declares none', () => {
  for (const extra of [{}, { priorRuns: [], tourLegs: [] }, { priorRuns: null, tourLegs: undefined }]) {
    const { prompt } = buildVerificationPrompt({
      scrapedText: 'x'.repeat(300),
      showTitle: 'Hamilton',
      outletName: 'Variety',
      openingDate: '2015-08-06',
      market: 'broadway',
      ...extra,
    });
    assert.doesNotMatch(prompt, /DECLARED EARLIER RUNS/);
  }
  assert.equal(buildPriorRunHint(undefined, undefined), '');
});

test('buildPriorRunHint: missing dates / venue degrade, newlines are flattened', () => {
  const hint = buildPriorRunHint([{ openingDate: '2022-01-01' }, { venue: 'Garrick\nTheatre' }], null);
  assert.match(hint, /earlier run \(2022-01-01 to unknown\)/);
  assert.match(hint, /; Garrick Theatre\./);
});

test('BRO-5724: buildPriorRunHint leaves out inheritReviews:false runs (a separate production)', () => {
  const hint = buildPriorRunHint([
    { venue: 'Barbican', openingDate: '2022-10-08', closingDate: '2023-01-21' },
    { venue: 'Noel Coward', openingDate: '2025-04-14', closingDate: '2025-08-03', inheritReviews: false },
  ], null);
  assert.match(hint, /Barbican/);
  assert.doesNotMatch(hint, /Noel Coward/);
  assert.equal(buildPriorRunHint([{ venue: 'X', inheritReviews: false }], null), '');
});

test('verifyContent threads show.priorRuns / show.tourLegs into the prompt builder', () => {
  // verifyContent calls an LLM, so assert the wiring at the call site: the
  // collector passes `show`, and verifyContent must forward its runs.
  const src = fs.readFileSync(path.join(__dirname, 'content-verifier.js'), 'utf8');
  const call = src.slice(src.indexOf('async function verifyContent('), src.indexOf('const result = await callWithFallback(prompt)'));
  assert.match(call, /priorRuns:\s*show && show\.priorRuns/);
  assert.match(call, /tourLegs:\s*show && show\.tourLegs/);
});

// ============================================================
// 1. originalOpeningDate fallback (implemented as corrected openingDate)
// ============================================================

test('dateContext uses the (corrected) openingDate — Phantom WE 1986-10-09', () => {
  const { prompt } = buildVerificationPrompt({
    scrapedText: 'x'.repeat(300),
    showTitle: 'The Phantom of the Opera',
    outletName: 'Variety',
    openingDate: '1986-10-09',
    market: 'west-end',
  });
  assert.match(prompt, /West End opening date: 1986-10-09/);
});

test('dateContext uses the (corrected) openingDate — Les Mis WE 1985-12-04', () => {
  const { prompt } = buildVerificationPrompt({
    scrapedText: 'x'.repeat(300),
    showTitle: 'Les Miserables',
    outletName: 'The Guardian',
    openingDate: '1985-12-04',
    market: 'west-end',
  });
  assert.match(prompt, /West End opening date: 1985-12-04/);
});

// ============================================================
// 2. Venue alias matching
// ============================================================

test('venue alias: His Majesty\'s Theatre prompt includes Her Majesty\'s (pre-rename)', () => {
  const { prompt } = buildVerificationPrompt({
    scrapedText: 'x'.repeat(300),
    showTitle: 'The Phantom of the Opera',
    outletName: 'Variety',
    venue: "His Majesty's Theatre",
    market: 'west-end',
  });
  assert.match(prompt, /Her Majesty's Theatre/);
  assert.match(prompt, /Renamed Sept 2022/);
});

test('venue alias: Sondheim Theatre (WE) includes Queen\'s Theatre (pre-2019 rename)', () => {
  const { prompt } = buildVerificationPrompt({
    scrapedText: 'x'.repeat(300),
    showTitle: 'Les Miserables',
    outletName: 'The Times',
    venue: 'Sondheim Theatre',
    market: 'west-end',
  });
  assert.match(prompt, /Queen's Theatre/);
});

test('venue alias: unknown venue passes through unexpanded, no crash', () => {
  const { prompt } = buildVerificationPrompt({
    scrapedText: 'x'.repeat(300),
    showTitle: 'Some New Show',
    outletName: 'Variety',
    venue: 'Some Brand New Theatre',
    market: 'west-end',
  });
  assert.match(prompt, /Some Brand New Theatre/);
});

test('venue alias: region disambiguation — Broadway show does not get London Lyric rename history', () => {
  const { prompt } = buildVerificationPrompt({
    scrapedText: 'x'.repeat(300),
    showTitle: 'Some Broadway Show',
    outletName: 'NYT',
    venue: 'Lyric Theatre',
    market: 'broadway',
  });
  // The NYC Lyric's rename history (Foxwoods/Hilton/Ford Center) should appear,
  // not any London-only alias noise.
  assert.match(prompt, /Foxwoods Theatre/);
});

// ============================================================
// 3. Long-runner flag handling
// ============================================================

test('isLongRunningProduction=true injects the LONG-RUNNING PRODUCTION hint', () => {
  const { prompt } = buildVerificationPrompt({
    scrapedText: 'x'.repeat(300),
    showTitle: 'The Phantom of the Opera',
    outletName: 'Variety',
    openingDate: '1986-10-09',
    publishDate: '2010-03-15',
    market: 'west-end',
    isLongRunningProduction: true,
  });
  assert.match(prompt, /LONG-RUNNING PRODUCTION/);
  assert.match(prompt, /do NOT flag wrongProduction based on publishDate-vs-openingDate age gap alone/);
});

test('isLongRunningProduction=false (default) omits the long-runner hint', () => {
  const { prompt } = buildVerificationPrompt({
    scrapedText: 'x'.repeat(300),
    showTitle: 'Some Recent Show',
    outletName: 'Variety',
    openingDate: '2023-05-18',
    publishDate: '2023-05-20',
    market: 'west-end',
    isLongRunningProduction: false,
  });
  assert.doesNotMatch(prompt, /LONG-RUNNING PRODUCTION/);
});

test('isLongRunningProduction=true without openingDate does not inject the hint (no anchor date)', () => {
  const { prompt } = buildVerificationPrompt({
    scrapedText: 'x'.repeat(300),
    showTitle: 'Some Show',
    outletName: 'Variety',
    market: 'west-end',
    isLongRunningProduction: true,
  });
  assert.doesNotMatch(prompt, /LONG-RUNNING PRODUCTION/);
});

// ============================================================
// 4. URL-year preference logic
// ============================================================

test('URL-year conflict: >=3yr gap between URL year and publishDate is detected and logged', () => {
  const { prompt, urlYearConflict } = buildVerificationPrompt({
    scrapedText: 'x'.repeat(300),
    showTitle: 'Mamma Mia',
    outletName: 'Variety',
    market: 'west-end',
    publishDate: '2015-09-03',
    url: 'https://variety.com/1999/legit/reviews/mamma-mia-review-12345/',
  });
  assert.ok(urlYearConflict, 'expected a urlYearConflict object');
  assert.equal(urlYearConflict.urlYear, 1999);
  assert.equal(urlYearConflict.publishYear, 2015);
  assert.equal(urlYearConflict.gapYears, 16);
  assert.match(prompt, /URL-YEAR \/ PUBLISHDATE CONFLICT/);
  assert.match(prompt, /"\/1999\//);
});

test('URL-year conflict: no conflict object when years agree', () => {
  const { prompt, urlYearConflict } = buildVerificationPrompt({
    scrapedText: 'x'.repeat(300),
    showTitle: 'Some Show',
    outletName: 'Variety',
    market: 'west-end',
    publishDate: '2023-05-20',
    url: 'https://variety.com/2023/legit/reviews/some-show-review-12345/',
  });
  assert.equal(urlYearConflict, null);
  assert.doesNotMatch(prompt, /URL-YEAR \/ PUBLISHDATE CONFLICT/);
});

test('URL-year conflict: small gap (<3yr) does not trigger the conflict', () => {
  const { urlYearConflict } = buildVerificationPrompt({
    scrapedText: 'x'.repeat(300),
    showTitle: 'Some Show',
    outletName: 'Variety',
    market: 'west-end',
    publishDate: '2023-05-20',
    url: 'https://variety.com/2022/legit/reviews/some-show-review-12345/',
  });
  assert.equal(urlYearConflict, null);
});

test('URL-year conflict: no URL means no conflict object', () => {
  const { urlYearConflict } = buildVerificationPrompt({
    scrapedText: 'x'.repeat(300),
    showTitle: 'Some Show',
    outletName: 'Variety',
    market: 'west-end',
    publishDate: '2023-05-20',
  });
  assert.equal(urlYearConflict, null);
});

test('verifyContent (no LLM providers configured) still returns urlYearConflict via heuristic fallback', async () => {
  const savedKeys = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const result = await verifyContent({
      scrapedText: 'Mamma Mia review text mentions Mamma Mia the show at length. '.repeat(10),
      showTitle: 'Mamma Mia',
      outletName: 'Variety',
      market: 'west-end',
      publishDate: '2015-09-03',
      url: 'https://variety.com/1999/legit/reviews/mamma-mia-review-12345/',
    });
    assert.equal(result.verifiedBy, 'heuristic');
    assert.ok(result.urlYearConflict, 'urlYearConflict should survive the heuristic-fallback path');
    assert.equal(result.urlYearConflict.urlYear, 1999);
  } finally {
    for (const [k, v] of Object.entries(savedKeys)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ============================================================
// 5. No regression on existing content verification
// ============================================================

test('verifyContent short-circuits on <200 char content regardless of API keys', async () => {
  const result = await verifyContent({ scrapedText: 'too short', showTitle: 'X', outletName: 'Y' });
  assert.equal(result.isValid, false);
  assert.equal(result.verifiedBy, 'skip-short');
  // Documented return shape includes urlYearConflict on every path (Codex
  // adversarial review, task #1615) — the short-circuit must not omit the key.
  assert.equal(result.urlYearConflict, null);
});

test('heuristicVerify still flags missing show title as wrongArticle', () => {
  const result = heuristicVerify({
    scrapedText: 'A completely unrelated article about something else entirely, padded out. '.repeat(5),
    showTitle: 'A Totally Different Show Title',
  });
  assert.equal(result.wrongArticle, true);
  assert.equal(result.isValid, false);
});

test('heuristicVerify passes a clean review mentioning the show', () => {
  const text = 'This review of Hamilton was excellent and the critic loved every minute of the performance. '.repeat(5);
  const result = heuristicVerify({ scrapedText: text, showTitle: 'Hamilton' });
  assert.equal(result.wrongArticle, false);
});

test('quickValidityCheck rejects short/junky text, accepts plausible review text', () => {
  assert.equal(quickValidityCheck('too short', 'Hamilton'), false);
  const good = 'Hamilton is a Broadway musical with an incredible cast and stellar direction from the theater team. '.repeat(4);
  assert.equal(quickValidityCheck(good, 'Hamilton'), true);
});

test('resolveCvMarket: opera shows route to opera market regardless of category', () => {
  assert.equal(resolveCvMarket({ type: 'opera', category: 'off-broadway' }), 'opera');
});

test('resolveCvMarket: falls back to category, then broadway default', () => {
  assert.equal(resolveCvMarket({ category: 'west-end' }), 'west-end');
  assert.equal(resolveCvMarket(null), 'broadway');
});

test('buildVerificationPrompt: baseline call (no venue/long-runner/url) has no hint sections', () => {
  const { prompt, urlYearConflict } = buildVerificationPrompt({
    scrapedText: 'x'.repeat(300),
    showTitle: 'Some Show',
    outletName: 'Variety',
    market: 'broadway',
  });
  assert.doesNotMatch(prompt, /LONG-RUNNING PRODUCTION/);
  assert.doesNotMatch(prompt, /URL-YEAR \/ PUBLISHDATE CONFLICT/);
  assert.equal(urlYearConflict, null);
});

test('verifyContent call sites no longer hardcode isLongRunningProduction: false, and derive it from the show (regression guard)', () => {
  // All non-lib callers of verifyContent() that resolve a real per-show `show`
  // object. reverify-era-venue-wrongprod.js is excluded — it's Broadway-only
  // (isLongRunningProduction is WE-only by design, so wiring it there would
  // always evaluate false anyway) — and test-content-verifier.js is excluded —
  // it's a manual dev harness with synthetic/CLI-supplied input, not a show lookup.
  for (const rel of [
    'reverify-stale-cv-promoted.js',
    'reverify-nulled-cv-promoted.js',
    'reverify-with-haiku.js',
    'reverify-promoted-reviews.js',
    'verify-existing-reviews.js',
  ]) {
    const file = path.resolve(__dirname, '..', rel);
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(
      src,
      /isLongRunningProduction:\s*false,/,
      `${rel} must derive isLongRunningProduction from the show, not hardcode false — see long-runner-registry.js`
    );
    assert.match(
      src,
      /isLongRunningProduction:\s*isLongRunningProduction\(/,
      `${rel} should call isLongRunningProduction(...) from lib/long-runner-registry`
    );
  }
});

// BRO-4427: temporal-override warning downgrade (the card's acceptance file imports its tests).
import './cv-wrongproduction-temporal-override.test.mjs';

test('heuristicVerify: a press title (akaTitles) counts as the show being mentioned (BRO-5891, 860)', () => {
  const text = "There are very few comedians left who can do what Billy Crystal can do. In 860, named for the house he lost in the Palisades fire, he is funny and moving for ninety minutes. ".repeat(4);
  const without = heuristicVerify({ scrapedText: text, showTitle: 'Billy Crystal 860' });
  assert.equal(without.wrongArticle, true);
  const withAka = heuristicVerify({ scrapedText: text, showTitle: 'Billy Crystal 860', akaTitles: ['860'] });
  assert.equal(withAka.wrongArticle, false);
  assert.ok(!withAka.issues.some((i) => /not found in content/.test(i)));
});

// BRO-6225: the collector parks the body in wrongFullText on the very verdict
// rebuild then asks about, so the partial-window guard has to measure it there.
{
  const { explainExclusion, isCvPartialWindowAdvisory, isNonReviewDemotedByFreshCV } = require('./review-guards.js');
  const { needsRescoreForCvPartialWindow } = require('./rescore-flagging.js');
  const body = 'The production is a triumph and the cast is superb. '.repeat(120); // ~6,200 chars, past 1.5x the head window
  const cv = { wrongArticle: true, wrongProduction: false, articleType: 'feature', confidence: 'high', verifiedAt: '2026-10-01T00:00:00Z' };
  const promoted = (extra = {}) => ({
    outletId: 'theatermania', url: 'https://www.theatermania.com/news/x', showId: 's',
    fullText: body, contentTier: 'complete', wordCount: 1100,
    isNonReview: true, rejectionReason: 'not_a_review',
    isNonReviewReason: 'CV-promoted (not a review): This is a feature article',
    contentVerification: cv,
    ...extra,
  });

  test('isCvVerdictFromPartialWindow: measures the parked body when fullText was moved out (BRO-6225)', () => {
    assert.equal(isCvVerdictFromPartialWindow(cv, '', { fullText: null, wrongFullText: body }), true);
    assert.equal(isCvVerdictFromPartialWindow(cv, '', { fullText: null, wrongFullText: body.slice(0, 2000) }), false);
    assert.equal(isCvVerdictFromPartialWindow(cv, ''), false);
  });

  test('CV-promoted head-of-article verdict: scoreable, but excluded until the ensemble has read the current text (BRO-6225)', () => {
    const d = promoted();
    assert.equal(explainExclusion(d, null, null, { forScoring: true }), null);
    assert.equal(explainExclusion(d), 'nonReview');
    // A score made before the verdict can be of a page the file no longer holds.
    const stale = promoted({ llmScore: { score: 80, confidence: 'high' }, llmMetadata: { scoredAt: '2026-09-01T00:00:00Z' } });
    assert.equal(explainExclusion(stale), 'nonReview');
    const fresh = promoted({ llmScore: { score: 80, confidence: 'high' }, llmMetadata: { scoredAt: '2026-10-02T00:00:00Z' } });
    assert.equal(explainExclusion(fresh), null);
    assert.equal(isNonReviewDemotedByFreshCV(fresh), true);
  });

  test('head-of-article advisory never overrides the ensemble, a person or another verdict (BRO-6225)', () => {
    const fresh = { llmScore: { score: 80, confidence: 'high' }, llmMetadata: { scoredAt: '2026-10-02T00:00:00Z' } };
    assert.notEqual(explainExclusion(promoted({ ...fresh, rejectedAt: '2026-10-03T00:00:00Z' })), null);
    assert.equal(isCvPartialWindowAdvisory(promoted({ manualNonReviewSet: true }), { forScoring: true }), false);
    assert.equal(isCvPartialWindowAdvisory(promoted({ isNonReviewReason: 'classifier: interview' }), { forScoring: true }), false);
    assert.equal(isCvPartialWindowAdvisory(promoted({ rejectionReason: 'garbage_text' }), { forScoring: true }), false);
    assert.equal(isCvPartialWindowAdvisory(promoted({ contentVerification: { ...cv, wrongProduction: true } }), { forScoring: true }), false);
    // A short piece was read whole: the verdict stands.
    assert.equal(explainExclusion(promoted({ ...fresh, fullText: body.slice(0, 3000) }), null, null, { forScoring: true }), 'nonReview');    // A body still parked in wrongFullText is not what the scorer would read.
    assert.equal(isCvPartialWindowAdvisory(promoted({ ...fresh, fullText: '', wrongFullText: body }), { forScoring: true }), false);
  });

  test('llm-scoring-parity mirrors the head-of-article advisory (BRO-6225)', () => {
    const { classifyRebuildExclusion } = require('./llm-scoring-parity.js');
    const fresh = { llmScore: { score: 80, confidence: 'high' }, llmMetadata: { scoredAt: '2026-10-02T00:00:00Z' } };
    assert.equal(classifyRebuildExclusion(promoted(fresh), null), '');
    assert.equal(classifyRebuildExclusion(promoted(), null), 'nonReview');
  });

  test('needsRescoreForCvPartialWindow: queues a score older than the verdict once, then settles (BRO-6225)', () => {
    const stale = promoted({ llmScore: { score: 80, confidence: 'high' }, llmMetadata: { scoredAt: '2026-09-01T00:00:00Z' } });
    assert.equal(needsRescoreForCvPartialWindow(stale, null, null), true);
    assert.equal(needsRescoreForCvPartialWindow({ ...stale, needsRescore: true }, null, null), false);
    assert.equal(needsRescoreForCvPartialWindow({ ...stale, rescoreCompletedAt: '2026-10-02T00:00:00Z' }, null, null), false);
    assert.equal(needsRescoreForCvPartialWindow(promoted(), null, null), false); // unscored: the scorer picks it up anyway
    assert.equal(needsRescoreForCvPartialWindow({ ...stale, rejectedAt: '2026-10-03T00:00:00Z' }, null, null), false);
    // No verdict date: a rescore could never settle it, so never queue (no loop).
    assert.equal(needsRescoreForCvPartialWindow({ ...stale, contentVerification: { ...cv, verifiedAt: undefined } }, null, null), false);
  });
}
