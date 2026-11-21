'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WATCHED_WORKFLOWS, evaluateMainRed, formatWarnings } = require('./main-red-workflows.js');

const run = (id, conclusion, day) => ({ id, conclusion, created_at: `2026-11-${day}T00:00:00Z`, html_url: `https://x/${id}` });

test('watches the two non-blocking post-land workflows', () => {
  assert.deepEqual(WATCHED_WORKFLOWS.map((w) => w.file).sort(), ['check-performance.yml', 'test-ugc.yml']);
});

test('latest failure is red, with first-red date and streak', () => {
  const r = evaluateMainRed([{ file: 'a.yml', name: 'A', runs: [run(3, 'failure', '14'), run(2, 'failure', '10'), run(1, 'success', '01')] }]);
  assert.equal(r.red.length, 1);
  assert.equal(r.red[0].runId, 3);
  assert.equal(r.red[0].consecutive, 2);
  assert.equal(r.red[0].since.slice(0, 10), '2026-11-10');
  assert.match(formatWarnings(r)[0], /^::warning title=main is red: A::a\.yml has failed 2\+/);
});

test('latest success is green even after older failures', () => {
  assert.equal(evaluateMainRed([{ file: 'a.yml', runs: [run(2, 'success', '14'), run(1, 'failure', '10')] }]).red.length, 0);
});

test('cancelled runs are ignored, not green and not red', () => {
  const r = evaluateMainRed([{ file: 'a.yml', runs: [run(3, 'cancelled', '14'), run(2, 'failure', '10')] }]);
  assert.equal(r.red.length, 1);
  assert.equal(r.red[0].runId, 2);
});

test('no usable runs is unknown, never red', () => {
  const r = evaluateMainRed([{ file: 'a.yml', runs: [] }, { file: 'b.yml', runs: [run(1, 'cancelled', '14')] }]);
  assert.deepEqual(r.unknown, ['a.yml', 'b.yml']);
  assert.equal(r.red.length, 0);
});
