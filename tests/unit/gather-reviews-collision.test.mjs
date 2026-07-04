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

// ── Revival / returning-production carve-out (2026-07-04, To Kill a Mockingbird WE) ──
// When openingDate is supplied and the incoming review's publishDate falls in this
// production's opening window, a stale prior-production file for the same outlet is a
// sibling, not a duplicate — the fresh review must NOT be blocked. This is the systemic
// West End failure: revivals/returns reviewed by the same critics left every major outlet
// with a prior-production file, dropping every fresh review. See feedback memory.

test('CARVE-OUT: fresh current-production review (in opening window) is ALLOWED despite stale prior-production file', () => {
  const showDir = seedShow('to-kill-a-mockingbird-we-2026', {
    'standard--nick-curtis.json': {
      outletId: 'standard', criticName: 'Nick Curtis',
      url: 'https://www.standard.co.uk/culture/theatre/tkam-gielgud-2022.html',
      publishDate: '2022-04-01',
      wrongProduction: true,
    },
  });
  const result = detectIngestCollision({
    showDir, outletId: 'standard', criticName: 'Nick Curtis',
    url: 'https://www.standard.co.uk/culture/theatre/tkam-wyndhams-2026.html',
    publishDate: '2026-07-01',
    openingDate: '2026-06-30',
  });
  assert.equal(result.ok, true, 'a fresh review in the opening window must ingest even when a prior-production file exists');
});

test('CARVE-OUT: unknown-critic fresh review (in window) ALLOWED against a stale named-critic file at same outlet', () => {
  const showDir = seedShow('tkam-we-2026-unk', {
    'times-uk--clive-davis.json': {
      outletId: 'times-uk', criticName: 'Clive Davis',
      url: 'https://www.thetimes.co.uk/article/tkam-gielgud-2022',
      publishDate: '2022-04-01',
      wrongProduction: true,
    },
  });
  const result = detectIngestCollision({
    showDir, outletId: 'times-uk', criticName: 'Unknown',
    url: 'https://www.thetimes.co.uk/article/tkam-wyndhams-2026',
    publishDate: '2026-07-01',
    openingDate: '2026-06-30',
  });
  assert.equal(result.ok, true);
});

test('CARVE-OUT: re-discovery of the OLD production URL (out of window) is still BLOCKED even with openingDate', () => {
  const showDir = seedShow('tkam-we-2026-old', {
    'guardian--arifa-akbar.json': {
      outletId: 'guardian', criticName: 'Arifa Akbar',
      url: 'https://www.theguardian.com/stage/2022/mar/31/tkam-full',
      publishDate: '2022-04-01',
      wrongProduction: true,
    },
  });
  const result = detectIngestCollision({
    showDir, outletId: 'guardian', criticName: 'Arifa Akbar',
    url: 'https://www.theguardian.com/stage/2022/mar/31/tkam-short',
    publishDate: '2022-03-31',
    openingDate: '2026-06-30',
  });
  assert.equal(result.ok, false, 'a 2022-dated re-discovery is not the current production — stays blocked');
  assert.equal(result.reason, 'stale-flag-on-existing-file');
});

test('CARVE-OUT: dateless incoming stays BLOCKED even with openingDate (cannot prove current production)', () => {
  const showDir = seedShow('tkam-we-2026-nodate', {
    'standard--nick-curtis.json': {
      outletId: 'standard', criticName: 'Nick Curtis',
      url: 'https://www.standard.co.uk/culture/theatre/tkam-gielgud-2022.html',
      publishDate: '2022-04-01',
      wrongProduction: true,
    },
  });
  const result = detectIngestCollision({
    showDir, outletId: 'standard', criticName: 'Nick Curtis',
    url: 'https://www.standard.co.uk/culture/theatre/tkam-wyndhams-2026.html',
    openingDate: '2026-06-30',
  });
  assert.equal(result.ok, false, 'no publishDate → cannot confirm current production → conservative block preserved');
});

test('CARVE-OUT: publish-date-gap block is also suppressed for an in-window current-production review', () => {
  const showDir = seedShow('revival-gap-2026', {
    'nytimes--jesse-green.json': {
      outletId: 'nytimes', criticName: 'Jesse Green',
      url: 'https://nytimes.com/2020/original-run.html',
      publishDate: '2020-01-15',
      // NOTE: no wrongProduction flag — this exercises the >365d gap branch specifically
    },
  });
  const result = detectIngestCollision({
    showDir, outletId: 'nytimes', criticName: 'Jesse Green',
    url: 'https://nytimes.com/2026/revival.html',
    publishDate: '2026-06-30',
    openingDate: '2026-06-30',
  });
  assert.equal(result.ok, true, 'in-window review must not be blocked by the >365d gap against a prior run');
});
