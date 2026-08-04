import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  pickTicketUrl,
  platformForUrl,
  titleMatches,
  buildTicketQuery,
  foldTitle,
  isRegionMismatch,
  showRegion,
} = require('./ticket-link-discovery.js');

test('foldTitle strips diacritics and punctuation (Les Misérables lesson)', () => {
  assert.equal(foldTitle('Les Misérables: The Arena Concert!'), 'les miserables the arena concert');
  assert.equal(foldTitle("Schmigadoon!"), 'schmigadoon');
});

test('platformForUrl maps allowlisted platforms and venue sites', () => {
  assert.equal(platformForUrl('https://www.todaytix.com/nyc/shows/1-foo'), 'TodayTix');
  assert.equal(platformForUrl('https://www.ticketmaster.com/event/abc'), 'Ticketmaster');
  assert.equal(platformForUrl('https://ci.ovationtix.com/34567/production/1'), 'OvationTix');
  assert.equal(platformForUrl('https://www.bam.org/theater/2026/la-distance'), 'Venue Box Office');
});

test('platformForUrl rejects resale marketplaces and unknown domains', () => {
  assert.equal(platformForUrl('https://www.stubhub.com/foo-tickets'), null);
  assert.equal(platformForUrl('https://www.seatgeek.com/foo'), null);
  assert.equal(platformForUrl('https://random-blog.com/tickets'), null);
});

test('titleMatches rejects stopword-only matches (The Guilty vs Book of Mormon)', () => {
  assert.ok(!titleMatches('The Book of Mormon Tickets | Broadway', 'The Guilty'));
  assert.ok(titleMatches('The Guilty | Donmar Warehouse', 'The Guilty', 'Donmar Warehouse'));
});

test('titleMatches rejects one-word-title collisions with unexplained content words', () => {
  assert.ok(!titleMatches('Mercury: A Freddie Mercury Tribute | TodayTix', 'Mercury'));
  assert.ok(titleMatches('Mercury Off-Broadway Tickets | TodayTix', 'Mercury'));
  assert.ok(titleMatches('Dukes at Soho Playhouse — tickets', 'Dukes', 'Soho Playhouse'));
});

test('titleMatches requires ALL significant words for short titles', () => {
  assert.ok(!titleMatches('Milk Bar NYC Tickets', 'Milk and Honey (AMT Theater)'));
  assert.ok(!titleMatches('Guilty Pleasures Cabaret Tickets', 'The Guilty'));
});

test('titleMatches folds diacritics and ignores venue parentheticals', () => {
  assert.ok(titleMatches('Les Miserables Arena Concert Tickets | Ticketmaster', 'Les Misérables: The Arena Concert Spectacular'));
  assert.ok(titleMatches('Milk and Honey Off-Broadway Tickets', 'Milk and Honey (AMT Theater)'));
  assert.ok(!titleMatches('Hamilton Tickets | TodayTix', 'Milk and Honey (AMT Theater)'));
});

test('pickTicketUrl returns first allowlisted, title-matched, non-listing result', () => {
  const show = { title: 'Day of the Hog', category: 'off-broadway' };
  const results = [
    { url: 'https://www.stubhub.com/day-of-the-hog-tickets', title: 'Day of the Hog Tickets' },
    { url: 'https://www.todaytix.com/nyc/search?q=hog', title: 'Day of the Hog — search' },
    { url: 'https://www.todaytix.com/nyc/shows/999-day-of-the-hog', title: 'Day of the Hog | TodayTix' },
  ];
  const pick = pickTicketUrl(results, show);
  assert.deepEqual(pick, {
    url: 'https://www.todaytix.com/nyc/shows/999-day-of-the-hog',
    platform: 'TodayTix',
  });
});

test('pickTicketUrl returns null when nothing qualifies', () => {
  const show = { title: 'PHYL', category: 'off-broadway' };
  assert.equal(pickTicketUrl([{ url: 'https://vividseats.com/phyl', title: 'PHYL' }], show), null);
  assert.equal(pickTicketUrl([], show), null);
  assert.equal(pickTicketUrl(null, show), null);
});

