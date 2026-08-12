/**
 * Regression test for getFoundOutletIds (scripts/lib/found-outlet-ids.js).
 *
 * Task #1328: isScoreable() filters out isBlockedReviewUrl URLs (aggregator/
 * listing/ticket/social domain) BEFORE the LLM ensemble ever runs, so a file
 * saved from a blocked URL never gets scored AND never gets a rejectionReason
 * written — it sits unclassified forever. getFoundOutletIds() only skipped
 * rejectionReason='not_a_review'/wrongProduction/wrongShow files (#150/#785),
 * so these unscored+unclassified files counted as "found" and permanently
 * masked the outlet's slot from SERP/gap rediscovery (88 files / 29 outlets
 * corpus-wide, including T1/T2 outlets like Telegraph, The Stage, Playbill).
 *
 * Run: node --test tests/unit/found-outlet-ids-skip-blocked-url.test.mjs
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getFoundOutletIds, REVIEW_TEXTS_DIR } = require('../../scripts/lib/found-outlet-ids');

const TEST_SHOW_ID = '__1328-found-outlet-ids-blocked-url-test__';
const showDir = path.join(REVIEW_TEXTS_DIR, TEST_SHOW_ID);

function writeFile(name, data) {
  fs.writeFileSync(path.join(showDir, name), JSON.stringify(data), 'utf8');
}

fs.mkdirSync(showDir, { recursive: true });
// Excluded: unscored file saved from a blocked (aggregator) URL — the bug this test guards.
writeFile('telegraph-unscored.json', {
  outletId: 'telegraph',
  url: 'https://www.broadway.com/some-listing-page',
});
// Excluded: unscored file saved from a blocked (ticket) URL.
writeFile('thestage-unscored.json', {
  outletId: 'thestage',
  url: 'https://www.todaytix.com/nyc/shows/12345',
});
// Included: blocked-domain URL but the file DOES have a real score — must still count as found.
writeFile('playbill-scored.json', {
  outletId: 'playbill',
  url: 'https://playbill.com/production/some-show',
  llmScore: { score: 72 },
});
// Included: normal kept review with a real score, non-blocked URL.
writeFile('nyt-brantley.json', {
  outletId: 'nyt',
  url: 'https://www.nytimes.com/theater/review.html',
  llmScore: { score: 85 },
});
// Included: blocked-URL check requires a url field — files without one keep prior behavior.
writeFile('vulture-no-url.json', { outletId: 'vulture' });

after(() => {
  fs.rmSync(showDir, { recursive: true, force: true });
});

describe('getFoundOutletIds — unscored + isBlockedReviewUrl', () => {
  test('an unscored file saved from a blocked aggregator URL does NOT mark its outlet as found', () => {
    const found = getFoundOutletIds(TEST_SHOW_ID);
    assert.equal(found.has('telegraph'), false, 'blocked-URL unscored outlet must stay open for re-discovery');
  });

  test('an unscored file saved from a blocked ticket URL does NOT mark its outlet as found', () => {
    const found = getFoundOutletIds(TEST_SHOW_ID);
    assert.equal(found.has('thestage'), false);
  });

  test('a SCORED file with a blocked-domain URL still counts as found', () => {
    const found = getFoundOutletIds(TEST_SHOW_ID);
    assert.equal(found.has('playbill'), true, 'a real score must not be masked by the URL-domain check');
  });

  test('a normal scored review with a non-blocked URL still counts as found', () => {
    const found = getFoundOutletIds(TEST_SHOW_ID);
    assert.equal(found.has('nyt'), true);
  });

  test('a file with no url field is unaffected by the new check', () => {
    const found = getFoundOutletIds(TEST_SHOW_ID);
    assert.equal(found.has('vulture'), true);
  });

  test('net: only real (or url-less) files count as found', () => {
    const found = getFoundOutletIds(TEST_SHOW_ID);
    assert.deepEqual([...found].sort(), ['nyt', 'playbill', 'vulture']);
  });
});
