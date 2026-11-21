/**
 * safeWriteReview() cross-market (class-A) ingest quarantine — card #1085.
 *
 * Replays the incident that kept main red: gather for the La Jolla tryout
 * 'the-outsiders-world-premiere-regional-2023' (opened 2023-03-07) wrote EW and
 * TheWrap reviews of the BROADWAY production dated 2024-04-11 — 0 days from
 * the-outsiders-2024's opening, 401 from the tryout's. A human deleted them on
 * 2026-08-06; the Weekly review refresh cron (extract-dtli-reviews.js) put them
 * straight back 17h later, because the guard added that day lives inline in
 * gather-reviews.js's saveReview and DTLI extraction never goes through it.
 *
 * The guard now sits at the shared write chokepoint, so these tests exercise the
 * REAL safeWriteReview (CLAUDE.md rule 15) rather than re-implementing the
 * predicate — a regression in review-write-guard.js must fail here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { safeWriteReview, _setShowsCacheForTest } = require('./review-write-guard.js');

const TRYOUT = 'the-outsiders-world-premiere-regional-2023';
const BROADWAY = 'the-outsiders-2024';

// The real pair, verbatim from data/shows.json.
function seedOutsiders() {
  _setShowsCacheForTest(new Map([
    [TRYOUT, { id: TRYOUT, title: 'The Outsiders', openingDate: '2023-03-07' }],
    [BROADWAY, { id: BROADWAY, title: 'The Outsiders', openingDate: '2024-04-11' }],
  ]));
}

function tmpCorpus() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xmarket-'));
  fs.mkdirSync(path.join(root, TRYOUT), { recursive: true });
  fs.mkdirSync(path.join(root, BROADWAY), { recursive: true });
  return root;
}

test('#1085 replay: a Broadway-dated review written into the tryout dir is quarantined, not filed', () => {
  seedOutsiders();
  const root = tmpCorpus();
  const target = path.join(root, TRYOUT, 'thewrap--robert-hofler.json');

  const result = safeWriteReview(target, {
    publishDate: 'April 11, 2024',
    criticName: 'Robert Hofler',
    outletId: 'thewrap',
    url: 'https://www.thewrap.com/the-outsiders-broadway-review-improves-coppola-cult-classic/',
  });

  assert.equal(result.wrote, false);
  assert.equal(result.skipped, 'cross_market_contamination');
  assert.equal(fs.existsSync(target), false, 'must NOT land in the tryout show dir');

  const pending = path.join(root, '_pending', TRYOUT, 'thewrap--robert-hofler.json');
  assert.equal(fs.existsSync(pending), true, 'must be recoverable from _pending/');
  const quarantined = JSON.parse(fs.readFileSync(pending, 'utf8'));
  assert.equal(quarantined.pendingReason, 'cross_market_contamination');
  assert.match(quarantined._crossMarketDetail, /belongs to the sibling/);
  // Round-trip the numbers the audit reports, so a predicate drift is visible.
  assert.equal(Math.round(result.sibDiff), 0);
  assert.equal(Math.round(result.thisDiff), 401);
});

test('the same review filed under the Broadway show writes normally', () => {
  seedOutsiders();
  const root = tmpCorpus();
  const target = path.join(root, BROADWAY, 'thewrap--robert-hofler.json');

  const result = safeWriteReview(target, {
    publishDate: 'April 11, 2024',
    criticName: 'Robert Hofler',
    outletId: 'thewrap',
    url: 'https://www.thewrap.com/the-outsiders-broadway-review-improves-coppola-cult-classic/',
  });

  assert.notEqual(result.skipped, 'cross_market_contamination');
  assert.equal(fs.existsSync(target), true);
});

test('a review dated on the tryout\'s own opening is untouched (no false positive)', () => {
  seedOutsiders();
  const root = tmpCorpus();
  const target = path.join(root, TRYOUT, 'latimes--charles-mcnulty.json');

  const result = safeWriteReview(target, {
    publishDate: 'March 8, 2023',
    criticName: 'Charles McNulty',
    outletId: 'latimes',
    url: 'https://www.latimes.com/entertainment-arts/story/the-outsiders-review',
  });

  assert.notEqual(result.skipped, 'cross_market_contamination');
  assert.equal(fs.existsSync(target), true);
});

test('_auditAllowCrossMarket — the audit\'s own manual allowlist — opts a write out here too', () => {
  seedOutsiders();
  const root = tmpCorpus();
  const target = path.join(root, TRYOUT, 'ew--emlyn-travis.json');

  const result = safeWriteReview(target, {
    publishDate: 'April 11, 2024',
    criticName: 'Emlyn Travis',
    outletId: 'ew',
    url: 'https://ew.com/the-outsiders-review-broadway-musical-8629965',
    _auditAllowCrossMarket: true,
  });

  assert.notEqual(result.skipped, 'cross_market_contamination');
  assert.equal(fs.existsSync(target), true);
});

test('a show with no same-title sibling can never trip the guard', () => {
  _setShowsCacheForTest(new Map([
    ['solo-show-2024', { id: 'solo-show-2024', title: 'Solo Show', openingDate: '2024-01-10' }],
  ]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xmarket-solo-'));
  fs.mkdirSync(path.join(root, 'solo-show-2024'), { recursive: true });
  const target = path.join(root, 'solo-show-2024', 'nytimes--jesse-green.json');

  // Deliberately far from its own opening — without a sibling there is nothing
  // to attribute it to, so the guard must stay out of the way.
  const result = safeWriteReview(target, {
    publishDate: 'December 1, 2025',
    criticName: 'Jesse Green',
    outletId: 'nytimes',
    url: 'https://www.nytimes.com/2025/12/01/theater/solo-show-review.html',
  });

  assert.notEqual(result.skipped, 'cross_market_contamination');
  assert.equal(fs.existsSync(target), true);
});

test('an unparseable publishDate is a no-op, not a crash or a silent drop', () => {
  seedOutsiders();
  const root = tmpCorpus();
  const target = path.join(root, TRYOUT, 'playbill--margaret-hall.json');

  const result = safeWriteReview(target, {
    publishDate: 'not a date',
    criticName: 'Margaret Hall',
    outletId: 'playbill',
    url: 'https://playbill.com/article/the-outsiders-review',
  });

  assert.notEqual(result.skipped, 'cross_market_contamination');
  assert.equal(fs.existsSync(target), true);
});

test('an already-scored file getting a corrected date is a deliberate fixup, not new ingest', () => {
  seedOutsiders();
  const root = tmpCorpus();
  const target = path.join(root, TRYOUT, 'deadline--greg-evans.json');
  // Pre-existing file carrying scored content — protected, so out of ingest scope.
  fs.writeFileSync(target, JSON.stringify({
    publishDate: 'March 9, 2023',
    criticName: 'Greg Evans',
    outletId: 'deadline',
    assignedScore: 78,
    fullText: 'x'.repeat(600),
  }, null, 2));

  const result = safeWriteReview(target, {
    publishDate: 'April 11, 2024',
    criticName: 'Greg Evans',
    outletId: 'deadline',
    assignedScore: 78,
    fullText: 'x'.repeat(600),
  });

  assert.notEqual(result.skipped, 'cross_market_contamination');
  assert.equal(fs.existsSync(target), true);
});
