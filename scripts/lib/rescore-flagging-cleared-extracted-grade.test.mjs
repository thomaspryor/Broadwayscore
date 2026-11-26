import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { queueRescoreForClearedRating } = require('./rescore-flagging.js');

const base = () => ({ fullText: 'A long enough review body. '.repeat(30), scoreSource: 'extracted-grade', assignedScore: 93, originalScore: null });

test('BRO-8350: clearing a rating the score was copied from queues a rescore', () => {
  const d = base();
  assert.equal(queueRescoreForClearedRating(d, 'prose artefact'), true);
  assert.equal(d.needsRescore, true);
});

test('a score from a source that never used the rating is left alone', () => {
  const d = { ...base(), scoreSource: 'manual-verified' };
  assert.equal(queueRescoreForClearedRating(d, 'x'), false);
});
