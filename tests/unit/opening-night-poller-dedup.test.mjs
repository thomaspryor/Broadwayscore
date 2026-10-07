/**
 * BRO-909: Preview-period scraping poisons opening night dedup.
 *
 * gather-reviews.js creates review-text files when SERP finds a URL during a
 * show's preview window (interviews, roundup mentions, prior-production
 * coverage). Date guards flag these wrongProduction/wrongShow/not_a_review,
 * but the FILE remains on disk. The opening-night poller's dedup
 * (getFoundOutletIds for outlet-level "already found", getKnownUrls for
 * URL-level "already known") must treat those flagged files as if they don't
 * exist, or a poisoned outlet slot silently blocks fresh SERP discovery and
 * file creation on opening night itself (the Fear of 13 incident: 14
 * preview-poisoned files blocked all SERP discovery until manually deleted).
 *
 * The underlying fix (skip wrongProduction/wrongShow/not_a_review in both
 * functions) already shipped — cb800a131b2, 9244de6c9ba, 3357e23e1f9,
 * f169100c75c (#785) — this locks it in against regression at the scale the
 * incident actually hit (10+ poisoned outlets in one show directory) and
 * verifies the two dedup layers agree with getMissingT1T2Outlets, which is
 * what actually drives Layer 4 SERP's per-outlet retry list.
 *
 * Run: node --test tests/unit/opening-night-poller-dedup.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getKnownUrls, getFoundOutletIds, getMissingT1T2Outlets } = require('../../scripts/opening-night-poller.js');
const { REVIEW_TEXTS_DIR } = require('../../scripts/lib/found-outlet-ids.js');

const TEST_SHOW_ID = '__test-bro909-preview-dedup__';
const showDir = path.join(REVIEW_TEXTS_DIR, TEST_SHOW_ID);

// Mirrors the Fear of 13 postmortem: a mix of wrongProduction (prior-run/
// cross-market coverage picked up by SERP during previews), wrongShow, and
// not_a_review (interview/awards-season articles that mention the show) —
// 14 outlets total, all poisoned before opening night.
const POISONED_OUTLETS = [
  ...Array.from({ length: 8 }, (_, i) => ({ id: `wrongprod-outlet-${i}`, flag: 'wrongProduction' })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: `wrongshow-outlet-${i}`, flag: 'wrongShow' })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: `notreview-outlet-${i}`, flag: 'rejectionReason' })),
];

function writeFixture(filename, data) {
  fs.mkdirSync(showDir, { recursive: true });
  fs.writeFileSync(path.join(showDir, filename), JSON.stringify(data));
}

function seedPoisonedShow() {
  fs.rmSync(showDir, { recursive: true, force: true });
  for (const outlet of POISONED_OUTLETS) {
    const base = { outletId: outlet.id, url: `https://example.com/${outlet.id}/preview-era-article` };
    const data = outlet.flag === 'rejectionReason'
      ? { ...base, rejectionReason: 'not_a_review' }
      : { ...base, [outlet.flag]: true };
    writeFixture(`${outlet.id}--unknown.json`, data);
  }
}

function cleanup() {
  fs.rmSync(showDir, { recursive: true, force: true });
}

test('getFoundOutletIds treats all 14 preview-poisoned outlets as not-found', () => {
  seedPoisonedShow();
  try {
    const found = getFoundOutletIds(TEST_SHOW_ID);
    for (const outlet of POISONED_OUTLETS) {
      assert.ok(!found.has(outlet.id), `${outlet.id} (${outlet.flag}) must not count as found`);
    }
  } finally {
    cleanup();
  }
});

test('getKnownUrls excludes preview-poisoned URLs so a fresh opening-day URL for the same outlet is not deduped away', () => {
  seedPoisonedShow();
  try {
    const known = getKnownUrls(TEST_SHOW_ID);
    for (const outlet of POISONED_OUTLETS) {
      const poisonedUrl = `https://example.com/${outlet.id}/preview-era-article`;
      assert.ok(!known.has(poisonedUrl), `${outlet.id}'s preview-era URL must not block rediscovery`);
    }
    // A distinct, current-day URL for one of the poisoned outlets must be free
    // to be treated as new — this is the actual acceptance bar: opening night
    // SERP finding today's review must not be swallowed by the stale flagged file.
    const freshUrl = 'https://example.com/wrongprod-outlet-0/opening-night-review';
    assert.ok(!known.has(freshUrl), 'a fresh opening-day URL must not already read as known');
  } finally {
    cleanup();
  }
});

test('getMissingT1T2Outlets still lists a preview-poisoned real T1 outlet as missing, so Layer 4 SERP retries it', () => {
  cleanup();
  try {
    // Use a real registered T1 outlet (not a synthetic id) so it actually
    // participates in getMissingT1T2Outlets's registry walk.
    writeFixture('nytimes--unknown.json', {
      outletId: 'nytimes',
      url: 'https://www.nytimes.com/preview-era-interview',
      wrongProduction: true,
    });
    const missing = getMissingT1T2Outlets(TEST_SHOW_ID, 'broadway', { id: TEST_SHOW_ID });
    assert.ok(
      missing.some(o => o.id.toLowerCase() === 'nytimes'),
      'a wrongProduction-flagged nytimes file must not remove nytimes from the missing-outlets list'
    );
  } finally {
    cleanup();
  }
});
