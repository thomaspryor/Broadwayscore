import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('./dailymail-url-discovery.js');

// Shapes copied from real DM pages found in BRO-716.
const REVIEW = 'Not all shaggy dog stories feature a shaggy dog. But one that does is Jerome K. Jerome\'s comic Victorian travelogue, Three Men In A Boat. In this staging the dog is a puppet and the river is a painted cloth that the actors ripple by hand while the three heroes bicker over tins of pineapple.';
const BUNDLED = [
  'Verdict: Brassy and caustic',
  'Rating: Four stars out of five',
  'A lead review of a different eighties play, its whole first paragraph about something else entirely.',
  'More of the lead review, still nothing to do with boats or dogs or rivers at all.',
  'And a closing line for the lead review that also mentions nothing relevant.',
  'Three Men In A Boat (Rose Theatre, Kingston, London until October 10)',
  'Rating: Three stars out of five',
  'Not all shaggy dog stories feature a shaggy dog. But one that does is Jerome K. Jerome&#39;s comic Victorian travelogue, Three Men In A Boat.',
  'In this staging the dog is a puppet and the river is a painted cloth that the actors ripple by hand while the three heroes bicker over tins of pineapple.',
];

test('matchReview finds the review mid-page and reports its paragraph span', () => {
  const m = L.matchReview(REVIEW, BUNDLED);
  assert.ok(m.overlap >= 0.85, `overlap ${m.overlap}`);
  assert.equal(m.firstMatch, 7);
  assert.equal(m.lastMatch, 8);
});

test('an unrelated page does not match', () => {
  const m = L.matchReview(REVIEW, ['Kylie steps out in a sequinned gown at the premiere of her new film in Mayfair on Tuesday night.']);
  assert.equal(m.overlap, 0);
  assert.equal(m.firstMatch, -1);
});

test('a bundled review takes its OWN section rating, not the lead show\'s', () => {
  const m = L.matchReview(REVIEW, BUNDLED);
  const r = L.parseSectionRating(BUNDLED, m.firstMatch);
  assert.equal(r.stars, 3);
  assert.equal(L.classifyPlacement(BUNDLED, m.firstMatch, 'PATRICK MARMION: Brassy Eighties romp still has a caustic edge', 'Three Men in a Boat'), 'secondary');
  assert.equal(L.shouldWriteUrl({ overlap: m.overlap, placement: 'secondary', sectionRating: r }), true);
});

test('a bundled review with no parseable rating is not written (page stars belong to the lead)', () => {
  // Old /home/event/ format: "Title / Venue Until ..." heading, stars only as images.
  const paras = ['God of Carnage lead text one.', 'Lead two.', 'Lead three.', 'Lead four.', 'Lead five.', 'Les Misérables', 'Sondheim Theatre, London Until October 17, 2hrs 50mins', ...BUNDLED.slice(7)];
  const m = L.matchReview(REVIEW, paras);
  assert.equal(L.parseSectionRating(paras, m.firstMatch), null);
  const placement = L.classifyPlacement(paras, m.firstMatch, 'God Of Carnage review: Elizabeth McGovern stars', 'Les Misérables');
  assert.equal(placement, 'secondary');
  assert.equal(L.shouldWriteUrl({ overlap: m.overlap, placement, sectionRating: null }), false);
});

test('a page titled with the show is the lead even when verdicts for other shows are listed first', () => {
  // The Mousetrap page opens with every show's verdict, then the Mousetrap body.
  const paras = ['The Mousetrap (St Martin\'s, London )', 'Verdict: Creaky but kind of fun', 'Love Letters (Theatre Royal, Haymarket)', 'Verdict: Touching romance', 'April in Paris (touring)', 'Verdict: Good Godber', 'Body.'];
  assert.equal(L.classifyPlacement(paras, 6, 'The stage is set (at last!) for murder most cheesy: PATRICK MARMION reviews The Mousetrap', 'The Mousetrap'), 'lead');
});

test('parseRatingLine reads every DM rating style and ignores body sentences', () => {
  assert.equal(L.parseRatingLine('Rating: Four out of five stars'), 4);
  assert.equal(L.parseRatingLine('Star rating: 3/5'), 3);
  assert.equal(L.parseRatingLine('Rating: Three stars out of five'), 3);
  assert.equal(L.parseRatingLine('Rating: Three stars'), 3);
  assert.equal(L.parseRatingLine('FOUR STARS'), 4);
  assert.equal(L.parseRatingLine('Rating: ****'), 4);
  assert.equal(L.parseRatingLine('Verdict: Retro riot'), null);
  assert.equal(L.parseRatingLine('It is a show I would give five stars out of five to if I could, and frankly I think everybody in the audience felt the same way.'), null);
});

test('parseDayArchive + isCandidatePath keep theatre reviews and drop wires/film', () => {
  const html = '<a href="/tvshowbiz/article-16051459/GEORGINA-BROWN-Roger-Allam-cuckold-comedy-class.html">x</a><a href="/wires/pa/article-1/Theatre-review.html">y</a><a href="/tvshowbiz/article-2/BRIAN-VINER-reviews-film.html">z</a><a href="/tvshowbiz/article-16051459/GEORGINA-BROWN-Roger-Allam-cuckold-comedy-class.html">dup</a>';
  const links = L.parseDayArchive(html);
  assert.equal(links.length, 3);
  assert.deepEqual(links.filter(L.isCandidatePath), ['/tvshowbiz/article-16051459/GEORGINA-BROWN-Roger-Allam-cuckold-comedy-class.html']);
});

