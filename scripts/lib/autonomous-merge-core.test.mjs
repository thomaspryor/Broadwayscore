import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  BASE_TRAILER_PREFIX, oscillationTrailerFor, stripTrailers, parseBaseTrailer, shouldEscalateOscillation,
  buildEscalationNote, buildMergeOutcomeNote, buildReverifyFailNote, buildRevertOutcomeNote,
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

// ── Trailer round-trip (Sprint-3 ship-check fix: multi-commit revert) ──────

test('stripTrailers removes the card trailer and base trailer, leaves the rest', () => {
  const trailer = oscillationTrailerFor('abc-123');
  const msg = `auto: fix the thing\n\n${trailer}\n${BASE_TRAILER_PREFIX}deadbeef`;
  assert.equal(stripTrailers(msg, trailer), 'auto: fix the thing');
});

test('stripTrailers is idempotent — re-stripping an already-clean message is a no-op', () => {
  const trailer = oscillationTrailerFor('abc-123');
  const clean = 'auto: fix the thing';
  assert.equal(stripTrailers(clean, trailer), clean);
  assert.equal(stripTrailers(stripTrailers(clean, trailer), trailer), clean);
});

test('stripTrailers handles a message that was stamped twice (defense in depth)', () => {
  const trailer = oscillationTrailerFor('abc-123');
  const doubled = `auto: fix the thing\n\n${trailer}\n${BASE_TRAILER_PREFIX}oldsha\n\n${trailer}\n${BASE_TRAILER_PREFIX}newsha`;
  assert.equal(stripTrailers(doubled, trailer), 'auto: fix the thing');
});

test('parseBaseTrailer extracts the sha, or null when absent', () => {
  const trailer = oscillationTrailerFor('abc-123');
  const msg = `auto: fix the thing\n\n${trailer}\n${BASE_TRAILER_PREFIX}deadbeef1234`;
  assert.equal(parseBaseTrailer(msg), 'deadbeef1234');
  assert.equal(parseBaseTrailer('auto: fix the thing (no trailers)'), null);
  assert.equal(parseBaseTrailer(''), null);
  assert.equal(parseBaseTrailer(null), null);
});

test('parseBaseTrailer takes the FIRST match — callers must strip before re-stamping to avoid stale reads', () => {
  const doubled = `msg\n${BASE_TRAILER_PREFIX}old\n${BASE_TRAILER_PREFIX}new`;
  assert.equal(parseBaseTrailer(doubled), 'old');
});
