import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { showScoreUrlForShow } = require('./show-score-discover.js');
const { showScoreSlugGuessBlockReason } = require('./show-score-discover.js');

test('BRO-5278: slug guesses share newest-production ownership, including open siblings and ties', () => {
  const older = { id: 'cats-2016', title: 'Cats', category: 'broadway', status: 'open', openingDate: '2016-07-31' };
  const newer = { ...older, id: 'cats-2026', openingDate: '2026-07-31' };
  const url = 'https://www.show-score.com/broadway-shows/cats-broadway';
  assert.ok(showScoreSlugGuessBlockReason(older, url, {}, [older, newer], 2016));
  assert.equal(showScoreSlugGuessBlockReason(newer, url, {}, [older, newer], 2026), null);
  assert.equal(showScoreSlugGuessBlockReason(older, `${url}-2016`, {}, [older, newer], 2016), null);
  const tie = { ...older, id: 'cats-other-2016' };
  assert.ok(showScoreSlugGuessBlockReason(older, url, {}, [older, tie], 2016));
});

test('BRO-5278: slug guesses preserve curated ownership and London discovery', () => {
  const show = { id: 'cats-2016', title: 'Cats', category: 'broadway', status: 'open', openingDate: '2016-07-31' };
  const url = 'https://www.show-score.com/broadway-shows/cats-2016';
  assert.ok(showScoreSlugGuessBlockReason(show, url, { other: `${url.toUpperCase()}/` }, [show], 2016));
  assert.equal(showScoreSlugGuessBlockReason(show, url, { [show.id]: url }, [show], 2016), null);
  const london = { ...show, category: 'west-end' };
  assert.equal(showScoreSlugGuessBlockReason(london, 'https://www.show-score.com/uk/london/west-end-shows/cats-london', {}, [london], 2016), null);
  assert.ok(showScoreSlugGuessBlockReason(show, url.replace('-2016', ''), {}, null, 2016));
});

// BRO-3416. Show Score keeps ONE page per title — the current or most recent
// production — so when two same-title shows slug to the same URL, at most one
// of them is that page's actual subject. she-loves-me-1994 and she-loves-me-2016
// both pointed at /broadway-shows/she-loves-me (the 2016 Roundabout revival);
// every show-score pass ingested 2016 notices into the 1993-94 entry, leaving
// 21 of that directory's 22 review files belonging to the wrong production.
//
// Deleting the wrong show's curated entry is the established remedy
// (scrape-show-score-audience.js:802 deletes a duplicate outright) but does not
// stick on its own: deletion falls through to slug construction here, which
// rebuilds the identical URL. These tests lock the construction gate that makes
// the deletion durable.

const SLM_2016 = 'https://www.show-score.com/broadway-shows/she-loves-me';

const show1994 = { id: 'she-loves-me-1994', title: 'She Loves Me', category: 'broadway' };
const show2016 = { id: 'she-loves-me-2016', title: 'She Loves Me', category: 'broadway' };

test('curated entry is returned verbatim, even when another show shares the URL', () => {
  // Only CONSTRUCTED urls are gated. An operator who deliberately points two
  // shows at one page keeps that decision.
  const map = { 'she-loves-me-1994': SLM_2016, 'she-loves-me-2016': SLM_2016 };
  assert.equal(showScoreUrlForShow(show1994, map), SLM_2016);
});

test('constructed URL is refused when another show already owns it', () => {
  // The post-fix state: she-loves-me-1994's entry has been removed, so its URL
  // would be constructed — and it collides with the 2016 entry.
  const map = { 'she-loves-me-2016': SLM_2016 };
  assert.equal(showScoreUrlForShow(show1994, map), null);
});

test('constructed URL is returned when nothing else claims it', () => {
  const map = { 'some-other-show-2020': 'https://www.show-score.com/broadway-shows/something-else' };
  assert.equal(showScoreUrlForShow(show2016, map), SLM_2016);
});

test('a show does not block its own constructed URL', () => {
  // Self-collision must not null out the result.
  const map = { 'she-loves-me-2016': SLM_2016 };
  assert.equal(showScoreUrlForShow(show2016, map), SLM_2016);
});

