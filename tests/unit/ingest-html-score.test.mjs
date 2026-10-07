import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { recoverScoreFromHtml, existingHasScoreSignal } = require('../../scripts/lib/ingest-html-score.js');

const OMC_HTML = '<article><p>Review body.</p><img data-src="https://1minutecritic.com/wp-content/uploads/2026/04/4-stars.png" alt="4 star review" class="lazyload"></article>';

test('1minutecritic image alt "4 star review" is recovered as 4/5 (BRO-4764, Slam Frank)', () => {
  const r = recoverScoreFromHtml(OMC_HTML, 'Review body.', 'one-minute-critic', 'Slam Frank');
  assert.equal(r.originalScore, '4/5');
  assert.equal(r.normalizedScore, 80);
  assert.equal(r.source, 'omc-alt-text');
});

test('every 1minutecritic outlet id alias is covered', () => {
  for (const id of ['one-minute-critic', '1-minute-critic', 'oneminutecritic', '1minutecritic']) {
    assert.equal(recoverScoreFromHtml(OMC_HTML, '', id, 'Slam Frank')?.originalScore, '4/5', id);
  }
});

test('outlet with no registered extractor never gets a score from stray page text', () => {
  const html = '<div>Related: Hamlet 3/5 stars</div><img alt="5 star review">';
  assert.equal(recoverScoreFromHtml(html, '', 'some-unregistered-blog', 'Slam Frank'), null);
});

test('no rating in the page returns null, not a guess', () => {
  assert.equal(recoverScoreFromHtml('<p>no stars here</p>', 'no stars here', 'one-minute-critic', 'Slam Frank'), null);
});

test('missing html or outlet is a safe null', () => {
  assert.equal(recoverScoreFromHtml('', 'x', 'one-minute-critic', 'Slam Frank'), null);
  assert.equal(recoverScoreFromHtml(OMC_HTML, 'x', '', 'Slam Frank'), null);
});

test('existing file with an originalScore, aggregator stars, or a cleared score blocks the merge', () => {
  assert.equal(existingHasScoreSignal({ originalScore: 100 }), true);
  assert.equal(existingHasScoreSignal({ originalScore: '3/5 stars' }), true);
  assert.equal(existingHasScoreSignal({ aggregatorStars: '4/5' }), true);
  assert.equal(existingHasScoreSignal({ originalScoreCleared: true }), true);
});

test('blank or missing existing file does not block the merge', () => {
  assert.equal(existingHasScoreSignal(null), false);
  assert.equal(existingHasScoreSignal(undefined), false);
  assert.equal(existingHasScoreSignal({}), false);
  assert.equal(existingHasScoreSignal({ originalScore: null, aggregatorStars: '' }), false);
});
