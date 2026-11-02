import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const F = require('./city-review-finder.js');

test('norm drops articles, punctuation and diacritics', () => {
  assert.equal(F.norm('The Cher Show'), 'cher show');
  assert.equal(F.norm("Lamb's  Players — Théâtre"), 'lambs players theatre');
});

test('hasPhrase matches on token boundaries only', () => {
  assert.ok(F.hasPhrase('Review: RENT at Diversionary Theatre', 'Rent'));
  assert.ok(!F.hasPhrase('A different current affair', 'Rent'));
  assert.ok(!F.hasPhrase('apparent talent', 'Rent'));
});

test('titleVariants adds the pre-colon and no-"the musical" forms', () => {
  assert.deepEqual(F.titleVariants('Dear Evan Hansen'), ['Dear Evan Hansen']);
  assert.ok(F.titleVariants('Seussical: The Musical').includes('Seussical'));
  assert.ok(F.titleVariants('Hairspray the Musical').includes('Hairspray'));
});

test('theatreAliases keeps the distinctive phrase', () => {
  const a = F.theatreAliases('The Old Globe');
  assert.ok(a.includes('old globe'));
  assert.ok(F.theatreAliases('Central Square Theater (Cambridge)').includes('central square'));
  assert.ok(F.theatreAliases('Cygnet Theatre', ['cygnet']).includes('cygnet'));
});

test('looksLikeNonReview rejects announcements, keeps anything titled review', () => {
  assert.ok(F.looksLikeNonReview('Interview: Director on JOB', 'https://x/interview-job'));
  assert.ok(F.looksLikeNonReview('THE COTTAGE to Open at North Coast Rep', 'https://x/a'));
  assert.ok(!F.looksLikeNonReview('Review: Interview with the Vampire at the Globe', 'https://x/review-interview'));
  assert.ok(!F.looksLikeNonReview('A moving Fences at the Old Globe', 'https://x/fences'));
});

test('parseBwwDates handles ranges, single days and year rollover', () => {
  assert.deepEqual(F.parseBwwDates('Oct 28 – Nov 22, 2026'), { start: '2026-10-28', end: '2026-11-22' });
  assert.deepEqual(F.parseBwwDates('Nov 13, 2026'), { start: '2026-11-13', end: '2026-11-13' });
  assert.deepEqual(F.parseBwwDates('Dec 30 – Jan 3, 2027'), { start: '2026-12-30', end: '2027-01-03' });
  assert.equal(F.parseBwwDates('TBA'), null);
});

const CARD = `<article class="bww-card bww-card--feed"><div><a href="/san-diego/regional/The-Cottage-4404772"><img src="https://cloudimages.broadwayworld.com/regionalshows/a.png" class="bww-card__thumb"></a><div><h2 class="bww-card__title"><a href="/san-diego/regional/The-Cottage-4404772">The Cottage</a></h2><p class="bww-card__meta">Oct 28 – Nov 22, 2026 · <a href="/san-diego/regionalshows/NORTH-COAST-REPERTORY">North Coast Repertory</a>, Solana Beach</p></div></div></article>`;
test('parseBwwRegionalShows reads title, dates, theatre, city and image', () => {
  const [s] = F.parseBwwRegionalShows(CARD, 'san-diego');
  assert.equal(s.title, 'The Cottage');
  assert.equal(s.start, '2026-10-28');
  assert.equal(s.theatre, 'North Coast Repertory');
  assert.equal(s.city, 'Solana Beach');
  assert.match(s.image, /cloudimages/);
});

test('parseBwwReviewLinks keeps only Review- articles and reads the date from the slug', () => {
  const html = '<a href="/san-diego/article/Review-CARRIE-THE-MUSICAL-at-Oceanside-Theatre-Company-20261019">x</a><a href="/san-diego/article/Interview-Director-20261031">y</a>';
  const links = F.parseBwwReviewLinks(html, 'san-diego');
  assert.equal(links.length, 1);
  assert.equal(links[0].date, '2026-10-19');
});

const PROD = { title: 'Cyrano', theatre: 'The Old Globe', start: '2026-07-23', end: '2026-08-30', aliases: [] };
const WIN = { from: '2026-07-13', to: '2026-09-20' };
const page = (title, body, author = 'Jane Critic', date = '2026-07-30') => `<html><head><title>${title}</title><meta property="article:published_time" content="${date}T10:00:00Z"><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', headline: title, datePublished: date, author: { '@type': 'Person', name: author } })}</script></head><body><article><p>${body}</p></article></body></html>`;

test('verifyArticle accepts a review of the right production and takes the byline from the article', () => {
  const v = F.verifyArticle(page('Cyrano review: a bold turn at the Old Globe', 'The Old Globe stages Cyrano with a fresh eye.'), 'https://x.com/cyrano-review', PROD, WIN);
  assert.equal(v.ok, true);
  assert.equal(v.critic, 'Jane Critic');
  assert.equal(v.date, '2026-07-30');
});

