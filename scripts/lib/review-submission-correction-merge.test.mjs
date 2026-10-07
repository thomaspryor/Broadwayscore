import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { mergeReviewSubmissionCorrections } = require('./feedback-digest-correction-merge.js');

test('a URL correction sent minutes later merges into ONE submission carrying the corrected URL', () => {
  const original = {
    _id: 'sub-1',
    _date: '2026-08-14T15:00:00.000Z',
    review_url: 'https://www.wrongsite.com/review-of-hamilton',
    show_name: 'Hamilton',
    submitter_email: 'jane@example.com',
  };
  const correction = {
    _id: 'sub-2',
    _date: '2026-08-14T15:03:00.000Z',
    review_url: 'https://www.nytimes.com/2026/08/10/theater/hamilton-review.html',
    show_name: 'Hamilton',
    submitter_email: 'jane@example.com',
  };

  const merged = mergeReviewSubmissionCorrections([original, correction]);

  assert.equal(merged.length, 1, 'the two submissions collapse into a single submission');
  assert.equal(merged[0].review_url, correction.review_url, 'the corrected URL wins, not the stale original');
  assert.match(merged[0]._correctionHistory, /wrongsite\.com/);
  assert.match(merged[0]._correctionHistory, /nytimes\.com/);
  assert.deepEqual(merged[0]._mergedSubmissionIds, ['sub-1', 'sub-2']);
  assert.equal(merged[0]._isMergedCorrection, true);
});

test('a show-name correction sent minutes later merges and keeps the corrected show name', () => {
  const original = {
    _id: 'sub-1',
    _date: '2026-08-14T15:00:00.000Z',
    review_url: 'https://www.nytimes.com/review',
    show_name: 'The Wiz',
    submitter_email: 'jane@example.com',
  };
  const correction = {
    _id: 'sub-2',
    _date: '2026-08-14T15:04:00.000Z',
    review_url: 'https://www.nytimes.com/review',
    show_name: 'The Wiz (2024 Revival)',
    submitter_email: 'jane@example.com',
  };

  const merged = mergeReviewSubmissionCorrections([original, correction]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].show_name, correction.show_name);
});

test('unrelated submissions for different shows are not merged', () => {
  const a = { _id: 'a', _date: '2026-08-14T15:00:00.000Z', review_url: 'https://a.com/1', show_name: 'Hamilton', submitter_email: 'jane@example.com' };
  const b = { _id: 'b', _date: '2026-08-14T15:01:00.000Z', review_url: 'https://b.com/1', show_name: 'Wicked', submitter_email: 'jane@example.com' };

  const merged = mergeReviewSubmissionCorrections([a, b]);

  assert.equal(merged.length, 2);
  assert.deepEqual(merged, [a, b]);
});

test('submissions for the same show more than 5 minutes apart are not merged', () => {
  const a = { _id: 'a', _date: '2026-08-14T15:00:00.000Z', review_url: 'https://a.com/1', show_name: 'Hamilton', submitter_email: 'jane@example.com' };
  const b = { _id: 'b', _date: '2026-08-14T15:09:00.000Z', review_url: 'https://a.com/2', show_name: 'Hamilton', submitter_email: 'jane@example.com' };

  const merged = mergeReviewSubmissionCorrections([a, b]);

  assert.equal(merged.length, 2);
});

test('two DIFFERENT submitters reporting the same show in the same window do NOT merge', () => {
  const a = { _id: 'a', _date: '2026-08-14T15:00:00.000Z', review_url: 'https://a.com/1', show_name: 'Hamilton', submitter_email: 'alice@example.com' };
  const b = { _id: 'b', _date: '2026-08-14T15:02:00.000Z', review_url: 'https://a.com/2', show_name: 'Hamilton', submitter_email: 'bob@example.com' };

  const merged = mergeReviewSubmissionCorrections([a, b]);

  assert.equal(merged.length, 2, 'different submitters must never be collapsed into one submission');
  assert.deepEqual(merged, [a, b]);
});

