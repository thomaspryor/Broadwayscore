/**
 * Flip-flop corroboration tie-break (review-write-guard.js).
 *
 * Run: node --test scripts/lib/flip-flop-corroboration.test.mjs
 *
 * Regression: School Girls 2026-09-29. BWW's roundup linked Theatrely with a
 * stray trailing 'j' (a 404); Playbill Verdict had the real url. The poller
 * alternated between them and the BRO-121 breaker pinned the 404 because the
 * file happened to hold it, so the live site linked a dead page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const guard = require('./review-write-guard.js');
const { _flipFlopShouldTakeIncoming, safeWriteReview } = guard;

const BAD = 'https://www.theatrely.com/post/a-fabulous-school-girls-or-the-african-mean-girls-play-finally-makes-it-to-broadwayj';
const GOOD = 'https://www.theatrely.com/post/a-fabulous-school-girls-or-the-african-mean-girls-play-finally-makes-it-to-broadway';

test('tie-break takes the side an aggregator record vouches for', () => {
  assert.equal(_flipFlopShouldTakeIncoming(BAD, GOOD, { url: BAD, playbillVerdictUrl: GOOD }), true);
});

test('tie-break never leaves the corroborated side for an uncorroborated one', () => {
  assert.equal(_flipFlopShouldTakeIncoming(GOOD, BAD, { url: GOOD, playbillVerdictUrl: GOOD }), false);
});

test('no corroboration either way keeps the existing pin (old behaviour)', () => {
  assert.equal(_flipFlopShouldTakeIncoming(BAD, GOOD, { url: BAD }), false);
});

test('never hops to another host even if corroborated', () => {
  const other = 'https://www.example.com/review';
  assert.equal(_flipFlopShouldTakeIncoming(BAD, other, { url: BAD, playbillVerdictUrl: other }), false);
});

const theatrelyFixture = () => ({
  showId: 'school-girls-or-the-african-mean-girls-play-2026',
  outletId: 'theatrely',
  outlet: 'Theatrely',
  criticName: 'Joey Sims',
  url: BAD,
  playbillVerdictUrl: GOOD,
  urlVerified: true,
  urlVerifiedAuto: true,
  publishDate: '2026-09-28',
  contentTier: 'complete',
  fullText: 'x'.repeat(3000),
  _urlChangedClear: { from: GOOD, to: BAD, at: '2026-09-29T02:33:51.152Z', cleared: [] },
});

test('real write path (createOrMergeReviewFile): the aggregator-corroborated url replaces an auto-pinned 404', () => {
  const { createOrMergeReviewFile } = require('./review-file-writer.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flipflop-writer-'));
  const showDir = path.join(root, 'school-girls-or-the-african-mean-girls-play-2026');
  fs.mkdirSync(showDir);
  const fp = path.join(showDir, 'theatrely--joey-sims.json');
  fs.writeFileSync(fp, JSON.stringify(theatrelyFixture(), null, 2));
  createOrMergeReviewFile('school-girls-or-the-african-mean-girls-play-2026', {
    outletId: 'theatrely', outlet: 'Theatrely', criticName: 'Joey Sims', url: GOOD, source: 'playbill-verdict',
  }, { reviewTextsDir: root });
  const written = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert.equal(written.url, GOOD);
  assert.notEqual(written.urlVerifiedAuto, true, 'the auto pin on the 404 must be lifted');
});

test('real write path: a HUMAN pin is never overridden by corroboration', () => {
  const { createOrMergeReviewFile } = require('./review-file-writer.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flipflop-human-'));
  const showDir = path.join(root, 'school-girls-or-the-african-mean-girls-play-2026');
  fs.mkdirSync(showDir);
  const fp = path.join(showDir, 'theatrely--joey-sims.json');
  const human = { ...theatrelyFixture(), urlVerifiedAuto: undefined };
  fs.writeFileSync(fp, JSON.stringify(human, null, 2));
  createOrMergeReviewFile('school-girls-or-the-african-mean-girls-play-2026', {
    outletId: 'theatrely', outlet: 'Theatrely', criticName: 'Joey Sims', url: GOOD, source: 'playbill-verdict',
  }, { reviewTextsDir: root });
  assert.equal(JSON.parse(fs.readFileSync(fp, 'utf8')).url, BAD);
});

test('an incoming write cannot vouch for itself (only the on-file record corroborates)', () => {
  assert.equal(_flipFlopShouldTakeIncoming(GOOD, BAD, { url: GOOD }), false);
});

test('end to end: an auto-pinned 404 url is replaced by the corroborated url on write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipflop-'));
  const showDir = path.join(dir, 'school-girls-or-the-african-mean-girls-play-2026');
  fs.mkdirSync(showDir);
  const fp = path.join(showDir, 'theatrely--joey-sims.json');
  const existing = {
    showId: 'school-girls-or-the-african-mean-girls-play-2026',
    outletId: 'theatrely',
    outlet: 'Theatrely',
    criticName: 'Joey Sims',
    url: BAD,
    playbillVerdictUrl: GOOD,
    urlVerified: true,
    urlVerifiedAuto: true,
    _urlChangedClear: { from: GOOD, to: BAD, at: '2026-09-29T02:33:51.152Z', cleared: [] },
  };
  fs.writeFileSync(fp, JSON.stringify(existing, null, 2));
  safeWriteReview(fp, { ...existing, url: GOOD });
  const written = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert.equal(written.url, GOOD);
});