test('ownership comparison ignores a trailing slash and case', () => {
  const map = { 'she-loves-me-2016': 'HTTPS://WWW.Show-Score.com/broadway-shows/She-Loves-Me/' };
  assert.equal(showScoreUrlForShow(show1994, map), null);
});

test('off-Broadway shows use the off-broadway-shows section', () => {
  const ob = { id: 'x-off-broadway-2026', title: 'Example Show', category: 'off-broadway' };
  assert.equal(showScoreUrlForShow(ob, {}), 'https://www.show-score.com/off-broadway-shows/example-show');
});

test('an off-Broadway constructed URL does not collide with the Broadway section', () => {
  // Different sections mean different pages — same slug must NOT be treated as
  // the same URL.
  const ob = { id: 'she-loves-me-off-broadway-2026', title: 'She Loves Me', category: 'off-broadway' };
  const map = { 'she-loves-me-2016': SLM_2016 };
  assert.equal(showScoreUrlForShow(ob, map), 'https://www.show-score.com/off-broadway-shows/she-loves-me');
});

test('non-string map values are skipped rather than throwing', () => {
  const map = { 'busted-entry': null, 'another': undefined, 'she-loves-me-2016': SLM_2016 };
  assert.equal(showScoreUrlForShow(show1994, map), null);
});

test('no map at all still constructs (callers may pass nothing)', () => {
  assert.equal(showScoreUrlForShow(show2016, null), SLM_2016);
  assert.equal(showScoreUrlForShow(show2016, undefined), SLM_2016);
});

test('missing show or title yields null', () => {
  assert.equal(showScoreUrlForShow(null, {}), null);
  assert.equal(showScoreUrlForShow({ id: 'x' }, {}), null);
});

test('diacritics are folded before slugging (Les Misérables)', () => {
  // Regression guard on the pre-existing behaviour the fix must not disturb:
  // without folding, é becomes a separator and the slug 404s (task #648).
  const show = { id: 'les-miserables-2014', title: 'Les Misérables', category: 'broadway' };
  assert.equal(showScoreUrlForShow(show, {}), 'https://www.show-score.com/broadway-shows/les-miserables');
});

test('London and regional shows never get a constructed NYC url', () => {
  // space-dogs-off-west-end-2026 slugged to the NYC /broadway-shows/space-dogs
  // page and pulled MCC's 2022 Off-Broadway notices in as current-run misses.
  for (const category of ['west-end', 'off-west-end', 'regional', '', undefined]) {
    const show = { id: `space-dogs-${category}`, title: 'Space Dogs', category };
    assert.equal(showScoreUrlForShow(show, {}), null, `category=${category}`);
  }
});

test('a curated London entry is still returned for a West End show', () => {
  const url = 'https://www.show-score.com/uk/london/west-end-shows/hadestown-west-end';
  const show = { id: 'hadestown-west-end-2024', title: 'Hadestown', category: 'west-end' };
  assert.equal(showScoreUrlForShow(show, { 'hadestown-west-end-2024': url }), url);
});

// BRO-3556: the curated-map check above only catches a collision with a
// CURATED sibling. Two same-title productions that are BOTH un-curated each
// construct the identical URL. With the full shows list passed in, the newest
// production keeps it (Show Score's page shows the most recent production);
// older siblings get null, and an ambiguous newest fails closed for all.
const old1994 = { ...show1994, openingDate: '1993-06-10' };
const new2016 = { ...show2016, openingDate: '2016-03-17' };

test('un-curated same-title siblings: the newest keeps the URL, the older gets null', () => {
  const all = [old1994, new2016];
  assert.equal(showScoreUrlForShow(old1994, {}, all), null);
  assert.equal(showScoreUrlForShow(new2016, {}, all), SLM_2016);
});

