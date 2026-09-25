/**
 * Rebuild showNotMentioned safety net (adversarial review 2026-09-24, P1-d):
 * must use the collection validators (multi-mention), not a single title
 * substring anywhere in 60K chars, and must record reversible provenance.
 *
 * Run: node --test scripts/lib/show-not-mentioned-autoclear.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideShowNotMentionedAutoClear, applyShowNotMentionedClear, CLEARED_BY } = require('./show-not-mentioned-autoclear.js');

const FILLER = 'The staging is brisk and the performers commit fully to every scene, with the band sounding bright and the choreography landing its jokes on the beat. ';
const long = (s) => (s + FILLER.repeat(14));
const ctx = { showTitle: 'Dog Man - The Musical', showId: 'dog-man-the-musical-2026' };

test('clears when the review names the show repeatedly (punctuation variant: "Dog Man: The Musical")', () => {
  const text = long('Dog Man: The Musical is a delight. ') + ' By the end, Dog Man had won over the kids. Dog Man: The Musical runs through May.';
  assert.ok(text.length >= 1500);
  const d = decideShowNotMentionedAutoClear({ showNotMentioned: true, fullText: text }, ctx);
  assert.equal(d.clear, true, d.reason);
  assert.ok(d.mentionCount >= 3);
});

test('does NOT clear on a single passing mention in a long unrelated text (the P1-d bug)', () => {
  const text = long('A new staging of an old farce opened last night. ') + ' Elsewhere this week: Dog Man: The Musical.';
  const d = decideShowNotMentionedAutoClear({ showNotMentioned: true, fullText: text }, ctx);
  assert.equal(d.clear, false);
  assert.match(d.reason, /mention-count/);
});

test('long title named once in the headline/lede still clears (long-title discount, lede-anchored)', () => {
  const text = long('Review: Dog Man: The Musical at the Lyric. ');
  const d = decideShowNotMentionedAutoClear({ showNotMentioned: true, fullText: text }, ctx);
  assert.equal(d.clear, true, d.reason);
});

test('not flagged / no text / no title → no clear', () => {
  assert.equal(decideShowNotMentionedAutoClear({ fullText: long('Dog Man') }, ctx).clear, false);
  assert.equal(decideShowNotMentionedAutoClear({ showNotMentioned: true, fullText: 'short' }, ctx).clear, false);
  assert.equal(decideShowNotMentionedAutoClear({ showNotMentioned: true, fullText: long('x') }, {}).clear, false);
});

test('checks wrongFullText when fullText was nulled; apply restores it and records reversible provenance', () => {
  const text = long('Dog Man: The Musical is a delight. Dog Man soars. ') + ' Dog Man: The Musical runs through May.';
  const src = { showNotMentioned: true, _showNotMentionedDiscoveryAttempted: '2026-09-01', fullText: null, wrongFullText: text, url: 'https://x/y' };
  const d = decideShowNotMentionedAutoClear(src, ctx);
  assert.equal(d.clear, true, d.reason);
  assert.equal(d.field, 'wrongFullText');
  const out = applyShowNotMentionedClear(src, d, '2026-09-24T00:00:00.000Z');
  assert.equal(out.showNotMentioned, false);
  assert.equal(out.fullText, text);
  assert.equal(out.wrongFullText, undefined);
  assert.equal(out._showNotMentionedDiscoveryAttempted, undefined);
  assert.equal(out.showNotMentionedClearedAt, '2026-09-24T00:00:00.000Z');
  assert.equal(out.showNotMentionedClearedBy, CLEARED_BY);
  assert.deepEqual(out.showNotMentionedClearedPrior, { showNotMentioned: true, _showNotMentionedDiscoveryAttempted: '2026-09-01', restoredFullTextFromWrongFullText: true });
  assert.ok(out.showNotMentionedClearedEvidence.mentionCount >= 3);
  assert.equal(src.showNotMentioned, true, 'input not mutated');
});
