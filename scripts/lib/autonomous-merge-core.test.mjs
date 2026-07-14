import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  oscillationTrailerFor, shouldEscalateOscillation, buildEscalationNote,
  buildMergeOutcomeNote, buildReverifyFailNote, buildRevertOutcomeNote,
} = require('./autonomous-merge-core.js');

test('oscillationTrailerFor embeds the card id verbatim (grep target for git log)', () => {
  assert.equal(oscillationTrailerFor('abc-123'), 'Auto-merge-card: abc-123');
});

test('shouldEscalateOscillation: 0 and 1 prior merges are fine, 2+ escalates', () => {
  assert.equal(shouldEscalateOscillation(0), false);
  assert.equal(shouldEscalateOscillation(1), false);
  assert.equal(shouldEscalateOscillation(2), true);
  assert.equal(shouldEscalateOscillation(5), true);
  assert.equal(shouldEscalateOscillation(undefined), false);
  assert.equal(shouldEscalateOscillation(NaN), false);
});

test('buildEscalationNote mentions the count and the trailer being searched for', () => {
  const note = buildEscalationNote('abc-123', 2);
  assert.match(note, /already been merged 2 time/);
  assert.match(note, /Auto-merge-card: abc-123/);
  assert.match(note, /REFUSED/);
});

test('buildMergeOutcomeNote lists files and the sha/branch', () => {
  const note = buildMergeOutcomeNote({ sha: 'deadbeef', branch: 'auto/x', files: ['tests/unit/a.test.mjs', 'docs/b.md'] });
  assert.match(note, /deadbeef/);
  assert.match(note, /auto\/x/);
  assert.match(note, /- tests\/unit\/a\.test\.mjs/);
  assert.match(note, /- docs\/b\.md/);
  assert.match(note, /revert link/i);
});

test('buildReverifyFailNote strips the approval and states no merge happened', () => {
  const note = buildReverifyFailNote('rebase conflict in tests/unit/a.test.mjs');
  assert.match(note, /rebase conflict/);
  assert.match(note, /NOT be merged|not merged/i);
  assert.match(note, /fresh tap/);
});

test('buildRevertOutcomeNote references both shas and reopens the card', () => {
  const note = buildRevertOutcomeNote({ revertSha: 'cafe1', mergeSha: 'deadbeef' });
  assert.match(note, /cafe1/);
  assert.match(note, /deadbeef/);
  assert.match(note, /reopened/i);
});