test('one stock phrase shared with the lead review does not move firstMatch to the top (review finding)', () => {
  const paras = ['Rating: Five stars', 'It is one of the best of the year, a lead review about a wholly different play with nothing in common.', ...BUNDLED.slice(2)];
  const m = L.matchReview(REVIEW + ' Truly one of the best of the', paras);
  assert.equal(m.firstMatch, 7);
  assert.equal(L.parseSectionRating(paras, m.firstMatch).stars, 3);
});

test('the rating lookback stops at the previous review\'s body (review finding)', () => {
  const paras = ['Rating: Four stars', 'Body of review B, long enough to be a real paragraph of criticism and clearly not a heading line at all.', 'Les Misérables / Sondheim Theatre', ...BUNDLED.slice(7)];
  const m = L.matchReview(REVIEW, paras);
  assert.equal(m.firstMatch, 3);
  assert.equal(L.parseSectionRating(paras, m.firstMatch), null);
});

test('normWords folds diacritics instead of shredding the word', () => {
  assert.deepEqual(L.normWords('Les Misérables'), ['les', 'miserables']);
});

// BRO-7869: real urls. Globe 2026 Tempest text (TR print date 2026-01-30) carried the
// Drury Lane Tempest page (published 2024-12-20); American Psycho ran 2026-02-02.
const DRURY_LANE = 'https://www.dailymail.co.uk/tvshowbiz/article-14212015/PATRICK-MARMION-reviews-Tempest-Sigourney-Weaver.html';
const AMERICAN_PSYCHO = 'https://www.dailymail.com/tvshowbiz/article-15518223/PATRICK-MARMIONs-night-review-American-Psycho.html';

test('a DM url whose article id predates the print date by over a year is proven wrong (BRO-7869)', () => {
  const p = L.dailyMailUrlPredatesReview(DRURY_LANE, '2026-01-30');
  assert.ok(p, 'Drury Lane 2024 url on a 2026 review must be proven wrong');
  assert.equal(p.articleId, 14212015);
  assert.equal(p.anchorDate, '2025-01-01');
  assert.ok(p.gapDays > L.URL_PREDATES_REVIEW_DAYS);
});

test('a DM url from the review\'s own time, or the right review on its own date, is not flagged', () => {
  assert.equal(L.dailyMailUrlPredatesReview(AMERICAN_PSYCHO, '2026-01-30'), null);
  assert.equal(L.dailyMailUrlPredatesReview(DRURY_LANE, '2024-12-20'), null);
  // An id newer than every anchor gives no proof either way.
  assert.equal(L.dailyMailUrlPredatesReview('https://www.dailymail.co.uk/tvshowbiz/article-16300000/x.html', '2026-11-01'), null);
});

test('non-DM hosts, id-less paths and missing dates give no proof', () => {
  assert.equal(L.dailyMailUrlPredatesReview('https://www.theguardian.com/stage/article-14212015/x.html', '2026-01-30'), null);
  assert.equal(L.dailyMailUrlPredatesReview('https://www.dailymail.co.uk/tvshowbiz/index.html', '2026-01-30'), null);
  assert.equal(L.dailyMailUrlPredatesReview(DRURY_LANE, null), null);
  assert.equal(L.dailyMailUrlPredatesReview('not a url', '2026-01-30'), null);
});

test('DM id anchors are strictly increasing in date and id', () => {
  for (let i = 1; i < L.DM_ID_ANCHORS.length; i++) {
    assert.ok(L.DM_ID_ANCHORS[i][0] > L.DM_ID_ANCHORS[i - 1][0]);
    assert.ok(L.DM_ID_ANCHORS[i][1] > L.DM_ID_ANCHORS[i - 1][1]);
  }
});

test('review-field-edit accepts the url clear on the TR print row only (BRO-7869)', () => {
  const { applyReviewFieldEdit } = require('./review-field-edit.js');
  const stamp = { fixId: 'bro-7869', at: '2026-11-20T00:00:00.000Z' };
  const base = { showId: 'the-tempest-globe-off-west-end-2026', outletId: 'daily-mail', criticName: 'Patrick Marmion', url: DRURY_LANE, publishDate: '2026-01-30' };
  const action = { file: 'the-tempest-globe-off-west-end-2026/daily-mail--patrick-marmion.json', field: 'url', oldValue: DRURY_LANE, newValue: '' };
  const tr = applyReviewFieldEdit({ ...base, source: 'theatre-record', theatreRecordUrl: 'https://www.theatrerecord.com/archive/2026/1/37280-the-tempest' }, action, stamp, {});
  assert.equal(tr.ok, true, tr.reason);
  assert.equal(tr.record.url, '');
  const web = applyReviewFieldEdit({ ...base, source: 'outlet-serp-discovery' }, action, stamp, {});
  assert.equal(web.ok, false, 'a non-print row\'s date may come from the url, so no proof');
  const sameTime = applyReviewFieldEdit({ ...base, source: 'theatre-record', url: AMERICAN_PSYCHO }, { ...action, oldValue: AMERICAN_PSYCHO }, stamp, {});
  assert.equal(sameTime.ok, false);
});
