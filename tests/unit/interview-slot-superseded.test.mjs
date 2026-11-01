/**
 * BRO-6742: an interview held the critic's outlet+critic slot, so the same
 * critic's review of the show could never be ingested ("Stale merge").
 * Read About Stuff's Dan English interviewed the writers of Memoriam and The
 * Moth (Oct 2026) and reviewed both shows days later; the interviews stayed
 * in the slots (one was even scored as a review) and every ingest of the
 * reviews failed. Exercises the real predicate and the real writer.
 *
 * Run: node --test tests/unit/interview-slot-superseded.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isInterviewSlotSupersededBy } = require('../../scripts/lib/review-slot-guards.js');
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer.js');

const SHOW = {
  id: 'memoriam-off-west-end-2026', title: 'Memoriam', venue: 'Southwark Playhouse Borough',
  category: 'off-west-end', openingDate: '2026-10-24', previewsStartDate: '2026-10-22',
};
const INTERVIEW = {
  outletId: 'readaboutstuff', outlet: 'Read About Stuff', criticName: 'Dan English',
  url: 'https://readaboutstuff.com/2026/10/15/interview-noga-flaishon-discusses-memoriam/',
  publishDate: '2026-10-15', contentTier: 'complete',
  fullText: 'An interview with the writer about the making of the play. '.repeat(40),
};
const REVIEW_URL = 'https://readaboutstuff.com/2026/10/27/review-memoriam-southwark-playhouse-borough-london/';

test('an interview slot gives way to the same outlet\'s review url', () => {
  assert.equal(isInterviewSlotSupersededBy(INTERVIEW, REVIEW_URL), true);
  assert.equal(isInterviewSlotSupersededBy(
    { url: 'https://example.com/interviews/the-moth-writer/' }, 'https://example.com/reviews/the-moth/'), true);
});

test('never moves a slot unless both urls say so', () => {
  // Existing slug is a review that mentions an interview (5 of 7 live interview-slug rows).
  assert.equal(isInterviewSlotSupersededBy(
    { url: 'https://culturesauce.com/2025/09/28/rupert-murdoch-final-interview-off-broadway-review/' },
    'https://culturesauce.com/2025/10/01/another-review/'), false);
  // Existing is a feature with no interview marker (Oakland Press, Dirty Dancing).
  assert.equal(isInterviewSlotSupersededBy(
    { url: 'https://www.theoaklandpress.com/2026/10/09/garden-city-actor-is-having-the-time-of-his-life/' },
    'https://www.theoaklandpress.com/2026/10/15/dirty-dancing-review/'), false);
  // Incoming does not say review.
  assert.equal(isInterviewSlotSupersededBy(INTERVIEW, 'https://readaboutstuff.com/2026/10/27/memoriam-southwark/'), false);
  // Different publication.
  assert.equal(isInterviewSlotSupersededBy(INTERVIEW, 'https://www.thestage.co.uk/reviews/memoriam-review'), false);
  // Same url.
  assert.equal(isInterviewSlotSupersededBy(INTERVIEW, INTERVIEW.url), false);
  // "interviewing" is not the interview marker.
  assert.equal(isInterviewSlotSupersededBy(
    { url: 'https://example.com/2026/interviewing-the-cast-on-tour/' }, 'https://example.com/2026/review-x/'), false);
});

test('a human url pin or a duplicate pointer always keeps the slot', () => {
  for (const pin of [{ _locked: true }, { urlManualOverride: true }, { urlVerified: true }, { duplicateOf: 'x.json' }]) {
    assert.equal(isInterviewSlotSupersededBy({ ...INTERVIEW, ...pin }, REVIEW_URL), false, JSON.stringify(pin));
  }
});

test('writer moves the slot to the review instead of refusing a stale merge', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-6742-'));
  const showDir = path.join(root, SHOW.id);
  fs.mkdirSync(showDir, { recursive: true });
  const file = path.join(showDir, 'readaboutstuff--dan-english.json');
  fs.writeFileSync(file, JSON.stringify({ ...INTERVIEW, showId: SHOW.id, assignedScore: 94 }));
  const res = createOrMergeReviewFile(SHOW.id, {
    outletId: 'readaboutstuff', outlet: 'Read About Stuff', criticName: 'Dan English',
    url: REVIEW_URL, source: 'url-ingest',
    fields: { publishDate: '2026-10-27', fullText: 'Memoriam at Southwark Playhouse is a review. '.repeat(40) },
  }, { reviewTextsDir: root, show: SHOW });
  assert.notEqual(res.action, 'skipped', JSON.stringify(res));
  const landed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(landed.url, REVIEW_URL);
  assert.equal(landed.publishDate, '2026-10-27');
  assert.match(landed.fullText, /is a review/);
  assert.notEqual(landed.assignedScore, 94, 'the interview\'s score must not ride onto the review');
  fs.rmSync(root, { recursive: true, force: true });
});