test('newest falls back to previewsStartDate, then the id year', () => {
  const prev = { id: 'she-loves-me-2030', title: 'She Loves Me', category: 'broadway', previewsStartDate: '2030-01-05' };
  assert.equal(showScoreUrlForShow(prev, {}, [new2016, prev]), SLM_2016);
  assert.equal(showScoreUrlForShow(new2016, {}, [new2016, prev]), null);
  // The id year only RANKS rivals: an undated newest gets nothing (BRO-5261
  // retro-review: dreamgirls-2026 / private-lives-2025, announced with no
  // dates, took the page Show Score still shows for the last production).
  assert.equal(showScoreUrlForShow(show2016, {}, [show1994, show2016]), null);
  assert.equal(showScoreUrlForShow(show1994, {}, [show1994, show2016]), null);
  const dated2016 = { ...show2016, openingDate: '2016-03-17' };
  assert.equal(showScoreUrlForShow(dated2016, {}, [show1994, dated2016]), SLM_2016);
});

test('an announced revival with no dates does not take a dated production\'s page', () => {
  const announced = { id: 'she-loves-me-2027', title: 'She Loves Me', category: 'broadway', status: 'announced' };
  const all = [new2016, announced];
  assert.equal(showScoreUrlForShow(announced, {}, all), null);
  assert.equal(showScoreUrlForShow(new2016, {}, all), null);
});

test('hasNewerSameTitleProduction: only a definitively newer same-section sibling counts', () => {
  const { hasNewerSameTitleProduction } = require('./show-score-discover.js');
  const c = (x) => ({ ...x, status: 'closed' });
  const announced = { id: 'she-loves-me-2027', title: 'She Loves Me', category: 'broadway' };
  const ob = { id: 'she-loves-me-ob-2030', title: 'She Loves Me', category: 'off-broadway', openingDate: '2030-01-01' };
  const we = { id: 'she-loves-me-we-2031', title: 'She Loves Me', category: 'west-end', openingDate: '2031-01-01' };
  assert.equal(hasNewerSameTitleProduction(c(old1994), [old1994, new2016]), true);
  assert.equal(hasNewerSameTitleProduction(c(new2016), [old1994, new2016]), false);
  // A running production keeps slug guessing even with a newer sibling.
  assert.equal(hasNewerSameTitleProduction({ ...old1994, status: 'open' }, [old1994, new2016]), false);
  // An undated announced sibling has no Show Score page yet: it does not count.
  assert.equal(hasNewerSameTitleProduction(c(new2016), [new2016, announced]), false);
  // Other sections have their own Show Score pages.
  assert.equal(hasNewerSameTitleProduction(c(new2016), [new2016, ob, we]), false);
  const we2 = { ...we, id: 'she-loves-me-we-2020', category: 'off-west-end', openingDate: '2020-01-01', status: 'closed' };
  assert.equal(hasNewerSameTitleProduction(we2, [we2, we]), true);
  // A sibling with no usable date at all, or no list, does not count.
  const undatable = { id: 'she-loves-me', title: 'She Loves Me', category: 'broadway' };
  assert.equal(hasNewerSameTitleProduction(c(new2016), [new2016, undatable]), false);
  assert.equal(hasNewerSameTitleProduction(c(new2016), null), false);
});

test('a tie for newest fails closed for every sibling', () => {
  const a = { id: 'she-loves-me-a', title: 'She Loves Me', category: 'broadway', openingDate: '2016-03-17' };
  const all = [a, new2016, old1994];
  assert.equal(showScoreUrlForShow(a, {}, all), null);
  assert.equal(showScoreUrlForShow(new2016, {}, all), null);
  assert.equal(showScoreUrlForShow(old1994, {}, all), null);
});

test('an undatable sibling fails closed for every sibling', () => {
  const undated = { id: 'she-loves-me-revival', title: 'She Loves Me', category: 'broadway' };
  const all = [undated, new2016];
  assert.equal(showScoreUrlForShow(new2016, {}, all), null);
  assert.equal(showScoreUrlForShow(undated, {}, all), null);
});

test('a unique un-curated title still gets its constructed URL with allShows', () => {
  const unique = { id: 'example-show-2026', title: 'Example Show', category: 'broadway' };
  const all = [show1994, show2016, unique];
  assert.equal(showScoreUrlForShow(unique, {}, all), 'https://www.show-score.com/broadway-shows/example-show');
});

