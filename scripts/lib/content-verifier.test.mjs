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
} = require('./content-verifier.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

test('reverify call sites no longer hardcode isLongRunningProduction: false (regression guard)', () => {
  for (const rel of ['reverify-stale-cv-promoted.js', 'reverify-nulled-cv-promoted.js']) {
    const file = path.resolve(__dirname, '..', rel);
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(
      src,
      /isLongRunningProduction:\s*false,/,
      `${rel} must derive isLongRunningProduction from the show, not hardcode false — see long-runner-registry.js`
    );
    assert.match(
      src,
      /isLongRunningProduction:\s*isLongRunningProduction\(show\)/,
      `${rel} should call isLongRunningProduction(show) from lib/long-runner-registry`
    );
  }
});
