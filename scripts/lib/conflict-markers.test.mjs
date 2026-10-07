import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findConflictMarkers, hasConflictMarkers } = require('./conflict-markers.js');

test('flags a standard 7-char conflict opener and closer', () => {
  const text = '{\n<<<<<<< HEAD\n  "a": 1\n=======\n  "a": 2\n>>>>>>> branch\n}\n';
  assert.equal(hasConflictMarkers(text), true);
  const hits = findConflictMarkers(text);
  // opener (line 2) + closer (line 6) flagged; the bare ======= separator is not.
  assert.deepEqual(hits.map(h => h.line), [2, 6]);
});

test('flags the 8-char nested-conflict marker that broke validate-review-texts (commit 09e78a7a)', () => {
  const text = '{\n<<<<<<<< HEAD:_pending/relics-west-end-2026/times-uk--61f17567.json\n  "showId": "relics-west-end-2026",\n';
  assert.equal(hasConflictMarkers(text), true);
});

test('clean JSON passes', () => {
  assert.equal(hasConflictMarkers('{\n  "showId": "x",\n  "score": 88\n}\n'), false);
});

test('does NOT false-positive on a Markdown setext heading underline (bare === / ---)', () => {
  const md = 'My Title\n=======\n\nSection\n-------\n\nbody text\n';
  assert.equal(hasConflictMarkers(md), false);
});

test('empty / non-string input is clean', () => {
  assert.equal(hasConflictMarkers(''), false);
  assert.equal(hasConflictMarkers(null), false);
  assert.equal(hasConflictMarkers(undefined), false);
});
