/**
 * BRO-4447: a rebuild from a stale checkout renamed nytg--unknown.json to
 * nytg--amelia-merrill.json before the text fetch landed. The next rebuild's
 * stale --unknown cleanup merged the fetched copy into the textless named
 * file and deleted it, so the review lost its text and never scored.
 * Shapes from the-pass-off-broadway-2026 (review-texts 5a52788 / e6dea1f).
 *
 * Run: node --test scripts/lib/rename-race-keeps-newer-text.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeUniqueReviewFields, adoptNewerFetchedText } = require('./merge-review-fields.js');

const URL = 'https://nytg.org/2026/09/the-pass-review/';
const BODY = 'The Pass is a taut, funny two-hander. '.repeat(145); // ~5,500 chars

const staleNamed = () => ({
  showId: 'the-pass-off-broadway-2026',
  outletId: 'nytg', outlet: 'New York Theatre Guide', criticName: 'Amelia Merrill',
  url: URL,
  fullText: 'The Pass, a two-hander, opens at ... Read more',
  contentTier: 'stub', tierReason: 'Short text (160 words)',
  rescoreBlockedReason: 'text too short to score', rescoreBlockedAt: '2026-09-30T19:40:00Z',
});
const fetchedUnknown = () => ({
  showId: 'the-pass-off-broadway-2026',
  outletId: 'nytg', outlet: 'New York Theatre Guide', criticName: 'Amelia Merrill',
  url: URL + '?utm_source=x',
  fullText: BODY, textWordCount: 1050, contentTier: 'complete', contentTierReason: 'full review',
  textFetchedAt: '2026-09-30T19:48:00Z', fetchMethod: 'brightdata',
});

test('merge keeps the fetched text when the named copy came from a stale checkout', () => {
  const target = staleNamed();
  const r = mergeUniqueReviewFields(target, fetchedUnknown());
  assert.equal(r.action, 'merged');
  assert.equal(r.changed, true);
  assert.equal(target.fullText, BODY);
  assert.equal(target.contentTier, 'complete');
  assert.equal(target.textFetchedAt, '2026-09-30T19:48:00Z');
  assert.equal(target.tierReason, undefined, 'stale tier reason of the old body is gone');
  assert.equal(target.rescoreBlockedReason, undefined);
  assert.equal(target.needsRescore, true);
  assert.equal(target.criticName, 'Amelia Merrill');
});

test('a target with comparable or longer text keeps its own', () => {
  const target = { ...staleNamed(), fullText: BODY + ' extra', contentTier: 'complete' };
  delete target.tierReason;
  assert.equal(adoptNewerFetchedText(target, fetchedUnknown()), false);
  assert.equal(target.fullText, BODY + ' extra');
});

test('a different review url never donates its text', () => {
  const target = staleNamed();
  const src = { ...fetchedUnknown(), url: 'https://nytg.org/2026/09/other-show-review/' };
  assert.equal(adoptNewerFetchedText(target, src), false);
  assert.equal(target.contentTier, 'stub');
});

test('a person-pinned target keeps its text', () => {
  for (const pin of [{ _locked: true }, { manualContentTier: 'excerpt' }]) {
    const target = { ...staleNamed(), ...pin };
    assert.equal(adoptNewerFetchedText(target, fetchedUnknown()), false);
    assert.equal(target.contentTier, 'stub');
  }
});

test('a short source body is not "substantive" and is not adopted', () => {
  const target = { ...staleNamed(), fullText: '' };
  assert.equal(adoptNewerFetchedText(target, { ...fetchedUnknown(), fullText: 'Too short.' }), false);
});

test('a longer body that is junk, older, or of unproven url is never adopted', () => {
  const cases = [
    { contentTier: 'invalid' },
    { contentVerification: { wrongArticle: true, confidence: 'low' } },
    { isRoundupArticle: true },
  ];
  for (const bad of cases) {
    const target = staleNamed();
    assert.equal(adoptNewerFetchedText(target, { ...fetchedUnknown(), ...bad }), false, JSON.stringify(bad));
    assert.equal(target.contentTier, 'stub');
  }
  const trimmed = { ...staleNamed(), textFetchedAt: '2026-10-01T00:00:00Z' };
  assert.equal(adoptNewerFetchedText(trimmed, fetchedUnknown()), false, 'an older fetch never undoes a newer one');
  const noUrl = { ...staleNamed(), url: '' };
  assert.equal(adoptNewerFetchedText(noUrl, fetchedUnknown()), false, 'an empty url proves nothing');
});

test('the old body\'s CV verdict does not survive the body swap', () => {
  const target = { ...staleNamed(), contentVerification: { valid: true, verdict: 'about the old stub' } };
  assert.equal(adoptNewerFetchedText(target, fetchedUnknown()), true);
  assert.equal(target.contentVerification, undefined);
});
