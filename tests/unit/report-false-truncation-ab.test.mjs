import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compare, summarize } = require('../../scripts/report-false-truncation-ab.js');

const mk = (score, bucket, conf, status, extra = {}) => ({
  assignedScore: score,
  llmScore: { bucket, confidence: conf },
  llmMetadata: { textSource: { status }, scoredAt: extra.scoredAt || 't0' },
  needsRescore: extra.needsRescore === true,
});

test('stable rescore passes and counts the confidence gain (BRO-4804)', () => {
  const before = ['a', 'b', 'c', 'd'].map(f => summarize(f, mk(70, 'Positive', 'low', 'truncated')));
  const cur = new Map(before.map(b => [b.file, mk(71, 'Positive', 'high', 'complete', { scoredAt: 't1' })]));
  const r = compare(before, cur);
  assert.equal(r.rescored, 4);
  assert.equal(r.pass, true);
  assert.equal(r.truncatedBefore, 4);
  assert.equal(r.truncatedAfter, 0);
});

test('a bucket share move of 5+ points fails', () => {
  const before = Array.from({ length: 20 }, (_, i) => summarize(`f${i}`, mk(60, 'Mixed', 1, 'truncated')));
  const cur = new Map(before.map((b, i) => [b.file, i === 0 ? mk(80, 'Positive', 1, 'complete', { scoredAt: 't1' }) : mk(60, 'Mixed', 1, 'complete', { scoredAt: 't1' })]));
  const r = compare(before, cur);
  assert.equal(r.pass, false);
  assert.equal(r.changedBucket, 1);
});

test('mean drift of 5+ points fails even with no bucket change', () => {
  const before = ['a', 'b'].map(f => summarize(f, mk(60, 'Mixed', 1, 'truncated')));
  const cur = new Map(before.map(b => [b.file, mk(66, 'Mixed', 1, 'complete', { scoredAt: 't1' })]));
  assert.equal(compare(before, cur).pass, false);
});

test('stable scores but status still truncated is a FAIL (the fix did not take effect)', () => {
  const before = ['a', 'b', 'c', 'd'].map(f => summarize(f, mk(70, 'Positive', 'low', 'truncated')));
  const cur = new Map(before.map(b => [b.file, mk(70, 'Positive', 'low', 'truncated', { scoredAt: 't1' })]));
  const r = compare(before, cur);
  assert.equal(r.rescored, 4);
  assert.equal(r.fixTookEffect, false);
  assert.equal(r.pass, false);
});

test('string confidence is averaged (high=3, medium=2, low=1)', () => {
  const before = ['a', 'b'].map(f => summarize(f, mk(70, 'Positive', 'low', 'truncated')));
  const cur = new Map(before.map(b => [b.file, mk(70, 'Positive', 'high', 'complete', { scoredAt: 't1' })]));
  const r = compare(before, cur);
  assert.equal(r.confBefore, 1);
  assert.equal(r.confAfter, 3);
});

test('files still flagged or not re-scored are pending, and nothing rescored means not measured', () => {
  const before = [summarize('a', mk(60, 'Mixed', 1, 'truncated'))];
  const r = compare(before, new Map([['a', mk(60, 'Mixed', 1, 'truncated', { needsRescore: true })]]));
  assert.equal(r.rescored, 0);
  assert.equal(r.pending, 1);
  assert.equal(r.pass, false);
});
