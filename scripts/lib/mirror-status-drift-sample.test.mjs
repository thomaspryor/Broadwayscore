import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evenlySpacedSample, extractCandidates } = require('./mirror-status-drift-sample.js');

test('evenlySpacedSample: pool smaller than sampleSize returns every candidate', () => {
  const pool = [1, 2, 3];
  assert.deepEqual(evenlySpacedSample(pool, 10), pool);
});

test('evenlySpacedSample: never returns more than sampleSize, even with duplicate strides', () => {
  const pool = Array.from({ length: 26 }, (_, i) => i);
  const picked = evenlySpacedSample(pool, 26);
  assert.ok(picked.length <= 26);
});

test('evenlySpacedSample: spans the full range, not just a prefix (regression: a .slice(0,n) sample would only ever see the earliest ids)', () => {
  const pool = Array.from({ length: 118 }, (_, i) => i); // mirrors the real 118 pending-P1 pool size
  const picked = evenlySpacedSample(pool, 26);
  assert.equal(picked.length, 26);
  assert.ok(picked[0] < 10, 'sample should include an early candidate');
  assert.ok(picked[picked.length - 1] > 100, 'sample should include a late candidate, not stop at a prefix');
});

test('evenlySpacedSample: sampleSize <= 0 or non-finite returns nothing and never throws', () => {
  assert.deepEqual(evenlySpacedSample([1, 2, 3], 0), []);
  assert.deepEqual(evenlySpacedSample([1, 2, 3], -5), []);
  assert.deepEqual(evenlySpacedSample([1, 2, 3], NaN), []);
  assert.deepEqual(evenlySpacedSample(null, 5), []);
});

test('extractCandidates: filters to matching status + priority label and pulls the notion page id', () => {
  const entries = [
    { id: '1', status: 'pending', description: '[notion:abc-1] P1 Next · Not started · eng' },
    { id: '2', status: 'pending', description: '[notion:abc-2] P0 Now · Not started · eng' },
    { id: '3', status: 'in_progress', description: '[notion:abc-3] P1 Next · In progress · eng' },
    { id: '4', status: 'pending', description: 'no notion marker here' },
  ];
  const picked = extractCandidates(entries, { status: 'pending', priorityLabel: 'P1 Next' });
  assert.deepEqual(picked, [{ id: '1', pageId: 'abc-1' }]);
});

test('extractCandidates: no priorityLabel matches any priority at the given status', () => {
  const entries = [
    { id: '1', status: 'pending', description: '[notion:abc-1] P1 Next · Not started · eng' },
    { id: '2', status: 'pending', description: '[notion:abc-2] P0 Now · Not started · eng' },
  ];
  const picked = extractCandidates(entries, { status: 'pending' });
  assert.deepEqual(picked, [{ id: '1', pageId: 'abc-1' }, { id: '2', pageId: 'abc-2' }]);
});

test('extractCandidates: skips null/undefined entries and entries with no notion mapping, never throws', () => {
  const entries = [null, undefined, { id: '1', status: 'pending', description: 'no marker' }];
  assert.deepEqual(extractCandidates(entries, { status: 'pending' }), []);
  assert.deepEqual(extractCandidates(null, { status: 'pending' }), []);
});
