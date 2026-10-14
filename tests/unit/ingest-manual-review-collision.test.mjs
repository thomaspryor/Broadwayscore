/**
 * Regression test for Beaches 2026-04-22 postmortem #9.
 *
 * A 2015 Chicago Tribune chris-jones file with wrongProduction:true was
 * merged with a 2026 URL during manual ingest — the stale flag was preserved
 * and the new review silently dropped from rebuild. detectIngestCollision()
 * must catch this case before createOrMergeReviewFile runs.
 *
 * Run: node --test tests/unit/ingest-manual-review-collision.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectIngestCollision } = require('../../scripts/lib/manual-review-fields.js');

let tmpShowDir;

before(() => {
  tmpShowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-collision-'));
});

after(() => {
  fs.rmSync(tmpShowDir, { recursive: true, force: true });
});

function writeFixture(filename, data) {
  fs.writeFileSync(path.join(tmpShowDir, filename), JSON.stringify(data, null, 2));
}

test('flags wrongProduction stale-flag with different URL', () => {
  writeFixture('chicagotribune--chris-jones.json', {
    outletId: 'chicagotribune',
    criticName: 'Chris Jones',
    url: 'https://chicagotribune.com/2015/01/01/old-review.html',
    publishDate: '2015-01-01',
    wrongProduction: true,
  });

  const r = detectIngestCollision({
    showDir: tmpShowDir,
    outletId: 'chicagotribune',
    criticName: 'Chris Jones',
    url: 'https://chicagotribune.com/2026/04/22/new-review.html',
    publishDate: '2026-04-22',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stale-flag-on-existing-file');
  assert.equal(r.file, 'chicagotribune--chris-jones.json');
  assert.equal(r.detail.existingFlags.wrongProduction, true);
});

test('allows same-URL re-ingest even with stale flag (treat as clearing flag)', () => {
  // Different show dir to avoid interference
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-collision-same-'));
  const url = 'https://chicagotribune.com/2026/04/22/new-review.html';
  fs.writeFileSync(path.join(dir, 'chicagotribune--chris-jones.json'), JSON.stringify({
    outletId: 'chicagotribune',
    criticName: 'Chris Jones',
    url,
    wrongProduction: true,
  }));
  const r = detectIngestCollision({
    showDir: dir,
    outletId: 'chicagotribune',
    criticName: 'Chris Jones',
    url,
  });
  assert.equal(r.ok, true, 'same URL → intent is to fix the same record');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('flags publishDate gap >365 days even without stale flag', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-collision-date-'));
  fs.writeFileSync(path.join(dir, 'nytimes--jesse-green.json'), JSON.stringify({
    outletId: 'nytimes',
    criticName: 'Jesse Green',
    url: 'https://nytimes.com/2020/old-revival.html',
    publishDate: '2020-06-10',
  }));
  const r = detectIngestCollision({
    showDir: dir,
    outletId: 'nytimes',
    criticName: 'Jesse Green',
    url: 'https://nytimes.com/2026/new-revival.html',
    publishDate: '2026-04-22',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'publish-date-gap-exceeds-365-days');
  assert.ok(r.detail.diffDays > 365);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--force-clear-stale-flag bypasses both checks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-collision-force-'));
  fs.writeFileSync(path.join(dir, 'chicagotribune--chris-jones.json'), JSON.stringify({
    outletId: 'chicagotribune',
    criticName: 'Chris Jones',
    url: 'https://chicagotribune.com/2015/old.html',
    publishDate: '2015-01-01',
    wrongProduction: true,
  }));
  const r = detectIngestCollision({
    showDir: dir,
    outletId: 'chicagotribune',
    criticName: 'Chris Jones',
    url: 'https://chicagotribune.com/2026/new.html',
    publishDate: '2026-04-22',
    forceClearStale: true,
  });
  assert.equal(r.ok, true, 'explicit force flag must bypass');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no collision when outlet differs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-collision-outlet-'));
  fs.writeFileSync(path.join(dir, 'chicagotribune--chris-jones.json'), JSON.stringify({
    outletId: 'chicagotribune',
    criticName: 'Chris Jones',
    wrongProduction: true,
  }));
  const r = detectIngestCollision({
    showDir: dir,
    outletId: 'variety',
    criticName: 'Chris Jones',
    url: 'https://variety.com/new.html',
  });
  assert.equal(r.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('query params that only track redirects do not escape the same-URL allowance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-collision-params-'));
  fs.writeFileSync(path.join(dir, 'cote-notices--david-finkle.json'), JSON.stringify({
    outletId: 'cote-notices',
    criticName: 'David Finkle',
    url: 'https://davidcote1.substack.com/p/post-one',
    wrongProduction: true,
  }));
  // ?triedRedirect=true is the Rocky Horror case — same article, tracking param added
  const r = detectIngestCollision({
    showDir: dir,
    outletId: 'cote-notices',
    criticName: 'David Finkle',
    url: 'https://davidcote1.substack.com/p/post-one?triedRedirect=true',
  });
  assert.equal(r.ok, true, 'tracking-only param variation must be treated as same URL');
  fs.rmSync(dir, { recursive: true, force: true });
});
