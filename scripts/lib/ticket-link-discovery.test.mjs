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