test('verifyArticle rejects another theatre staging the same title', () => {
  const v = F.verifyArticle(page('Cyrano at Cygnet', 'Cygnet Theatre presents Cyrano in Old Town.'), 'https://x.com/cyrano', PROD, WIN);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'theatre-not-found');
});

test('verifyArticle rejects a review published outside the production window', () => {
  const v = F.verifyArticle(page('Cyrano at the Old Globe', 'The Old Globe revives Cyrano.', 'A B', '2026-01-02'), 'https://x.com/old', PROD, WIN);
  assert.equal(v.ok, false);
  assert.match(v.reason, /date-outside-window/);
});

test('verifyArticle: a page that merely names both productions is still a review of each (two-in-one is not a roundup)', () => {
  const prod2 = { ...PROD, title: 'Much Ado About Nothing' };
  const html = page('Shakespeare season at the Old Globe: Much Ado and Cyrano', 'At the Old Globe, Cyrano and Much Ado About Nothing both open. Review of both.');
  assert.equal(F.verifyArticle(html, 'https://x.com/a', PROD, WIN).ok, true);
  assert.equal(F.verifyArticle(html, 'https://x.com/a', prod2, WIN).ok, true);
});

test('extractByline prefers JSON-LD, ignores site-wide staff bylines, falls back to a By line', () => {
  assert.equal(F.extractByline(page('t', 'b', 'Pat Smith')), 'Pat Smith');
  assert.equal(F.extractByline(page('t', 'b', 'Staff')), null);
  assert.equal(F.extractByline('<html><body><p>By Alex Rivera</p><p>text</p></body></html>'), 'Alex Rivera');
});

test('windowFor runs from 10 days before opening to 21 days after closing, capped at today', () => {
  assert.deepEqual(F.windowFor({ start: '2026-07-23', end: '2026-08-30' }, '2026-11-02'), { from: '2026-07-13', to: '2026-09-20' });
  assert.deepEqual(F.windowFor({ start: '2026-10-20', end: '2026-11-30' }, '2026-11-02'), { from: '2026-10-10', to: '2026-11-02' });
});

test('findReviews merges adapters, verifies each candidate and reports rejects', async () => {
  const wp = [{ link: 'https://s.com/cyrano-globe', title: { rendered: 'Cyrano at the Old Globe' }, date: '2026-07-30T00:00:00', excerpt: { rendered: '' } },
    { link: 'https://s.com/cyrano-cygnet', title: { rendered: 'Cyrano at Cygnet' }, date: '2026-08-02T00:00:00', excerpt: { rendered: '' } },
    { link: 'https://s.com/interview-cyrano', title: { rendered: 'Interview: the Cyrano cast' }, date: '2026-07-20T00:00:00', excerpt: { rendered: '' } }];
  const pages = {
    'https://s.com/cyrano-globe': page('Cyrano at the Old Globe', 'The Old Globe: Cyrano review.', 'Ann Lee'),
    'https://s.com/cyrano-cygnet': page('Cyrano at Cygnet', 'Cygnet Theatre does Cyrano.', 'Bo Kay'),
  };
  const fetch = async (u) => (u.includes('wp-json') ? { content: JSON.stringify(wp) } : pages[u] ? { content: pages[u] } : null);
  const ctx = F.makeContext({ fetch, today: '2026-11-02' });
  const res = await F.findReviews(PROD, { outlets: [{ id: 'sdstory', name: 'San Diego Story', kind: 'wp', base: 'https://s.com' }] }, ctx);
  assert.equal(res.reviews.length, 1);
  assert.equal(res.reviews[0].url, 'https://s.com/cyrano-globe');
  assert.equal(res.reviews[0].critic, 'Ann Lee');
  assert.equal(res.rejected.length, 1);
  assert.equal(res.rejected[0].reason, 'theatre-not-found');
});

test('verifyArticle rejects an undated page whose slug carries an out-of-window year', () => {
  const html = '<html><head><title>Cyrano at Old Globe</title></head><body><article><p>Old Globe Cyrano review.</p></article></body></html>';
  const v = F.verifyArticle(html, 'https://x.com/cyrano-at-old-globe6252022', PROD, WIN);
  assert.equal(v.ok, false);
  assert.match(v.reason, /url-year-outside-window/);
});

test('verifyArticle rejects press-release posts and place-only theatre aliases', () => {
  const rep = { title: 'Hamlet', theatre: 'San Diego Repertory Theatre', start: '2026-07-23', end: '2026-08-30', aliases: [] };
  assert.ok(!F.theatreAliases('San Diego Repertory Theatre').includes('san diego'));
  const v = F.verifyArticle(page('Cygnet Theatre Presents Hamlet', 'Hamlet comes to San Diego Repertory Theatre this season.'), 'https://x.com/presents-hamlet', rep, WIN);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'not-a-review');
});
