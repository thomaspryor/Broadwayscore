import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  hasUsefulWrongShowData,
  hasMeaningfulText,
  shouldDeleteWrongShowBlocker,
  shouldRefuseSurge,
} = require('./wrong-show-blocker-cleanup.js');

test('shouldDeleteWrongShowBlocker: false when wrongShow is not set', () => {
  assert.equal(shouldDeleteWrongShowBlocker({}, false), false);
  assert.equal(shouldDeleteWrongShowBlocker({ wrongShow: false }, false), false);
});

test('shouldDeleteWrongShowBlocker: conservative mode deletes pure junk', () => {
  const junk = { wrongShow: true };
  assert.equal(shouldDeleteWrongShowBlocker(junk, false), true);
});

test('shouldDeleteWrongShowBlocker: conservative mode keeps files with a score', () => {
  const scored = { wrongShow: true, assignedScore: 7 };
  assert.equal(hasUsefulWrongShowData(scored), true);
  assert.equal(shouldDeleteWrongShowBlocker(scored, false), false);
});

test('shouldDeleteWrongShowBlocker: conservative mode keeps files with an llmScore', () => {
  const scored = { wrongShow: true, llmScore: { band: 'positive' } };
  assert.equal(shouldDeleteWrongShowBlocker(scored, false), false);
});

test('shouldDeleteWrongShowBlocker: conservative mode keeps files with aggregator data', () => {
  const withAgg = { wrongShow: true, bwwScore: 8 };
  assert.equal(shouldDeleteWrongShowBlocker(withAgg, false), false);
});

test('shouldDeleteWrongShowBlocker: conservative mode keeps files with meaningful text', () => {
  const withText = { wrongShow: true, fullText: 'x'.repeat(101) };
  assert.equal(hasMeaningfulText(withText), true);
  assert.equal(shouldDeleteWrongShowBlocker(withText, false), false);
});

test('shouldDeleteWrongShowBlocker: short text alone does not save a file', () => {
  const shortText = { wrongShow: true, fullText: 'too short' };
  assert.equal(shouldDeleteWrongShowBlocker(shortText, false), true);
});

test('shouldDeleteWrongShowBlocker: --include-scored deletes even scored files', () => {
  const scored = { wrongShow: true, assignedScore: 7, fullText: 'x'.repeat(200) };
  assert.equal(shouldDeleteWrongShowBlocker(scored, true), true);
});

test('shouldRefuseSurge: allows under threshold', () => {
  assert.equal(shouldRefuseSurge(50, 100, false), false);
});

test('shouldRefuseSurge: refuses over threshold without force-bulk', () => {
  assert.equal(shouldRefuseSurge(566, 100, false), true);
});

test('shouldRefuseSurge: --force-bulk overrides the guard', () => {
  assert.equal(shouldRefuseSurge(566, 100, true), false);
});

test('shouldRefuseSurge: exactly at threshold does not refuse', () => {
  assert.equal(shouldRefuseSurge(100, 100, false), false);
});
