import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getFoundOutletIds, REVIEW_TEXTS_DIR } = require('./found-outlet-ids.js');
const { selectApplicableSiteSearchOutlets } = require('./site-search-discovery.js');

// Regression coverage for #785: gather-reviews.js's STEP 1c site-search and STEP 2
// SERP both computed "already found" purely from the CURRENT run's in-memory
// foundReviews, never checking which outlets already have a scored review FILE on
// disk from a prior run. This exercises the shared getFoundOutletIds() both steps
// now seed from, against real fixture files on disk (no mocks).

const TEST_SHOW_ID = '__test-found-outlet-ids-fixture-785__';
const showDir = path.join(REVIEW_TEXTS_DIR, TEST_SHOW_ID);

function writeFixture(filename, data) {
  fs.mkdirSync(showDir, { recursive: true });
  fs.writeFileSync(path.join(showDir, filename), JSON.stringify(data));
}

function cleanup() {
  fs.rmSync(showDir, { recursive: true, force: true });
}

test('getFoundOutletIds returns outlets with real on-disk review files, even with no in-run state', () => {
  cleanup();
  try {
    writeFixture('nypost.json', { outletId: 'nypost', url: 'https://nypost.com/review' });
    const ids = getFoundOutletIds(TEST_SHOW_ID);
    assert.ok(ids.has('nypost'), 'outlet with a real on-disk file must be treated as already-found');
  } finally {
    cleanup();
  }
});

test('getFoundOutletIds excludes wrongProduction/wrongShow/not_a_review files — they must not block re-discovery', () => {
  cleanup();
  try {
    writeFixture('vulture.json', { outletId: 'vulture', wrongProduction: true });
    writeFixture('variety.json', { outletId: 'variety', wrongShow: true });
    writeFixture('nytimes.json', { outletId: 'nytimes', rejectionReason: 'not_a_review' });
    const ids = getFoundOutletIds(TEST_SHOW_ID);
    assert.ok(!ids.has('vulture'), 'wrongProduction file must not count as found');
    assert.ok(!ids.has('variety'), 'wrongShow file must not count as found');
    assert.ok(!ids.has('nytimes'), 'not_a_review rejection must not count as found (#150)');
  } finally {
    cleanup();
  }
});

test('getFoundOutletIds returns empty set for a show directory that does not exist', () => {
  cleanup();
  const ids = getFoundOutletIds(TEST_SHOW_ID);
  assert.equal(ids.size, 0);
});

test('site-search selection excludes an outlet found only via disk state (STEP 1c integration)', () => {
  cleanup();
  try {
    writeFixture('nypost.json', { outletId: 'nypost', url: 'https://nypost.com/review' });
    const diskFoundIds = getFoundOutletIds(TEST_SHOW_ID);
    // Simulates gather-reviews.js STEP 1c: alreadyFoundIds seeded from disk even
    // though this run's in-memory foundReviews (here: none) is empty.
    const applicable = selectApplicableSiteSearchOutlets('broadway', { id: TEST_SHOW_ID, type: 'play' }, diskFoundIds, false);
    assert.ok(!applicable.includes('nypost'), 'nypost must be excluded from site-search once found on disk');
  } finally {
    cleanup();
  }
});
