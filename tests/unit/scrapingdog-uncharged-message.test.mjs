// BRO-3325 what-else (2026-09-15): Scrapingdog's own "You won't be charged for
// this request" failures were booked at full credit cost in the spend ledger
// (4,334 phantom credits in 7 days), skewing the weekly cost report and the
// tier-skip drift audit. The predicate below decides the 0-credit booking in
// both fetchWithScrapingdog (scraper.js) and _serpViaScrapingdog
// (url-discovery.js). Requires the real function — never a copy (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isScrapingdogUnchargedMessage } = require('../../scripts/lib/scraper.js');

test('SD 400 "Oops … You won’t be charged" (curly apostrophe, as the ledger records it) is uncharged', () => {
  assert.equal(isScrapingdogUnchargedMessage(
    'Scrapingdog HTTP 400: Oops! Something went wrong. You won’t be charged for this request.'), true);
});

test('SD 500 JSON body with a straight apostrophe is uncharged, via message or response body', () => {
  const body = { message: "Oops! Something went wrong. You won't be charged for this request." };
  assert.equal(isScrapingdogUnchargedMessage('Scrapingdog HTTP 500: ' + JSON.stringify(body)), true);
  assert.equal(isScrapingdogUnchargedMessage('Request failed with status code 500', body), true);
  assert.equal(isScrapingdogUnchargedMessage(undefined, JSON.stringify(body)), true);
});

test('the ledger’s 80-char-truncated 500 form ("…You won’t be charg") is still recognised, so replays agree with live booking', () => {
  assert.equal(isScrapingdogUnchargedMessage(
    'Scrapingdog HTTP 500: {"message":"Oops! Something went wrong. You won’t be charg'), true);
});

test('404 "This URL does not exist", timeouts, numeric SERP 400s and 502s keep full-cost booking', () => {
  assert.equal(isScrapingdogUnchargedMessage('Scrapingdog HTTP 404: {"message":"This URL does not exist or the url is wrong."}'), false);
  assert.equal(isScrapingdogUnchargedMessage('Scrapingdog request timeout'), false);
  assert.equal(isScrapingdogUnchargedMessage('Request failed with status code 400', { message: 'bad query' }), false);
  assert.equal(isScrapingdogUnchargedMessage('Scrapingdog HTTP 502: error code: 502'), false);
  assert.equal(isScrapingdogUnchargedMessage(), false);
  assert.equal(isScrapingdogUnchargedMessage(null, undefined), false);
});
