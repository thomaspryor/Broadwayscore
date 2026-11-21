import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { getBestScore, isPlaceholderAssignedScore } = require('./rebuild-helpers.js');

// BRO-4612: shapes copied from the two BRO-4596 rows that published a bare 50.
const drood = () => ({
  outletId: 'ap', assignedScore: 50, ensembleData: null, scoreSource: null, originalScore: null,
  llmScore: { score: 76, confidence: 'medium' }, fullText: null,
});
const illinoise = () => ({
  outletId: 'talkinbroadway', assignedScore: 50, bucket: 'Mixed', ensembleData: null, scoreSource: null,
  originalScore: null, llmScore: { score: 78, confidence: 'low' }, fullText: 'short 404 page text',
});

describe('isPlaceholderAssignedScore', () => {
  test('flags a bare 50 with no provenance', () => {
    assert.equal(isPlaceholderAssignedScore(drood()), true);
    assert.equal(isPlaceholderAssignedScore(illinoise()), true);
  });
  test('keeps a 50 that has ensemble data, a source, an original score, or a model 50', () => {
    assert.equal(isPlaceholderAssignedScore({ ...drood(), ensembleData: { votes: 3 } }), false);
    assert.equal(isPlaceholderAssignedScore({ ...drood(), scoreSource: 'originalScore' }), false);
    assert.equal(isPlaceholderAssignedScore({ ...drood(), originalScore: '2.5/5' }), false);
    assert.equal(isPlaceholderAssignedScore({ ...drood(), llmScore: { score: 50 } }), false);
  });
  test('ignores every other assignedScore value', () => {
    assert.equal(isPlaceholderAssignedScore({ ...drood(), assignedScore: 72 }), false);
    assert.equal(isPlaceholderAssignedScore(null), false);
  });
});

describe('getBestScore with a placeholder 50', () => {
  test('no longer publishes the placeholder', () => {
    for (const d of [drood(), illinoise()]) {
      const r = getBestScore(d, { stats: {} });
      assert.notEqual(r && r.score, 50, JSON.stringify(r));
      assert.notEqual(r && r.source, 'assignedScore');
    }
  });
  test('a real assignedScore 50 backed by ensemble data still publishes', () => {
    const d = { ...drood(), ensembleData: { votes: 3 }, llmScore: { score: 50, confidence: 'high' }, fullText: 'x'.repeat(400) };
    const r = getBestScore(d, { stats: {} });
    assert.equal(r.score, 50);
  });
});
