// BRO-6629: Show Score keeps one page per title, so a revival's page also
// lists the prior production's notices. Year-less review URLs (curtainup
// x.html, offoffonline ?p=, exeunt slugs) slipped past the URL-year gate and
// were booked as missing reviews of the current run. Each critic tile carries
// its own publish date; these tests pin the tile parser and the date gate.
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractShowScoreCriticTiles, parseShowScoreTileDate, fetchAllShowScoreCriticTiles } = require('./show-score-discover.js');
const { isShowScoreTileDateOutOfRun, partitionShowScoreReviews, showScoreUrlBlockReason } = require('./gap-ingest-policy.js');

function tile({ id, outlet, date, href, previous = false }) {
  return `<div class='review-tile-v2 -critic' id='critic_review_${id}'>
  <div class='review-tile-v2__header'><img data-src="x.jpg" alt="${outlet}" src="pixel.gif" />
  <div class='review-tile-v2__critic-info'><div class='review-tile-v2__date'> ${date} </div></div></div>
  ${previous ? '<div class="review-tile-v2__date-based-label">For a previous production</div>' : ''}
  <div class='review-tile-v2__body'><p>&quot;quote&quot; <br>
  <a class="-tt-highlight fw-400" target="_blank" rel="nofollow noopener" href="${href}">Read more <i class="fa-external-link far"></i> </a></p></div></div>`;
}

const page = `<html><body>
${tile({ id: 1, outlet: 'TheaterMania', date: 'November 3rd, 2024', href: 'https://www.theatermania.com/news/gatz-review_1' })}
${tile({ id: 2, outlet: 'Exeunt Magazine', date: 'January 29th, 2019', href: 'http://exeuntnyc.com/reviews/review-gatz-nyu-skirball-center/', previous: true })}
${tile({ id: 3, outlet: 'Show Score', date: 'May 1st, 2024', href: 'https://www.show-score.com/member/x' })}
${tile({ id: 4, outlet: 'TheaterMania', date: 'November 3rd, 2024', href: 'https://www.theatermania.com/news/gatz-review_1' })}
</body></html>`;

const gatz2024 = { id: 'gatz', title: 'Gatz', status: 'closed', previewsStartDate: '2024-10-15', openingDate: '2024-10-29', closingDate: '2024-12-15' };

test('parseShowScoreTileDate reads ordinal dates and rejects junk', () => {
  assert.equal(parseShowScoreTileDate('January 29th, 2019'), '2019-01-29');
  assert.equal(parseShowScoreTileDate(' November 3rd, 2024 '), '2024-11-03');
  assert.equal(parseShowScoreTileDate('May 1st, 2024'), '2024-05-01');
  assert.equal(parseShowScoreTileDate('Sept 1, 2024'), null);
  assert.equal(parseShowScoreTileDate(''), null);
  assert.equal(parseShowScoreTileDate(null), null);
});

test('extractShowScoreCriticTiles returns url, date, outlet and the previous-production label', () => {
  const tiles = extractShowScoreCriticTiles(page);
  assert.equal(tiles.length, 2, 'show-score self links and duplicate urls are dropped');
  assert.deepStrictEqual(tiles[0], { url: 'https://www.theatermania.com/news/gatz-review_1', date: '2024-11-03', previousProduction: false, outlet: 'TheaterMania' });
  assert.equal(tiles[1].date, '2019-01-29');
  assert.equal(tiles[1].previousProduction, true);
});

test('a Google-redirect Read more link is unwrapped to the outlet URL', () => {
  const html = tile({ id: 7, outlet: 'Exeunt', date: 'October 29th, 2024', href: 'https://www.google.com/url?q=https://exeuntnyc.com/reviews/review-x/&amp;sa=D&amp;source=editors' });
  assert.equal(extractShowScoreCriticTiles(html)[0].url, 'https://exeuntnyc.com/reviews/review-x/');
});

