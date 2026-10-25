/**
 * Regression test for getFoundOutletIds (scripts/lib/found-outlet-ids.js).
 *
 * BRO-7 / task #150: getFoundOutletIds seeds the "already found, don't re-query
 * SERP/site-search" outlet set from review-text FILES on disk. A file whose
 * content was classified as rejectionReason='not_a_review' (interview, feature,
 * preview, news) is NOT a real review — its outlet slot must stay OPEN so the
 * poller/gather keep looking for the outlet's actual review. If such a file
 * counted as "found", the outlet was permanently blocked from re-discovery.
 * (60 recent 2025-2026 files were affected before the fix landed in #785.)
 *
 * The unconditional skip lives at found-outlet-ids.js — this locks it in
 * alongside the pre-existing wrongProduction/wrongShow skips. Uses the REAL
 * REVIEW_TEXTS_DIR the function reads (no dir injection in the shipped API), so
 * we stage files under a unique throwaway show id and always clean up.
 *
 * Run: node --test tests/unit/found-outlet-ids-skip-not-a-review.test.mjs
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getFoundOutletIds, REVIEW_TEXTS_DIR } = require('../../scripts/lib/found-outlet-ids');

const TEST_SHOW_ID = '__bro7-found-outlet-ids-test__';
const showDir = path.join(REVIEW_TEXTS_DIR, TEST_SHOW_ID);

function writeFile(name, data) {
  fs.writeFileSync(path.join(showDir, name), JSON.stringify(data), 'utf8');
}

fs.mkdirSync(showDir, { recursive: true });
// Included: a normal kept review with a real score.
writeFile('nyt-brantley.json', { outletId: 'nyt', llmScore: { score: 85 } });
// Excluded: confirmed non-review (the bug this test guards).
writeFile('variety-interview.json', { outletId: 'variety', rejectionReason: 'not_a_review' });
// Excluded (pre-existing behavior): wrong production / wrong show.
writeFile('vulture-wrongprod.json', { outletId: 'vulture', wrongProduction: true });
writeFile('guardian-wrongshow.json', { outletId: 'guardian', wrongShow: true });

after(() => {
  fs.rmSync(showDir, { recursive: true, force: true });
});

describe('getFoundOutletIds — rejectionReason=not_a_review', () => {
  test('a not_a_review file does NOT mark its outlet as found', () => {
    const found = getFoundOutletIds(TEST_SHOW_ID);
    assert.equal(found.has('variety'), false, 'not_a_review outlet must stay open for re-discovery');
  });

  test('a real scored review still marks its outlet as found', () => {
    const found = getFoundOutletIds(TEST_SHOW_ID);
    assert.equal(found.has('nyt'), true);
  });

  test('wrongProduction / wrongShow files also stay open (pre-existing skips)', () => {
    const found = getFoundOutletIds(TEST_SHOW_ID);
    assert.equal(found.has('vulture'), false);
    assert.equal(found.has('guardian'), false);
  });

  test('net: only the real review counts as found', () => {
    const found = getFoundOutletIds(TEST_SHOW_ID);
    assert.deepEqual([...found].sort(), ['nyt']);
  });
});