test('curating one sibling resolves the un-curated collision', () => {
  // The curated side returns its entry; the other side is refused by the
  // existing curated-map ownership check.
  const all = [show1994, show2016];
  const map = { 'she-loves-me-2016': SLM_2016 };
  assert.equal(showScoreUrlForShow(show2016, map, all), SLM_2016);
  assert.equal(showScoreUrlForShow(show1994, map, all), null);
});

test('a sibling curated to a DIFFERENT url does not block the constructed one', () => {
  const all = [show1994, show2016];
  const map = { 'she-loves-me-1994': 'https://www.show-score.com/broadway-shows/she-loves-me-1994-revival' };
  assert.equal(showScoreUrlForShow(show2016, map, all), SLM_2016);
});

test('same title in a different section is not an un-curated collision', () => {
  const ob = { id: 'she-loves-me-off-broadway-2026', title: 'She Loves Me', category: 'off-broadway' };
  const all = [ob, show2016];
  assert.equal(showScoreUrlForShow(ob, {}, all), 'https://www.show-score.com/off-broadway-shows/she-loves-me');
  assert.equal(showScoreUrlForShow(show2016, {}, all), SLM_2016);
});

test('a London sibling with the same title does not collide (it constructs nothing)', () => {
  const we = { id: 'she-loves-me-west-end-2026', title: 'She Loves Me', category: 'west-end' };
  assert.equal(showScoreUrlForShow(show2016, {}, [show2016, we]), SLM_2016);
});

test('the show itself appearing in allShows is not a collision', () => {
  assert.equal(showScoreUrlForShow(show2016, {}, [show2016]), SLM_2016);
});

// BRO-4996: the show's own poster only, never a promoted show's.
test('showScorePosterFromHtml takes the poster in the og:image folder, any CloudFront host', () => {
  const { showScorePosterFromHtml } = require('./show-score-discover.js');
  const promo = 'https://d4ov6iqsvotvt.cloudfront.net/uploads/show/poster_image/62/medium_1711643050-chicks_in_heaven.jpg';
  const own = 'https://dalyklerwhmui.cloudfront.net/uploads/show/poster_image/841/medium_Hughie180.jpg';
  const html = `<meta property="og:image" content="https://www.show-score.com/fb-posts/image/show/841_1791609030.jpg"><img src="${promo}"><img src="${own}">`;
  assert.deepEqual(showScorePosterFromHtml(html), { poster: own, thumbnail: own.replace('/medium_', '/preview_') });
  const reversed = `<meta content="https://www.show-score.com/fb-posts/image/show/841_1.jpg" property="og:image"><img src="${promo}"><img src="${own}">`;
  assert.equal(showScorePosterFromHtml(reversed).poster, own, 'attribute order does not matter');
});

test('showScorePosterFromHtml: no og:image or no poster in its folder means no poster', () => {
  const { showScorePosterFromHtml } = require('./show-score-discover.js');
  const promo = 'https://d4ov6iqsvotvt.cloudfront.net/uploads/show/poster_image/62/medium_x.jpg';
  assert.equal(showScorePosterFromHtml(`<img src="${promo}">`), null);
  assert.equal(showScorePosterFromHtml(`<meta property="og:image" content="https://www.show-score.com/fb-posts/image/show/841_1.jpg"><img src="${promo}">`), null);
  assert.equal(showScorePosterFromHtml(''), null);
});

test('bareSlugGuessUnsafe: closed-and-superseded, or undated with any same-title sibling', () => {
  const { bareSlugGuessUnsafe } = require('./show-score-discover.js');
  const announced = { id: 'she-loves-me-2027', title: 'She Loves Me', category: 'broadway', status: 'announced' };
  // Second-opinion finding: an undated upcoming revival is not closed, but the
  // year gate blocks nothing without dates, so bare slugs are unsafe for it.
  assert.equal(bareSlugGuessUnsafe(announced, [announced, new2016]), true);
  assert.equal(bareSlugGuessUnsafe(announced, [announced]), false);
  assert.equal(bareSlugGuessUnsafe({ ...old1994, status: 'closed' }, [old1994, new2016]), true);
  assert.equal(bareSlugGuessUnsafe({ ...new2016, status: 'open' }, [old1994, new2016]), false);
});
