// BRO-2559 — a scraper RECREATING a review file drops PROTECTED_FIELDS.
//
// safeWriteReview's merge/preserve loop only has something to preserve FROM when
// a file already sits at the target path. Two real-corpus shapes silently defeat
// that:
//
//   1. A scraper writes a brand-new object with `merge:false` straight to a path
//      that ALREADY holds a manually-flagged file (wrongProduction=true etc). This
//      already worked correctly before this ticket (the preserve loop reads
//      `existing` off disk regardless of the merge option) — pinned here as a
//      regression guard per the ticket's own acceptance criterion.
//
//   2. A review's identity gets RENAMED to a different filename (e.g. a
//      byline-correction moves variety--bob-verini.json's content to
//      variety--ellise-shafer.json, recording the old url on the new file's
//      `previousUrl`), which leaves the OLD filename's path empty. A later
//      writer (a stale aggregator page that never re-scraped) recreates a file
//      at that empty path for the SAME url. Because the target path has nothing
//      on disk to merge from, a manually-set wrongProduction/wrongShow verdict
//      that still lives on the renamed sibling never reaches the recreated
//      file — reproducing the-producers-west-end-2025/variety--bob-verini.json
//      (flagged 6092d7b42ac, dropped by "data: Scrape BWW Reviews", re-flagged
//      b7b31d3285a). safeWriteReview now rescues the verdict from that orphaned
//      sibling before writing.
//
// These tests drive the REAL exported functions, per CLAUDE.md rule 15 — no
// copied logic.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { safeWriteReview } = require('./review-write-guard.js');

// A show id deliberately absent from shows.json — safeWriteReview's
// date-plausibility quarantine only fires when the parent dir resolves to a
// real show, so an unknown id keeps that guard out of the way and makes these
// assertions about protected-field preservation alone.
const FIXTURE_SHOW = 'zz-bro2559-fixture-2026';

function makeShowDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2559-'));
  const showDir = path.join(dir, FIXTURE_SHOW);
  fs.mkdirSync(showDir, { recursive: true });
  return showDir;
}

test('fresh-object write over an existing wrongProduction=true file preserves the flag', () => {
  const showDir = makeShowDir();
  const filePath = path.join(showDir, 'variety--bob-verini.json');
  fs.writeFileSync(filePath, JSON.stringify({
    showId: FIXTURE_SHOW,
    outletId: 'variety',
    outlet: 'Variety',
    criticName: 'Bob Verini',
    url: 'http://www.variety.com/review/VE1117947963?refCatId=33',
    wrongProduction: true,
    wrongProductionReason: 'manual flag: 2012 Hollywood Bowl content misattached to this production',
  }, null, 2));

  // A scraper re-discovering the same outlet/critic slot writes a brand-new
  // object (no wrongProduction field at all) with merge disabled — the exact
  // shape createOrMergeReviewFile's "new" branch uses.
  const fresh = {
    showId: FIXTURE_SHOW,
    outletId: 'variety',
    outlet: 'Variety',
    criticName: 'Bob Verini',
    url: 'http://www.variety.com/review/VE1117947963?refCatId=33',
    source: 'bww-roundup',
  };

  const result = safeWriteReview(filePath, fresh, { merge: false });
  assert.strictEqual(result.wrote, true);
  assert.ok(result.preserved.includes('wrongProduction'), 'wrongProduction must be preserved');
  assert.ok(result.preserved.includes('wrongProductionReason'), 'wrongProductionReason must be preserved');

  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  assert.strictEqual(onDisk.wrongProduction, true);
  assert.strictEqual(
    onDisk.wrongProductionReason,
    'manual flag: 2012 Hollywood Bowl content misattached to this production'
  );
});

test('recreating a review under a DIFFERENT filename rescues a live wrongProduction verdict from the orphaned sibling', () => {
  const showDir = makeShowDir();
  const legacyUrl = 'http://www.variety.com/review/VE1117947963?refCatId=33';

  // The renamed sibling: byline-correction moved the content elsewhere,
  // recording the OLD url as previousUrl. Still carries the live verdict —
  // simulating a rename that did NOT go through url-change-invariant's clear
  // (e.g. a bespoke rename script), the shape this rescue exists to catch.
  fs.writeFileSync(path.join(showDir, 'variety--ellise-shafer.json'), JSON.stringify({
    showId: FIXTURE_SHOW,
    outletId: 'variety',
    outlet: 'Variety',
    criticName: 'Ellise Shafer',
    url: 'https://variety.com/2026/theater/global/some-other-article/',
    previousUrl: legacyUrl,
    wrongProduction: true,
    wrongProductionReason: 'manual flag: 2012 Hollywood Bowl content misattached to this production',
  }, null, 2));

  // BWW's stale roundup page still lists the old byline + legacy url, so its
  // scraper recreates the OLD filename fresh — nothing exists at this exact
  // path, so there is nothing to merge from at filePath itself.
  const filePath = path.join(showDir, 'variety--bob-verini.json');
  const fresh = {
    showId: FIXTURE_SHOW,
    outletId: 'variety',
    outlet: 'Variety',
    criticName: 'Bob Verini',
    url: legacyUrl,
    source: 'bww-roundup',
  };

  const result = safeWriteReview(filePath, fresh, { merge: false });
  assert.strictEqual(result.wrote, true);

  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  assert.strictEqual(onDisk.wrongProduction, true, 'wrongProduction must be rescued from the orphaned sibling');
  assert.strictEqual(
    onDisk.wrongProductionReason,
    'manual flag: 2012 Hollywood Bowl content misattached to this production'
  );
  assert.strictEqual(onDisk._orphanedVerdictRescuedFrom, 'variety--ellise-shafer.json');
});

