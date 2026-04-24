/**
 * Regression test for the gather-reviews stale-flag collision detector.
 *
 * Session 2 (commit 83ce81afa2) wired detectIngestCollision() into
 * scripts/ingest-manual-review.js. This follow-up (Notion 34c637c5-416f-81e7)
 * extends the same detector into scripts/gather-reviews.js createReviewFile()
 * so the Beaches 2026-04-22 failure mode — a fresh URL arriving as a new
 * side-by-side file alongside a stale wrongProduction=true file — is caught
 * at the poller's entry point too.
 *
 * The test exercises the pure detector against fixture show dirs that match
 * the shapes gather-reviews will encounter (stale flag vs clean merge target
 * vs non-colliding outlet). createReviewFile itself is heavy and tangled with
 * other deps; the detector is the load-bearing piece and the one that can
 * regress silently.
 *
 * Run: node --test tests/unit/gather-reviews-collision.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectIngestCollision } = require('../../scripts/lib/manual-review-fields.js');

let tmpRoot;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gather-collision-'));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function seedShow(showId, files) {
  const dir = path.join(tmpRoot, showId);
  fs.mkdirSync(dir, { recursive: true });
  for (const [filename, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2));
  }
  return dir;
}

test('poller discovers fresh URL for outlet+critic with stale wrongProduction file → collision', () => {
  const showDir = seedShow('beaches-2026-a', {
    'chicagotribune--chris-jones.json': {
      outletId: 'chicagotribune',
      criticName: 'Chris Jones',
      url: 'https://chicagotribune.com/2015/01/01/old-production.html',
      publishDate: '2015-01-01',
      wrongProduction: true,
    },
  });
  const result = detectIngestCollision({
    showDir,
    outletId: 'chicagotribune',
    criticName: 'Chris Jones',
    url: 'https://chicagotribune.com/2026/04/22/broadway-debut.html',
    publishDate: '2026-04-22',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale-flag-on-existing-file');
  assert.equal(result.file, 'chicagotribune--chris-jones.json');
});

test('poller discovers same URL as stale-flag file → treated as fix-same-record (no collision)', () => {
  const url = 'https://chicagotribune.com/2015/01/01/revival.html';
  const showDir = seedShow('beaches-2026-b', {
    'chicagotribune--chris-jones.json': {
      outletId: 'chicagotribune', criticName: 'Chris Jones',
      url, wrongProduction: true,
    },
  });
  const result = detectIngestCollision({
    showDir, outletId: 'chicagotribune', criticName: 'Chris Jones', url,
  });
  assert.equal(result.ok, true);
});

test('poller discovers URL for clean outlet+critic → no collision', () => {
  const showDir = seedShow('beaches-2026-c', {
    'chicagotribune--chris-jones.json': {
      outletId: 'chicagotribune', criticName: 'Chris Jones',
      url: 'https://chicagotribune.com/2026/revival.html',
      publishDate: '2026-04-22',
      // NO wrongProduction flag
    },
  });
  const result = detectIngestCollision({
    showDir, outletId: 'chicagotribune', criticName: 'Chris Jones',
    url: 'https://chicagotribune.com/2026/different-article.html',
    publishDate: '2026-04-23',
  });
  assert.equal(result.ok, true, 'no stale flag → gather-reviews should merge normally');
});

test('poller discovers URL with publishDate >365 days off from existing (likely different production)', () => {
  const showDir = seedShow('revival-2026', {
    'nytimes--jesse-green.json': {
      outletId: 'nytimes', criticName: 'Jesse Green',
      url: 'https://nytimes.com/2020/original-run.html',
      publishDate: '2020-01-15',
    },
  });
  const result = detectIngestCollision({
    showDir, outletId: 'nytimes', criticName: 'Jesse Green',
    url: 'https://nytimes.com/2026/revival.html',
    publishDate: '2026-04-24',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'publish-date-gap-exceeds-365-days');
  assert.ok(result.detail.diffDays > 365);
});

test('poller discovers URL matching outlet but different critic → no collision (different critics at same outlet are separate reviews)', () => {
  const showDir = seedShow('show-2026', {
    'chicagotribune--chris-jones.json': {
      outletId: 'chicagotribune', criticName: 'Chris Jones',
      url: 'https://chicagotribune.com/2015/old.html',
      wrongProduction: true,
    },
  });
  const result = detectIngestCollision({
    showDir, outletId: 'chicagotribune', criticName: 'Barbara Vitello',
    url: 'https://chicagotribune.com/2026/other-critic.html',
  });
  assert.equal(result.ok, true, 'stale flag on Jones file must not block a different Tribune critic');
});

test('Unknown critic hits any matching-outlet record (filename parts are <outlet>--unknown)', () => {
  const showDir = seedShow('show-2026-unk', {
    'nypost--unknown.json': {
      outletId: 'nypost', criticName: 'Unknown',
      url: 'https://nypost.com/2015/old.html',
      wrongProduction: true,
    },
  });
  const result = detectIngestCollision({
    showDir, outletId: 'nypost', criticName: 'Unknown',
    url: 'https://nypost.com/2026/new.html',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale-flag-on-existing-file');
});
