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

test('qualityOptsFor reads url and publish date only (a Theatre Record filing is not evidence)', () => {
  assert.deepStrictEqual(cq.qualityOptsFor({ url: 'https://a.b/c', source: 'theatre-record', publishDate: '2023-02-14' }), { url: 'https://a.b/c', publishDate: '2023-02-14' });
});

test('urlNamesShow refuses film, TV, book and round-up pages', () => {
  assert.strictEqual(cq.urlNamesShow('https://www.thetimes.com/culture/film/article/wicked-for-good-review-x', 'Wicked'), false);
  assert.strictEqual(cq.urlNamesShow('https://www.wsj.com/arts-culture/books/baldwin-street-review-family-album-7c3bc6eb', 'The Family Album'), false);
  assert.strictEqual(cq.urlNamesShow('https://inews.co.uk/culture/arts/blues-for-an-alabama-sky-tosca-and-iphigenia-in-splott-the-best-of-the-weeks-live-reviews-1894718', 'Blues for an Alabama Sky'), false);
  assert.strictEqual(cq.urlNamesShow('https://x.co.uk/arts/blues-for-an-alabama-sky-round-up', 'Blues for an Alabama Sky'), false);
});

test('a year in the url path far from the production does not count', () => {
  const url = 'https://www.theguardian.com/stage/2010/feb/18/standing-at-the-skys-edge-review';
  assert.strictEqual(cq.assessTextQuality(text, ID, T, { useShowEvidence: true, url, publishDate: '2023-02-14' }).quality, 'garbage');
});

const prose = 'People used to come from miles around to The Estate. One Local said The Story was Reckless and Tender, '
  + 'about Stories from the Middle of Sheffield, a new musical at the theatre with a strong cast and performance. ';
const text = prose.repeat(12);

test('with show evidence on, a url naming the show lifts the multi-show junk verdict', () => {
  const url = 'https://www.thestage.co.uk/reviews/standing-at-the-skys-edge-review-national-theatre-london';
  const off = cq.assessTextQuality(text, ID, T, { useShowEvidence: false, url, publishDate: '2023-02-14' });
  const on = cq.assessTextQuality(text, ID, T, { useShowEvidence: true, url, publishDate: '2023-02-14' });
  assert.strictEqual(off.quality, 'garbage');
  assert.notStrictEqual(on.quality, 'garbage');
});

test('a review dated far from the production year is not lifted', () => {
  const url = 'https://www.thestage.co.uk/reviews/standing-at-the-skys-edge-review-national-theatre-london';
  assert.strictEqual(cq.assessTextQuality(text, ID, T, { useShowEvidence: true, url, publishDate: '2030-01-01' }).quality, 'garbage');
  assert.strictEqual(cq.assessTextQuality(text, ID, T, { useShowEvidence: true, url, publishDate: null }).quality, 'garbage');
});

test('a url that does not name the show changes nothing', () => {
  const url = 'https://www.thestage.co.uk/reviews/some-other-show-review';
  assert.strictEqual(cq.assessTextQuality(text, ID, T, { useShowEvidence: true, url, publishDate: '2023-02-14' }).quality, 'garbage');
});

test('on by default since the corpus audit (BRO-5395)', () => {
  const url = 'https://www.thestage.co.uk/reviews/standing-at-the-skys-edge-review-national-theatre-london';
  assert.notStrictEqual(cq.assessTextQuality(text, ID, T, { url, publishDate: '2023-02-14' }).quality, 'garbage');
  assert.strictEqual(cq.assessTextQuality(text, ID, T, { url }).quality, 'garbage');
});

test('validateShowMentionedOrNamedByUrl: url evidence counts only near the production', () => {
  const body = 'A long review about a Sheffield estate musical with songs that soar and a cast that sings. '.repeat(20);
  const rec = { url: 'https://www.thestage.co.uk/reviews/standing-at-the-skys-edge-review-national-theatre-london', publishDate: '2023-02-14' };
  assert.strictEqual(cq.validateShowMentioned(body, T, ID).valid, false);
  assert.strictEqual(cq.validateShowMentionedOrNamedByUrl(body, T, ID, rec).valid, true);
  assert.strictEqual(cq.validateShowMentionedOrNamedByUrl(body, T, ID, { ...rec, publishDate: '2030-01-01' }).valid, false);
  assert.strictEqual(cq.validateShowMentionedOrNamedByUrl(body, T, ID, null).valid, false);
});