test('orphan rescue does not fire when the sibling url does not match', () => {
  const showDir = makeShowDir();

  fs.writeFileSync(path.join(showDir, 'variety--ellise-shafer.json'), JSON.stringify({
    showId: FIXTURE_SHOW,
    outletId: 'variety',
    outlet: 'Variety',
    criticName: 'Ellise Shafer',
    url: 'https://variety.com/2026/theater/global/some-other-article/',
    wrongProduction: true,
    wrongProductionReason: 'unrelated verdict for a different article',
  }, null, 2));

  const filePath = path.join(showDir, 'variety--bob-verini.json');
  const fresh = {
    showId: FIXTURE_SHOW,
    outletId: 'variety',
    outlet: 'Variety',
    criticName: 'Bob Verini',
    url: 'http://www.variety.com/review/VE1117947963?refCatId=33',
    source: 'bww-roundup',
  };

  const result = safeWriteReview(filePath, fresh, { merge: false });
  assert.strictEqual(result.wrote, true);

  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  assert.strictEqual(onDisk.wrongProduction, undefined, 'must not rescue an unrelated sibling verdict');
  assert.strictEqual(onDisk._orphanedVerdictRescuedFrom, undefined);
});

test('orphan rescue does not fire across different outlets even with a matching url', () => {
  const showDir = makeShowDir();
  const sharedUrl = 'https://www.westendtheatre.com/roundup/some-show';

  // A same-outlet-different-critic sibling would be a rescue target; a
  // DIFFERENT outlet sharing an aggregator roundup URL (a real, documented
  // corpus pattern) must never be treated as the same identity.
  fs.writeFileSync(path.join(showDir, 'telegraph--dominic-cavendish.json'), JSON.stringify({
    showId: FIXTURE_SHOW,
    outletId: 'telegraph',
    outlet: 'The Telegraph',
    criticName: 'Dominic Cavendish',
    url: sharedUrl,
    wrongProduction: true,
    wrongProductionReason: 'Telegraph-specific verdict',
  }, null, 2));

  const filePath = path.join(showDir, 'guardian--unknown.json');
  const fresh = {
    showId: FIXTURE_SHOW,
    outletId: 'guardian',
    outlet: 'The Guardian',
    criticName: 'Unknown',
    url: sharedUrl,
    source: 'west-end-theatre',
  };

  const result = safeWriteReview(filePath, fresh, { merge: false });
  assert.strictEqual(result.wrote, true);

  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  assert.strictEqual(onDisk.wrongProduction, undefined, 'must not rescue a different outlet\'s verdict');
});

test('a plain new review with no orphaned sibling writes cleanly', () => {
  const showDir = makeShowDir();
  const filePath = path.join(showDir, 'nytimes--jesse-green.json');
  const fresh = {
    showId: FIXTURE_SHOW,
    outletId: 'nytimes',
    outlet: 'The New York Times',
    criticName: 'Jesse Green',
    url: 'https://www.nytimes.com/2026/01/01/theater/some-review.html',
    source: 'gather-reviews',
  };

  const result = safeWriteReview(filePath, fresh, { merge: false });
  assert.strictEqual(result.wrote, true);
  assert.deepStrictEqual(result.preserved, []);

  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  assert.strictEqual(onDisk.wrongProduction, undefined);
  assert.strictEqual(onDisk._orphanedVerdictRescuedFrom, undefined);
});

test('orphan rescue respects force: true (bypasses protection like every other guard)', () => {
  const showDir = makeShowDir();
  const legacyUrl = 'http://www.variety.com/review/VE1117947963?refCatId=33';

  fs.writeFileSync(path.join(showDir, 'variety--ellise-shafer.json'), JSON.stringify({
    showId: FIXTURE_SHOW,
    outletId: 'variety',
    outlet: 'Variety',
    criticName: 'Ellise Shafer',
    url: 'https://variety.com/2026/theater/global/some-other-article/',
    previousUrl: legacyUrl,
    wrongProduction: true,
    wrongProductionReason: 'manual flag',
  }, null, 2));

  const filePath = path.join(showDir, 'variety--bob-verini.json');
  const fresh = {
    showId: FIXTURE_SHOW,
    outletId: 'variety',
    outlet: 'Variety',
    criticName: 'Bob Verini',
    url: legacyUrl,
    source: 'bww-roundup',
  };

  const result = safeWriteReview(filePath, fresh, { merge: false, force: true });
  assert.strictEqual(result.wrote, true);

  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  assert.strictEqual(onDisk.wrongProduction, undefined, 'force:true intentionally bypasses the rescue');
});
