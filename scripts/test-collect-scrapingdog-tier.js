#!/usr/bin/env node
/**
 * Regression test: collect-review-texts.js TIER 1.9 (Scrapingdog before
 * ScrapingBee). Tests the REAL fetchWithScrapingdogTier via require() with
 * scraper.js's fetchWithScrapingdog stubbed in require.cache — verifies
 * accept/fall-through behavior so SD misses cascade to SB instead of
 * masquerading as successes (or vice versa).
 */

process.env.SCRAPER_USE_SCRAPINGDOG = '1';
process.env.SCRAPINGDOG_API_KEY = 'test-key';

// Stub lib/scraper BEFORE collect-review-texts loads. Preserve the real
// module's other exports (domainMatchesExpected etc.) that collect requires.
const scraperPath = require.resolve('./lib/scraper');
const realScraper = require('./lib/scraper');
let sdResponse = null;
require.cache[scraperPath].exports = {
  ...realScraper,
  fetchWithScrapingdog: async () => sdResponse,
};

const { fetchWithScrapingdogTier } = require('./collect-review-texts');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  console.log('1. Real article HTML → accepted ({html, text})');
  const para = `<p>${'Hamilton is a triumph of staging and score, a revolution in musical form. '.repeat(4)}</p>`;
  const article = `<html><body><article>${para.repeat(8)}</article></body></html>`;
  sdResponse = { content: article, format: 'html', source: 'scrapingdog' };
  const r1 = await fetchWithScrapingdogTier('https://example.com/review').catch(e => e);
  check('returns html+text', r1 && r1.html && r1.text && r1.text.length > 500, r1 instanceof Error ? r1.message : `text len ${r1?.text?.length}`);

  console.log('2. Null (provider off/error) → throws so chain falls through to SB');
  sdResponse = null;
  const r2 = await fetchWithScrapingdogTier('https://example.com/review').catch(e => e);
  check('throws', r2 instanceof Error, JSON.stringify(r2)?.slice(0, 80));

  console.log('3. Challenge page → throws (falls through, not accepted)');
  sdResponse = { content: '<html><body>Just a moment...<div id="cf_chl_opt"></div></body></html>', format: 'html', source: 'scrapingdog' };
  const r3 = await fetchWithScrapingdogTier('https://example.com/review').catch(e => e);
  check('throws on blocked page', r3 instanceof Error, r3?.message);

  console.log('4. Thin content (<500 chars) → throws (falls through)');
  sdResponse = { content: '<html><body><p>Short stub.</p></body></html>', format: 'html', source: 'scrapingdog' };
  const r4 = await fetchWithScrapingdogTier('https://example.com/review').catch(e => e);
  check('throws on thin content', r4 instanceof Error, r4?.message);

  console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
