// BRO-262: Show Score page validator must not reject valid pages via the flaky LLM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkShowScorePage } = require('../../scripts/lib/show-score-page-check.js');
const { validatePageMatchesShow } = require('../../scripts/lib/page-validator.js');
const fs = require('node:fs');
const scraperSrc = fs.readFileSync(new URL('../../scripts/scrape-show-score-audience.js', import.meta.url), 'utf8');

const page = (title, h1 = title) => `<html><head><title>${title}</title></head><body><h1>${h1}</h1></body></html>`;
const hamilton = { id: 'hamilton-2015', title: 'Hamilton', openingDate: '2015-08-06' };

test('valid page with JSON-LD never reaches the LLM, even if the LLM would reject', async () => {
  let llmCalls = 0;
  const validate = async (html, title, o) => {
    if (!o.skipLlm) { llmCalls++; return { valid: false, reason: 'LLM rejected' }; }
    return validatePageMatchesShow(html, title, o);
  };
  const r = await checkShowScorePage(page('Hamilton Broadway Tickets | Show Score'), hamilton, { jsonLdName: 'Hamilton', validate });
  assert.equal(r.valid, true);
  assert.equal(llmCalls, 0);
});

test('real validator with skipLlm accepts a correct page offline', async () => {
  const r = await checkShowScorePage(page('Hamilton - Show Score'), hamilton, { jsonLdName: 'Hamilton' });
  assert.equal(r.valid, true);
});

test('deterministic year-mismatch still rejects with JSON-LD present (no LLM rescue)', async () => {
  let llmCalls = 0;
  const validate = async (html, title, o) => { if (!o.skipLlm) llmCalls++; return validatePageMatchesShow(html, title, { ...o, skipLlm: true }); };
  const r = await checkShowScorePage(page('Hamilton 1999 Revival'), hamilton, { jsonLdName: 'Hamilton', validate });
  assert.equal(r.valid, false);
  assert.equal(llmCalls, 0);
});

test('without JSON-LD, LLM tiebreaker is consulted after a deterministic reject', async () => {
  const calls = [];
  const validate = async (html, title, o) => { calls.push(!!o.skipLlm); return o.skipLlm ? { valid: false, reason: 'det' } : { valid: true, reason: 'llm ok' }; };
  const r = await checkShowScorePage('<html></html>', hamilton, { jsonLdName: null, validate });
  assert.equal(r.valid, true);
  assert.deepEqual(calls, [true, false]);
});

test('scraper routes through checkShowScorePage, not a raw LLM validator call', () => {
  assert.match(scraperSrc, /checkShowScorePage\(html, show/);
  assert.doesNotMatch(scraperSrc, /validatePageMatchesShow\([^)]*pageType: 'audience-aggregator' \}\)/);
});
