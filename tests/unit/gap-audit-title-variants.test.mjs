/**
 * BRO-6909: the gap audit's URL gate must recognise a show under every title it is
 * billed by. Playbill's Verdict for "Clifford Odets’ Waiting for Lefty" and two of
 * the reviews it listed were rejected on the full title alone, so the audit graded
 * the show "0 gaps" while 4 of its 7 listed reviews were missing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { urlMatchesShowTitle, urlMatchesShow, titleTokens } = require('../../scripts/audit-show-review-gap.js');
const { titleVariants } = require('../../scripts/lib/show-title-tokens.js');

const LEFTY = { id: 'clifford-odets-waiting-for-lefty-off-broadway-2026', title: 'Clifford Odets’ Waiting for Lefty', venue: 'Classic Stage Company', cast: [], creativeTeam: [] };

test('Lefty: the Verdict article passes on its venue, and every review it lists passes inside it', () => {
  const article = 'https://playbill.com/article/what-do-reviews-think-of-waiting-for-lefty-at-classic-stage-company';
  assert.equal(urlMatchesShowTitle(article, LEFTY, { context: 'article' }), true);
  assert.equal(urlMatchesShowTitle(article, LEFTY, { context: 'census' }), true);
  // the old full-title gate rejected the article itself (2 of 4 tokens)
  assert.equal(urlMatchesShow(article, titleTokens(LEFTY.title)), false);
  // the 2024 regional closed >1 year before this run, so a venue-less Verdict slug passes too
  assert.equal(urlMatchesShowTitle('https://playbill.com/article/what-are-critics-saying-about-waiting-for-lefty', LEFTY, { context: 'article' }), true);
  for (const u of [
    'https://www.vulture.com/article/theater-reviews-waiting-for-lefty-odets-specky-clark-doherty.html',
    'https://nystagereview.com/2026/11/02/waiting-for-lefty-no-no-odets/',
    'https://theaterpizzazz.com/finally-waiting-for-lefty-has-arrived/',
    'https://cititour.com/NYC_Broadway/Waiting-for-Lefty/1408',
  ]) {
    assert.equal(urlMatchesShowTitle(u, LEFTY, { context: 'article-link' }), true, u);
    // Un-scoped SERP results naming only "Waiting for Lefty" could be the 2024
    // production; the two that also say "odets" match the billed title itself.
    assert.equal(urlMatchesShowTitle(u, LEFTY, { context: 'census' }), /odets/.test(u), u);
  }
});

test("a shortened title that is another production's title needs proof it is this one", () => {
  const unicorn = { id: 'a-midsummer-nights-dream-unicorn-off-west-end-2026', title: "A Midsummer Night's Dream - Unicorn", venue: 'Unicorn Theatre', cast: [], openingDate: '2026-04-01' };
  for (const ctx of ['census', 'article']) {
    assert.equal(urlMatchesShowTitle('https://www.theguardian.com/stage/2026/may/02/a-midsummer-nights-dream-review-globe-london', unicorn, { context: ctx }), false, ctx);
    assert.equal(urlMatchesShowTitle('https://www.broadwayworld.com/westend/article/Review-Roundup-A-MIDSUMMER-NIGHTS-DREAM-at-Shakespeares-Globe-20260601', unicorn, { context: ctx }), false, ctx);
  }
  assert.equal(urlMatchesShowTitle('https://example.co.uk/review-a-midsummer-nights-dream-unicorn-theatre/', unicorn, { context: 'census' }), true);
  const yf = { id: 'mel-brooks-young-frankenstein-hope-mill-regional-2025', title: "Mel Brooks' Young Frankenstein", venue: 'Hope Mill Theatre', cast: [], openingDate: '2025-10-10' };
  assert.equal(urlMatchesShowTitle('https://www.whatsonstage.com/news/young-frankenstein-review-garrick-theatre/', yf, { context: 'census' }), false);
  assert.equal(urlMatchesShowTitle('https://www.allabouttheatreuk.com/post/review-young-frankenstein-the-musical-hope-mill-theatre-manchester-15-10-2025', yf, { context: 'census' }), true);
  const wc = { id: 'irving-berlins-white-christmas-regional-2022', title: "Irving Berlin's White Christmas", venue: 'Paramount Theatre', cast: [], openingDate: '2022-11-01' };
  assert.equal(urlMatchesShowTitle('https://www.thestage.co.uk/reviews/white-christmas-review-dominion-theatre', wc, { context: 'census' }), false);
});

test('a one-number alias does not match any path with that number', () => {
  const bc = { id: 'billy-crystal-860-2026', title: 'Billy Crystal: 860', akaTitles: ['860'], cast: [], venue: '' };
  assert.equal(urlMatchesShowTitle('https://example.com/p/860/', bc), false);
});

test('a performer prefix is dropped only when that performer is credited', () => {
  const credited = { id: 'x', title: 'Kelly McCaughan: Catholic Guilt', cast: [{ name: 'Kelly McCaughan' }], venue: 'SoHo Playhouse' };
  assert.equal(urlMatchesShowTitle('https://example.com/review-catholic-guilt-soho-playhouse/', credited), true);
  const subtitle = { id: 'y', title: 'Les Misérables: The Arena Concert Spectacular', cast: [], venue: 'O2' };
  assert.deepEqual(titleVariants(subtitle), [subtitle.title]);
});

test('possessives that are part of the title stay whole', () => {
  for (const t of ["Ma Rainey's Black Bottom", "Jacob Marley's Christmas Carol", "Joe Turner's Come and Gone", "Hell's Kitchen", "The Band's Visit"]) {
    assert.deepEqual(titleVariants({ title: t, cast: [], venue: '' }), [t], t);
  }
});

test('dash and bracket suffixes drop only when they name the venue', () => {
  assert.deepEqual(titleVariants({ title: 'Jack and the Beanstalk - Theatre on Kew', venue: 'Theatre on Kew' }).slice(1), ['Jack and the Beanstalk']);
  assert.deepEqual(titleVariants({ title: 'Patti LuPone - Matters Of The Heart', venue: 'Vivian Beaumont' }).slice(1), []);
  assert.deepEqual(titleVariants({ title: 'Pride and Prejudice* (*sort of)', venue: 'Criterion' }).slice(1), []);
});

test('the wrong-show cases the gate exists for stay rejected', () => {
  const gi = { id: 'girl-interrupted', title: 'Girl, Interrupted', cast: [], venue: '' };
  assert.equal(urlMatchesShowTitle('https://playbill.com/article/what-are-critics-saying-about-weather-girl', gi), false);
});

test('alternate titles must appear as a phrase, so a venue alias or a short billed title cannot pull in other shows', () => {
  const fever = { id: 'f', title: 'The Fever', akaTitles: ['The Fever (Greenwich House Theater)'], venue: 'Greenwich House Theater', cast: [] };
  assert.equal(urlMatchesShowTitle('https://exeuntnyc.com/reviews/review-pre-existing-condition-at-greenwich-house-theater/', fever), false);
  const pool = { id: 'p', title: 'Mike Birbiglia: The Old Man and the Pool', cast: [{ name: 'Mike Birbiglia' }], venue: 'Vivian Beaumont' };
  // a 2022 regional shares the short title, so only a link inside this show's round-up counts
  assert.equal(urlMatchesShowTitle('https://www.theatermania.com/broadway/news/review-the-old-man-and-the-pool_94552.html', pool, { context: 'article-link' }), true);
  assert.equal(urlMatchesShowTitle('https://www.theatermania.com/broadway/news/review-the-old-man-and-the-pool_94552.html', pool), false);
  assert.equal(urlMatchesShowTitle('https://broadwaynews.com/2022/12/20/review-the-collaboration-is-an-unfinished-portrait-of-the-artist-as-a-young-and-old-man/', pool), false);
  const quinn = { id: 'q', title: 'Colin Quinn: Long Story Short', cast: [{ name: 'Colin Quinn' }], venue: 'Helen Hayes' };
  assert.equal(urlMatchesShowTitle('https://www.nypost.com/seven/02202009/entertainment/theater/story_isnt_long_for_life_155990.htm', quinn), false);
});

test('a company-labelled title matches its bare head only with venue or initials proof (ENO Tosca)', () => {
  const eno = { id: 'tosca-english-national-opera-west-end-2026', title: 'Tosca - English National Opera', venue: 'London Coliseum', openingDate: '2026-10-30' };
  const met = { id: 'tosca-off-broadway-2026', title: 'Tosca', venue: 'Metropolitan Opera House', openingDate: '2026-11-01' };
  const london = ['https://thestage.co.uk/reviews/tosca-review-london-coliseum-puccini-annilese-miskimmon',
    'https://www.telegraph.co.uk/opera/what-to-see/tosca-eno-review/', 'https://www.thereviewshub.com/eno-tosca-london-coliseum/'];
  for (const u of london) {
    assert.equal(urlMatchesShowTitle(u, eno, { context: 'census' }), true, `eno ${u}`);
    assert.equal(urlMatchesShowTitle(u, met, { context: 'census' }), false, `met ${u}`);
  }
  const bare = 'https://www.theguardian.com/music/2026/nov/01/tosca-review-axelle-fanyo-christopher-purves';
  assert.equal(urlMatchesShowTitle(bare, eno, { context: 'census' }), false);
  assert.equal(urlMatchesShowTitle(bare, eno, { context: 'article' }), false);
  assert.equal(urlMatchesShowTitle(bare, eno, { context: 'article-link' }), true);
  assert.equal(urlMatchesShowTitle(bare, met, { context: 'census' }), true);
  const nyc = 'https://www.nytimes.com/2026/11/02/arts/music/tosca-metropolitan-opera-review.html';
  assert.equal(urlMatchesShowTitle(nyc, eno, { context: 'census' }), false);
  assert.equal(urlMatchesShowTitle(nyc, met, { context: 'census' }), true);
});

test('a one-word head never passes on dates alone (Stories)', () => {
  const s = { id: 'stories-the-tap-dance-sensation-west-end-2026', title: 'STORIES – The Tap Dance Sensation', venue: 'Peacock Theatre', openingDate: '2026-07-01' };
  assert.equal(urlMatchesShowTitle('https://chicagoreader.com/arts-culture/theater-review/harlem-stories/', s, { context: 'article' }), false);
  assert.equal(urlMatchesShowTitle('https://www.thetimes.com/culture/theatre-dance/article/stories-review-rb-dance-company-peacock-theatre-5c6q83q2d', s, { context: 'census' }), true);
});
