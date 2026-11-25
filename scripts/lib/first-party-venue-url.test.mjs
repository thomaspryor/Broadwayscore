// BRO-7668: local-hub regional shows stayed at missing_tickets because no
// enricher recognised the theatre's own site. These pin which URLs count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isFirstPartyVenueUrl, pickFirstPartyVenueUrl, siteLabel } = require('./first-party-venue-url.js');

test('theatre sites spelled from the venue name are first-party', () => {
  const ok = [
    ['https://northcoastrep.org/production/the-cottage/', 'North Coast Repertory Theatre, Solana Beach, CA'],
    ['https://www.lyricstage.com/production/peter-pan-goes-wrong/', 'Lyric Stage Company of Boston, Boston, MA'],
    ['http://www.citylit.org', 'City Lit Theater, Chicago, IL'],
    ['https://newvillagearts.org/as-you-like-it/', 'New Village Arts, Carlsbad, CA'],
    ['https://www.diversionary.org/arrowhead', 'Diversionary Theatre, San Diego, CA'],
    ['https://tickets.arenastage.org/x', 'Arena Stage, Washington, DC'],
    ['https://www.pasadenaplayhouse.org', 'Pasadena Playhouse, Pasadena, CA'],
    ['https://www.royalexchange.co.uk/whats-on/x', 'Royal Exchange Theatre, Manchester'],
    // full name with its theatre word is fine on .com; a distinctive-only bare label needs .org
    ['https://www.hampsteadtheatre.com/whats-on/x', 'Hampstead Theatre, London'],
    ['https://www.moxietheatre.com/x', 'Moxie Theatre, San Diego, CA'],
    ['https://www.kansascityrep.org/x', 'Kansas City Repertory Theatre, Kansas City, MO'],
  ];
  for (const [url, venue] of ok) assert.equal(isFirstPartyVenueUrl(url, venue), true, `${url} <= ${venue}`);
});

test('press, critics and city-named sites are never first-party', () => {
  const bad = [
    ['https://www.bostonglobe.com/arts/review', 'Lyric Stage Company of Boston, Boston, MA'],
    ['https://www.sandiegouniontribune.com/review', 'San Diego Repertory Theatre, San Diego, CA'],
    ['https://www.pasadenanow.com/x', 'Pasadena Playhouse, Pasadena, CA'],
    ['https://www.broadwayworld.com/san-diego/regional/x', 'Diversionary Theatre, San Diego, CA'],
    ['https://www.theatreinchicago.com/x/1/', 'Theatre In Chicago'],
    ['https://www.theatre.com/', 'The Theatre, Chicago, IL'], // no distinctive word
    ['ftp://citylit.org', 'City Lit Theater, Chicago, IL'],
    // post-landing review: a leading city word is a newspaper's domain, a squatter TLD is not a theatre's
    ['https://www.kansascity.com/arts/review', 'Kansas City Repertory Theatre, Kansas City, MO'],
    ['https://www.cleveland.com/entertainment/x', 'Cleveland Play House, Cleveland, OH'],
    ['https://www.boston.com/x', 'Boston Court Pasadena, Pasadena, CA'],
    ['https://www.chicago.com/x', 'Chicago Shakespeare Theater, Chicago, IL'],
    ['https://arena.com/x', 'Arena Stage, Washington, DC'],
    ['https://citylit.xyz/x', 'City Lit Theater, Chicago, IL'],
    ['https://www.chicagoarts.org/x', 'Chicago Shakespeare Theater, Chicago, IL'],
    ['https://www.kansasco.com/x', 'Kansas City Repertory Theatre, Kansas City, MO'],
    [null, 'City Lit Theater'],
  ];
  for (const [url, venue] of bad) assert.equal(isFirstPartyVenueUrl(url, venue), false, `${url} <= ${venue}`);
});

test('pickFirstPartyVenueUrl prefers the production page over a homepage', () => {
  const show = {
    venue: 'Huntington Theatre Company, Boston, MA',
    evidenceUrls: ['https://www.wbur.org/review', 'https://www.huntingtontheatre.org/'],
  };
  assert.equal(pickFirstPartyVenueUrl(show), 'https://www.huntingtontheatre.org/');
  assert.equal(pickFirstPartyVenueUrl(show, ['https://www.huntingtontheatre.org/whats-on/x/']), 'https://www.huntingtontheatre.org/whats-on/x/');
  assert.equal(pickFirstPartyVenueUrl({ venue: 'Huntington Theatre Company', evidenceUrls: ['https://www.wbur.org/x'] }), null);
  assert.equal(siteLabel('https://www.my-theatre.co.uk/x'), 'mytheatre');
});
