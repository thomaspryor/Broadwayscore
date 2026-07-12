/**
 * Regression tests for dedupe-same-url-bylines.js — the same-URL / multi-byline
 * double-count class (Notion 2026-07-12).
 *
 * Covers: cohesion detection, the rebuild-already-collapses skip (so we don't
 * touch what the rebuild's fingerprint/fuzzy dedup already handles), the safety
 * boundary (genuinely-different text at one URL is NEVER collapsed), and the
 * end-to-end audit → fix collapse.
 *
 * Run: node --test tests/unit/same-url-byline-dedup.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'su-dedup-'));
process.env.REVIEW_TEXTS_DIR = FIXTURE;
const {
  jaccard, isCohesiveGroup, rebuildAlreadyCollapses, audit, fix,
} = require('../../scripts/dedupe-same-url-bylines.js');

const shared = 'A substantive critic review with a clear verdict and thoughtful analysis of the staging and performances. '.repeat(20);
const complete = (over = {}) => ({ contentTier: 'complete', isFullReview: true, fullText: shared, assignedScore: 80, ...over });

function writeShow(showId, files) {
  const dir = path.join(FIXTURE, showId);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
  return dir;
}

test('jaccard: identical → 1, disjoint → 0', () => {
  assert.equal(jaccard('alpha beta gamma delta', 'alpha beta gamma delta'), 1);
  assert.equal(jaccard('alpha beta gamma', 'kappa lambda omega'), 0);
});

test('isCohesiveGroup: same fingerprint OR high Jaccard true; low Jaccard false', () => {
  assert.equal(isCohesiveGroup([{ fullText: shared }, { fullText: shared }]), true);
  assert.equal(isCohesiveGroup([{ fullText: 'NAV BREADCRUMB ' + shared }, { fullText: shared }]), true); // boilerplate prefix
  assert.equal(isCohesiveGroup([{ fullText: 'wholly different words here about nothing '.repeat(20) }, { fullText: shared }]), false);
  assert.equal(isCohesiveGroup([{ fullText: shared }, { fullText: '' }]), false); // missing text → cannot confirm
});

test('rebuildAlreadyCollapses: identical fingerprint (long) → true (rebuild handles it)', () => {
  assert.equal(rebuildAlreadyCollapses(['a.json', 'b.json'], [complete(), complete()]), true);
});

test('rebuildAlreadyCollapses: fuzzy-variant bylines → true', () => {
  // handled by the rebuild's fuzzy-critic URL dedup; criticName drives it
  const a = complete({ criticName: 'Isabella Biedenharn' });
  const b = complete({ criticName: 'Isabella Biedenahrn' }); // typo, Levenshtein ≤ 2
  assert.equal(rebuildAlreadyCollapses(['ew--isabella-biedenharn.json', 'ew--isabella-biedenahrn.json'], [a, b]), true);
});

test('rebuildAlreadyCollapses: distinct critics + distinct fingerprint → false (we target these)', () => {
  const a = complete({ criticName: 'Ben Brantley', fullText: 'BREADCRUMB SHARE ADVERTISEMENT ' + shared });
  const b = complete({ criticName: 'Charles Isherwood', fullText: shared });
  assert.equal(rebuildAlreadyCollapses(['nytimes--ben-brantley.json', 'nytimes--charles-isherwood.json'], [a, b]), false);
});

test('audit + fix: distinct-fingerprint cohesive group collapses to one canonical', () => {
  const url = 'https://www.nytimes.com/2014/all-the-way-review.html';
  writeShow('all-the-way-2014', {
    'nytimes--ben-brantley.json': complete({ url, criticName: 'Ben Brantley', fullText: 'Share full article Advertisement ' + shared }),
    'nytimes--charles-isherwood.json': complete({ url, criticName: 'Charles Isherwood', fullText: shared }),
  });
  const { cohesive } = audit();
  const g = cohesive.find(x => x.showId === 'all-the-way-2014');
  assert.ok(g, 'group detected as cohesive/collapsible');
  assert.equal(g.losers.length, 1);

  fix(cohesive.filter(x => x.showId === 'all-the-way-2014'));
  const canon = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'all-the-way-2014', g.canonical), 'utf-8'));
  const loser = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'all-the-way-2014', g.losers[0]), 'utf-8'));
  assert.equal(canon.duplicateOf ?? null, null, 'canonical stays primary');
  assert.equal(loser.duplicateOf, g.canonical, 'loser marked duplicateOf canonical');
  assert.ok(loser.duplicateReason, 'reason recorded');
});

test('safety: genuinely-different text at one URL is NEVER collapsed (reported instead)', () => {
  const url = 'https://www.nytimes.com/2024/once-upon-a-mattress-review.html';
  writeShow('once-upon-a-mattress-2024', {
    'nytimes--elisabeth-vincentelli.json': complete({ url, criticName: 'Elisabeth Vincentelli', fullText: 'Some casting choices are blindingly obvious and that makes them right for this delightful revival with its game star. '.repeat(15) }),
    'nytimes--jesse-green.json': complete({ url, criticName: 'Jesse Green', fullText: 'Princess Winnifred and Prince Dauntless are goofy playful characters providing comic relief throughout the evening tonight. '.repeat(15) }),
  });
  const { cohesive, different } = audit();
  assert.equal(cohesive.some(x => x.showId === 'once-upon-a-mattress-2024'), false, 'must NOT collapse two different reviews');
  assert.ok(different.some(x => x.showId === 'once-upon-a-mattress-2024'), 'reported for triage instead');
});
