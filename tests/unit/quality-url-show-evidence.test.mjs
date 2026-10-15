/**
 * BRO-5395: a review url that names the show (or a Theatre Record filing) is
 * show-identity evidence for assessTextQuality's junk-page checks when the
 * text never prints the title. require() the real functions (§15).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const cq = require('../../scripts/lib/content-quality.js');
const T = "Standing at the Sky's Edge";
const ID = 'standing-at-the-skys-edge-west-end-2023';

test('urlNamesShow: every significant title word in the path', () => {
  assert.strictEqual(cq.urlNamesShow('https://www.telegraph.co.uk/theatre/what-to-see/standing-skys-edge-national-theatre-review-concept-trumps-content/', T), true);
  assert.strictEqual(cq.urlNamesShow('https://www.thestage.co.uk/reviews/standing-at-the-skys-edge-review-national-theatre-london', T), true);
  assert.strictEqual(cq.urlNamesShow('https://www.telegraph.co.uk/theatre/what-to-see/', T), false);
  assert.strictEqual(cq.urlNamesShow('https://example.com/standing-room', T), false);
  assert.strictEqual(cq.urlNamesShow(null, T), false);
});

test('urlNamesShow: a one-word title also needs "review" in the path', () => {
  assert.strictEqual(cq.urlNamesShow('https://x.com/company/about', 'Company'), false);
  assert.strictEqual(cq.urlNamesShow('https://x.com/theatre/company-review-sondheim', 'Company'), true);
});

test('qualityOptsFor reads url and Theatre Record filing', () => {
  assert.deepStrictEqual(cq.qualityOptsFor({ url: 'https://a.b/c', source: 'theatre-record' }), { url: 'https://a.b/c', trustedShowFiling: true });
  assert.deepStrictEqual(cq.qualityOptsFor({ url: null }), { url: null, trustedShowFiling: false });
});

const prose = 'People used to come from miles around to The Estate. One Local said The Story was Reckless and Tender, '
  + 'about Stories from the Middle of Sheffield, a new musical at the theatre with a strong cast and performance. ';
const text = prose.repeat(12);

test('with show evidence on, a url naming the show lifts the multi-show junk verdict', () => {
  const url = 'https://www.thestage.co.uk/reviews/standing-at-the-skys-edge-review-national-theatre-london';
  const off = cq.assessTextQuality(text, ID, T, { useShowEvidence: false, url });
  const on = cq.assessTextQuality(text, ID, T, { useShowEvidence: true, url });
  assert.strictEqual(off.quality, 'garbage');
  assert.notStrictEqual(on.quality, 'garbage');
});

test('a url that does not name the show changes nothing', () => {
  const url = 'https://www.thestage.co.uk/reviews/some-other-show-review';
  assert.strictEqual(cq.assessTextQuality(text, ID, T, { useShowEvidence: true, url }).quality, 'garbage');
});

test('default stays off until the corpus audit flips it', () => {
  const url = 'https://www.thestage.co.uk/reviews/standing-at-the-skys-edge-review-national-theatre-london';
  assert.strictEqual(cq.assessTextQuality(text, ID, T, { url }).quality, 'garbage');
});
