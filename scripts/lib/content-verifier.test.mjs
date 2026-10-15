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
import os from 'node:os';
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

// ---------------------------------------------------------------------------
// BRO-4427: the temporal override leaves CV.wrongProduction=true with no clear
// flag. A corroborated override (text names the show AND its venue) must be a
// warning in cv-wrongproduction-unhandled, not a blocking error; the
// juan-a-ramirez shape (override stamp, text never names the show) stays an error.
// ---------------------------------------------------------------------------
const {
  OVERRIDE_STAMP_RE,
  classifyOverrideCorroboration,
} = require('./cv-override-corroboration.js');
const cvUnhandledCheck = require('./opening-night-checks/cv-wrongproduction-unhandled.check.js');

const OVR_SHOW = {
  id: 'school-girls-fixture-2026',
  title: 'School Girls; Or, The African Mean Girls Play',
  venue: 'Samuel J. Friedman Theatre',
  market: 'broadway',
};
const ovrFiller = ' The cast is sharp and the staging keeps the comedy moving at a steady clip.'.repeat(6);
const overrideCv = (extra = {}) => ({
  wrongProduction: true,
  confidence: 'low',
  reasoning: '[OVERRIDE: review within 1d of opening, likely correct production] Mentions an earlier run.',
  issues: ['earlier production referenced'],
  ...extra,
});
let ovrSeq = 0;
const reviewWith = (fullText, cv = overrideCv()) => ({
  url: `https://example.com/review-${++ovrSeq}`,
  outletId: 'talkinbroadway',
  criticName: `Fixture Critic ${ovrSeq}`,
  fullText,
  contentVerification: cv,
});
const CORROBORATED_TEXT = `School Girls; Or, The African Mean Girls Play opened tonight at the Samuel J. Friedman Theatre.${ovrFiller}`;
const TITLE_ONLY_TEXT = `School Girls; Or, The African Mean Girls Play returns in a fresh staging.${ovrFiller}`;
const OFF_SHOW_TEXT = `Every Brilliant Thing is a solo show about a list of reasons to live.${ovrFiller}`;

test('BRO-4427: OVERRIDE_STAMP_RE matches the stamp content-verifier.js actually writes', () => {
  const src = fs.readFileSync(path.join(__dirname, 'content-verifier.js'), 'utf8');
  assert.ok(
    src.includes('`[OVERRIDE: review ${dayClause}, likely correct production] ${wpReasoning}`'),
    'content-verifier.js override stamp template changed; update OVERRIDE_STAMP_RE in cv-override-corroboration.js'
  );
  for (const dayClause of ['within 0d of opening', 'within 14d of opening', 'near opening']) {
    assert.match(`[OVERRIDE: review ${dayClause}, likely correct production] x`, OVERRIDE_STAMP_RE);
  }
  assert.doesNotMatch('The review says [OVERRIDE: review within 1d of opening, likely correct production]', OVERRIDE_STAMP_RE);
});

test('BRO-4427: override + title + venue in text is corroborated', () => {
  const r = classifyOverrideCorroboration(reviewWith(CORROBORATED_TEXT), OVR_SHOW);
  assert.equal(r.corroborated, true);
  assert.equal(r.venueToken, 'samuel j. friedman');
});

test('BRO-4427: juan-a-ramirez shape (text never names the show) is NOT corroborated', () => {
  const r = classifyOverrideCorroboration(reviewWith(OFF_SHOW_TEXT), OVR_SHOW);
  assert.equal(r.corroborated, false);
  assert.equal(r.reason, 'title-not-in-text');
});

test('BRO-4427: title without venue, no stamp, non-low confidence, or wrongArticle are NOT corroborated', () => {
  assert.equal(classifyOverrideCorroboration(reviewWith(TITLE_ONLY_TEXT), OVR_SHOW).reason, 'venue-not-in-text');
  assert.equal(classifyOverrideCorroboration(reviewWith(CORROBORATED_TEXT, overrideCv({ reasoning: 'Reviews the West End run.' })), OVR_SHOW).reason, 'no-override-stamp');
  assert.equal(classifyOverrideCorroboration(reviewWith(CORROBORATED_TEXT, overrideCv({ confidence: 'medium' })), OVR_SHOW).reason, 'confidence-not-low');
  assert.equal(classifyOverrideCorroboration(reviewWith(CORROBORATED_TEXT, overrideCv({ wrongArticle: true })), OVR_SHOW).reason, 'wrong-article');
  assert.equal(classifyOverrideCorroboration(reviewWith(CORROBORATED_TEXT, overrideCv({ wrongProduction: false })), OVR_SHOW).reason, 'cv-not-wrong-production');
});

function runUnhandledCheckOn(reviews) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-4427-'));
  try {
    const dir = path.join(root, OVR_SHOW.id);
    fs.mkdirSync(dir, { recursive: true });
    reviews.forEach((r, i) => fs.writeFileSync(path.join(dir, `r${i}.json`), JSON.stringify(r)));
    const reviewsDoc = { [OVR_SHOW.id]: reviews.map(r => ({ url: r.url, outletId: r.outletId, criticName: r.criticName })) };
    return cvUnhandledCheck.run(OVR_SHOW, { reviewTextsRoot: root, reviewsDoc });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('BRO-4427: check reports a corroborated override as a warning, not a blocking error', () => {
  const result = runUnhandledCheckOn([reviewWith(CORROBORATED_TEXT)]);
  assert.equal(result.severity, 'warning');
  assert.equal(result.details.violations.length, 0);
  assert.equal(result.details.corroboratedOverrides.length, 1);
  assert.equal(result.details.remediation, undefined, 'a warning must not raise the error alert');
});

test('BRO-4427: an uncorroborated override still errors, even next to a corroborated one', () => {
  const result = runUnhandledCheckOn([reviewWith(CORROBORATED_TEXT), reviewWith(OFF_SHOW_TEXT)]);
  assert.equal(result.severity, 'error');
  assert.equal(result.details.violations.length, 1);
  assert.equal(result.details.violations[0].notCorroboratedBecause, 'title-not-in-text');
  assert.equal(result.details.corroboratedOverrides.length, 1);
  assert.equal(result.details.remediation.severity, 'error');
});
