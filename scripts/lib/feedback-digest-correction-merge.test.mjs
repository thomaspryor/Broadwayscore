import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { mergeCorrectionSubmissions } = require('./feedback-digest-correction-merge.js');

test('two submissions for the same show within 5 minutes merge into one, both messages present', () => {
  const original = {
    _id: 'sub-1',
    _date: '2026-08-10T19:41:00.000Z',
    name: 'Jane Doe',
    email: 'jane@example.com',
    show: '3 Summers of Lincoln',
    message: "Please add David Coddon's Vanguard Culture review of 3 Summers of Lincoln.",
  };
  const correction = {
    _id: 'sub-2',
    _date: '2026-08-10T19:44:00.000Z',
    name: 'Jane Doe',
    email: 'jane@example.com',
    show: '3 Summers of Lincoln',
    message: "Correction: that review is actually Coddon's 'Stage West' column, not Vanguard Culture.",
  };

  const merged = mergeCorrectionSubmissions([original, correction]);

  assert.equal(merged.length, 1, 'the two submissions collapse into a single merged submission');
  assert.match(merged[0].message, /Vanguard Culture/);
  assert.match(merged[0].message, /Stage West/);
  assert.deepEqual(merged[0]._mergedSubmissionIds, ['sub-1', 'sub-2']);
});

test('unrelated submissions for different shows are not merged', () => {
  const a = { _id: 'a', _date: '2026-08-10T19:41:00.000Z', show: 'Hamilton', message: 'msg a' };
  const b = { _id: 'b', _date: '2026-08-10T19:42:00.000Z', show: 'Wicked', message: 'msg b' };

  const merged = mergeCorrectionSubmissions([a, b]);

  assert.equal(merged.length, 2);
  assert.deepEqual(merged, [a, b]);
});

test('submissions for the same show more than 5 minutes apart are not merged', () => {
  const a = { _id: 'a', _date: '2026-08-10T19:41:00.000Z', show: 'Hamilton', message: 'msg a' };
  const b = { _id: 'b', _date: '2026-08-10T19:50:00.000Z', show: 'Hamilton', message: 'msg b' };

  const merged = mergeCorrectionSubmissions([a, b]);

  assert.equal(merged.length, 2);
});

test('three corrections in sequence within window all merge into one thread', () => {
  const a = { _id: 'a', _date: '2026-08-10T19:41:00.000Z', show: 'Hamilton', email: 'jane@example.com', message: 'first' };
  const b = { _id: 'b', _date: '2026-08-10T19:44:00.000Z', show: 'Hamilton', email: 'jane@example.com', message: 'second' };
  const c = { _id: 'c', _date: '2026-08-10T19:47:00.000Z', show: 'Hamilton', email: 'jane@example.com', message: 'third' };

  const merged = mergeCorrectionSubmissions([a, b, c]);

  assert.equal(merged.length, 1);
  assert.match(merged[0].message, /first/);
  assert.match(merged[0].message, /second/);
  assert.match(merged[0].message, /third/);
  assert.deepEqual(merged[0]._mergedSubmissionIds, ['a', 'b', 'c']);
});

test('submissions missing a show name or date pass through unmerged', () => {
  const a = { _id: 'a', _date: '2026-08-10T19:41:00.000Z', message: 'no show field' };
  const b = { _id: 'b', _date: '2026-08-10T19:42:00.000Z', message: 'also no show field' };

  const merged = mergeCorrectionSubmissions([a, b]);

  assert.deepEqual(merged, [a, b]);
});

test('same-show titles that differ only by case/punctuation still match (normalizeTitle)', () => {
  const a = { _id: 'a', _date: '2026-08-10T19:41:00.000Z', show: '3 Summers of Lincoln', email: 'jane@example.com', message: 'first' };
  const b = { _id: 'b', _date: '2026-08-10T19:43:00.000Z', show: '3 SUMMERS OF LINCOLN!', email: 'jane@example.com', message: 'correction' };

  const merged = mergeCorrectionSubmissions([a, b]);

  assert.equal(merged.length, 1);
});

test('two DIFFERENT submitters reporting the same show in the same window do NOT merge', () => {
  const a = {
    _id: 'a', _date: '2026-08-10T19:41:00.000Z', show: 'Hamilton',
    name: 'Alice', email: 'alice@example.com', message: 'the score seems off',
  };
  const b = {
    _id: 'b', _date: '2026-08-10T19:43:00.000Z', show: 'Hamilton',
    name: 'Bob', email: 'bob@example.com', message: 'missing a review',
  };

  const merged = mergeCorrectionSubmissions([a, b]);

  assert.equal(merged.length, 2, 'different submitters must never be collapsed into one submission');
  assert.deepEqual(merged, [a, b]);
});

test('same submitter identified by name (no email) still merges', () => {
  const a = { _id: 'a', _date: '2026-08-10T19:41:00.000Z', show: 'Hamilton', name: 'Alice', message: 'first' };
  const b = { _id: 'b', _date: '2026-08-10T19:43:00.000Z', show: 'Hamilton', name: 'Alice', message: 'correction' };

  const merged = mergeCorrectionSubmissions([a, b]);

  assert.equal(merged.length, 1);
});

test('fully anonymous submissions (no name or email) never merge, even same show/time', () => {
  const a = { _id: 'a', _date: '2026-08-10T19:41:00.000Z', show: 'Hamilton', message: 'first' };
  const b = { _id: 'b', _date: '2026-08-10T19:43:00.000Z', show: 'Hamilton', message: 'second' };

  const merged = mergeCorrectionSubmissions([a, b]);

  assert.equal(merged.length, 2);
});

test('non-string show (array/object from a malformed POST) does not throw', () => {
  const a = { _id: 'a', _date: '2026-08-10T19:41:00.000Z', show: ['Hamilton', 'x'], email: 'a@example.com', message: 'first' };
  const b = { _id: 'b', _date: '2026-08-10T19:42:00.000Z', show: { title: 'Hamilton' }, email: 'a@example.com', message: 'second' };

  assert.doesNotThrow(() => mergeCorrectionSubmissions([a, b]));
  const merged = mergeCorrectionSubmissions([a, b]);
  assert.equal(merged.length, 2, 'non-string show is unmatchable, so both pass through untouched');
});

test('merge preserves timestamp order even when array order is reversed (newest-first API)', () => {
  const original = {
    _id: 'orig', _date: '2026-08-10T19:41:00.000Z', email: 'jane@example.com',
    show: 'Hamilton', name: 'Jane', message: 'the original report',
  };
  const correction = {
    _id: 'corr', _date: '2026-08-10T19:44:00.000Z', email: 'jane@example.com',
    show: 'Hamilton', name: 'Jane', message: 'the correction',
  };
  // API returns newest-first: correction appears at array index 0.
  const merged = mergeCorrectionSubmissions([correction, original]);

  assert.equal(merged.length, 1);
  assert.match(merged[0].message, /^the original report/, 'earliest-by-timestamp message must lead, regardless of array position');
  assert.match(merged[0].message, /min later[\s\S]*the correction/);
});

test('fewer than 2 submissions is a no-op', () => {
  assert.deepEqual(mergeCorrectionSubmissions([]), []);
  const only = [{ _id: 'a', show: 'Hamilton', message: 'x', _date: '2026-08-10T19:41:00.000Z' }];
  assert.deepEqual(mergeCorrectionSubmissions(only), only);
});