test('submissions without a submitter email never merge (anonymous submitter is common — the field is optional)', () => {
  const a = { _id: 'a', _date: '2026-08-14T15:00:00.000Z', review_url: 'https://a.com/1', show_name: 'Hamilton' };
  const b = { _id: 'b', _date: '2026-08-14T15:02:00.000Z', review_url: 'https://a.com/2', show_name: 'Hamilton' };

  const merged = mergeReviewSubmissionCorrections([a, b]);

  assert.deepEqual(merged, [a, b]);
});

test('three corrections in sequence within window all merge into one thread, latest URL wins', () => {
  const a = { _id: 'a', _date: '2026-08-14T15:00:00.000Z', review_url: 'https://a.com/1', show_name: 'Hamilton', submitter_email: 'jane@example.com' };
  const b = { _id: 'b', _date: '2026-08-14T15:02:00.000Z', review_url: 'https://a.com/2', show_name: 'Hamilton', submitter_email: 'jane@example.com' };
  const c = { _id: 'c', _date: '2026-08-14T15:04:00.000Z', review_url: 'https://a.com/3', show_name: 'Hamilton', submitter_email: 'jane@example.com' };

  const merged = mergeReviewSubmissionCorrections([a, b, c]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].review_url, 'https://a.com/3');
  assert.deepEqual(merged[0]._mergedSubmissionIds, ['a', 'b', 'c']);
});

test('merge preserves timestamp order even when array order is reversed (newest-first API)', () => {
  const original = { _id: 'sub-1', _date: '2026-08-14T15:00:00.000Z', review_url: 'https://wrong.com', show_name: 'Hamilton', submitter_email: 'jane@example.com' };
  const correction = { _id: 'sub-2', _date: '2026-08-14T15:03:00.000Z', review_url: 'https://right.com', show_name: 'Hamilton', submitter_email: 'jane@example.com' };

  const merged = mergeReviewSubmissionCorrections([correction, original]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].review_url, 'https://right.com', 'the chronologically-latest part still wins regardless of array order');
});

test('a URL-only correction that leaves optional fields blank does not blank out the original notes/critic/outlet', () => {
  const original = {
    _id: 'sub-1',
    _date: '2026-08-14T15:00:00.000Z',
    review_url: 'https://www.wrongsite.com/review',
    show_name: 'Hamilton',
    outlet_name: 'The New York Times',
    critic_name: 'Jesse Green',
    notes: 'Found this via a Google search',
    submitter_email: 'jane@example.com',
  };
  // The submit-review form resets between submissions (SubmitReviewForm.tsx
  // form.reset()), so a real-world "just fixing the URL" correction leaves
  // outlet_name/critic_name/notes blank rather than re-typing them.
  const correction = {
    _id: 'sub-2',
    _date: '2026-08-14T15:03:00.000Z',
    review_url: 'https://www.nytimes.com/2026/08/10/theater/hamilton-review.html',
    show_name: 'Hamilton',
    submitter_email: 'jane@example.com',
  };

  const merged = mergeReviewSubmissionCorrections([original, correction]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].review_url, correction.review_url, 'URL takes the corrected value');
  assert.equal(merged[0].outlet_name, original.outlet_name, 'outlet_name is NOT blanked by the correction leaving it empty');
  assert.equal(merged[0].critic_name, original.critic_name, 'critic_name is NOT blanked by the correction leaving it empty');
  assert.equal(merged[0].notes, original.notes, 'notes is NOT blanked by the correction leaving it empty');
});

test('fewer than 2 submissions is a no-op', () => {
  const a = { _id: 'a', _date: '2026-08-14T15:00:00.000Z', review_url: 'https://a.com/1', show_name: 'Hamilton', submitter_email: 'jane@example.com' };
  assert.deepEqual(mergeReviewSubmissionCorrections([a]), [a]);
  assert.deepEqual(mergeReviewSubmissionCorrections([]), []);
});