test('fetchAllShowScoreCriticTiles walks the page plus pagination', async () => {
  const more = tile({ id: 9, outlet: 'NYSR', date: 'November 9th, 2024', href: 'https://nystagereview.com/2024/11/09/gatz/' });
  const fetchHtml = async (u) => (u.includes('paginate_critic_reviews') ? (u.includes('page=2') ? JSON.stringify({ html: more }) : JSON.stringify({ html: '' })) : page);
  const tiles = await fetchAllShowScoreCriticTiles('https://www.show-score.com/off-broadway-shows/gatz', fetchHtml);
  const urls = tiles.map((t) => t.url);
  assert.ok(urls.includes('http://exeuntnyc.com/reviews/review-gatz-nyu-skirball-center/'));
  assert.ok(tiles.every((t) => 'date' in t));
});

test('isShowScoreTileDateOutOfRun: prior production, in-run, late, undated, priorRuns', () => {
  assert.equal(isShowScoreTileDateOutOfRun('2019-01-29', gatz2024), true, '2019 notice on a 2024 run');
  assert.equal(isShowScoreTileDateOutOfRun('2024-11-03', gatz2024), false);
  assert.equal(isShowScoreTileDateOutOfRun('2024-09-01', gatz2024), false, 'within the 60-day early slack');
  assert.equal(isShowScoreTileDateOutOfRun('2025-12-01', gatz2024), true, 'long after a closed run');
  assert.equal(isShowScoreTileDateOutOfRun('2025-12-01', { ...gatz2024, status: 'open', closingDate: null }), false, 'open run has no late bound');
  assert.equal(isShowScoreTileDateOutOfRun(null, gatz2024), false, 'undated fails open');
  assert.equal(isShowScoreTileDateOutOfRun('2019-01-29', { ...gatz2024, openingDate: null, previewsStartDate: null }), false, 'no run dates fails open');
  assert.equal(isShowScoreTileDateOutOfRun('2019-01-29', { ...gatz2024, priorRuns: [{ openingDate: '2019-01-20', closingDate: '2019-03-01' }] }), false, 'declared prior run is claimed');
  assert.equal(isShowScoreTileDateOutOfRun('2019-01-29', { ...gatz2024, priorRuns: [{ openingDate: '2019-01-20', closingDate: '2019-03-01', inheritReviews: false }] }), true, 'a separate production (inheritReviews:false) does not claim the tile');
});

test('partitionShowScoreReviews blocks a year-less prior-production URL by its tile date', () => {
  const reviews = [
    { url: 'http://exeuntnyc.com/reviews/review-gatz-nyu-skirball-center/', publishDate: '2019-01-29' },
    { url: 'https://www.theatermania.com/news/gatz-review_1', date: '2024-11-03' },
  ];
  const { kept, blocked } = partitionShowScoreReviews(reviews, gatz2024);
  assert.equal(kept.length, 1);
  assert.equal(blocked.length, 1);
  assert.equal(showScoreUrlBlockReason(reviews[0].url, gatz2024, { date: '2019-01-29' }), 'show-score-tile-date');
  assert.equal(showScoreUrlBlockReason(reviews[0].url, gatz2024), null, 'without a date the URL alone cannot tell');
});

test('showScoreLandingBlockReason: off-Broadway shows may land in the off-off section, Broadway shows may not', () => {
  const { showScoreLandingBlockReason } = require('./show-score-discover.js');
  const offOff = 'https://www.show-score.com/off-off-broadway-shows/caesar-and-cleopatra';
  assert.equal(showScoreLandingBlockReason(offOff, { isOffBroadway: true }), null);
  assert.equal(showScoreLandingBlockReason('https://www.show-score.com/off-broadway-shows/gatz', { isOffBroadway: true }), null);
  assert.equal(showScoreLandingBlockReason('https://www.show-score.com/off-off-broadway-shows/redwood', { isOffBroadway: false }), 'off-off-broadway-redirect');
  assert.equal(showScoreLandingBlockReason('https://www.show-score.com/off-broadway-shows/x', {}), 'off-broadway-redirect');
  assert.equal(showScoreLandingBlockReason('https://www.show-score.com/broadway-shows/x', {}), null);
});

test('gather-reviews routes its Playwright landing check through showScoreLandingBlockReason', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../gather-reviews.js', import.meta.url), 'utf8');
  assert.match(src, /showScoreLandingBlockReason\(finalUrl, \{ isOffBroadway \}\)/);
  assert.doesNotMatch(src, /Always reject off-off-broadway/);
});