test('buildTicketQuery uses real venues but not neighborhood placeholders', () => {
  assert.equal(
    buildTicketQuery({ title: 'Dukes', venue: 'Soho Playhouse', category: 'off-broadway' }),
    '"Dukes" Soho Playhouse tickets'
  );
  assert.equal(
    buildTicketQuery({ title: 'PHYL', venue: 'Midtown W', category: 'off-broadway' }),
    '"PHYL" off broadway new york tickets'
  );
  assert.equal(
    buildTicketQuery({ title: 'The Smile Of Her', venue: 'Marylebone Theatre', category: 'off-west-end' }),
    '"The Smile Of Her" Marylebone Theatre tickets'
  );
  assert.equal(
    buildTicketQuery({ title: 'Milk and Honey (AMT Theater)', venue: 'Midtown W', category: 'off-broadway' }),
    '"Milk and Honey" off broadway new york tickets'
  );
});

// Task #1002 — the live regression: a West End show (Old Vic) carried the US
// ticketmaster.com "A Christmas Carol (NY)" artist page. Title-matching alone
// accepts it; only the storefront's region tells the two productions apart.
test('showRegion reads market first, category as fallback', () => {
  assert.equal(showRegion({ market: 'west-end' }), 'uk');
  assert.equal(showRegion({ market: 'off-west-end' }), 'uk');
  assert.equal(showRegion({ category: 'west-end' }), 'uk');
  assert.equal(showRegion({ market: 'broadway' }), 'us');
  assert.equal(showRegion({ category: 'off-broadway' }), 'us');
  assert.equal(showRegion({}), 'us');
});

test('isRegionMismatch rejects cross-Atlantic storefronts, allows same-market and global hosts', () => {
  const weShow = { market: 'west-end', category: 'west-end' };
  const bwShow = { market: 'broadway', category: 'broadway' };
  const usTm = 'https://www.ticketmaster.com/a-christmas-carol-ny-tickets/artist/2923062';
  const ukTm = 'https://www.ticketmaster.co.uk/a-christmas-carol-tickets/artist/890378';

  assert.equal(isRegionMismatch(usTm, weShow), true);
  assert.equal(isRegionMismatch(ukTm, bwShow), true);
  assert.equal(isRegionMismatch(ukTm, weShow), false);
  assert.equal(isRegionMismatch(usTm, bwShow), false);
  assert.equal(isRegionMismatch('https://www.telecharge.com/x', weShow), true);
  // Global / multi-market hosts carry no region and must never be rejected.
  assert.equal(isRegionMismatch('https://www.todaytix.com/london/shows/1-x', weShow), false);
  assert.equal(isRegionMismatch('https://www.todaytix.com/nyc/shows/1-x', bwShow), false);
  assert.equal(isRegionMismatch('https://www.eventbrite.com/e/1', weShow), false);
  assert.equal(isRegionMismatch('not a url', weShow), false);
});

test('pickTicketUrl skips a wrong-region result and takes the right-region one', () => {
  const show = { title: 'A Christmas Carol', venue: 'Old Vic', market: 'west-end', category: 'west-end' };
  const results = [
    { url: 'https://www.ticketmaster.com/a-christmas-carol-ny-tickets/artist/2923062', title: 'A Christmas Carol Tickets' },
    { url: 'https://www.ticketmaster.co.uk/a-christmas-carol-tickets/artist/890378', title: 'A Christmas Carol Tickets' },
  ];
  assert.deepEqual(pickTicketUrl(results, show), {
    url: 'https://www.ticketmaster.co.uk/a-christmas-carol-tickets/artist/890378',
    platform: 'Ticketmaster',
  });
});

test('pickTicketUrl returns null when the only match is on the wrong storefront', () => {
  const show = { title: 'A Christmas Carol', venue: 'Old Vic', market: 'west-end', category: 'west-end' };
  const results = [
    { url: 'https://www.ticketmaster.com/a-christmas-carol-ny-tickets/artist/2923062', title: 'A Christmas Carol Tickets' },
  ];
  assert.equal(pickTicketUrl(results, show), null);
});
