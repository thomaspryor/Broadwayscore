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

// BRO-5455: these open regional shows had no ticket links even though their
// first-party production pages offered booking. The fallback writer must be
// able to select the venue result instead of rejecting its unlisted domain.
const regionalBookingResults = [
  ['The Snow Goose', 'Goodspeed Opera House, East Haddam, CT', 'https://www.goodspeed.org/shows/the-snow-goose?nextdates=2'],
  ['Begin Again', 'The Old Globe (Donald and Darlene Shiley Stage), San Diego, CA', 'https://www.theoldglobe.org/pdp/26-season/begin-again'],
  ['The Front Page', 'Northlight Theatre, Evanston, IL', 'https://northlight.org/series/the-front-page/'],
  ['Topdog/Underdog', 'Steppenwolf Theatre Company, Chicago, IL', 'https://www.steppenwolf.org/whats-on/2026-2027/topdog-underdog'],
  ['As You Like It', 'Royal Shakespeare Theatre, Stratford-upon-Avon', 'https://www.rsc.org.uk/as-you-like-it'],
  ['The Prime of Miss Jean Brodie', 'Royal Lyceum Theatre, Edinburgh', 'https://lyceum.org.uk/events/the-prime-of-miss-jean-brodie'],
  ['King Lear', 'Royal Exchange Theatre, Manchester', 'https://www.royalexchange.co.uk/event/king-lear/'],
  ['Antigone Exits', 'Chichester Festival Theatre, Chichester', 'https://www.cft.org.uk/events/antigone-exits'],
  ['As You Like It', 'Pitlochry Festival Theatre, Pitlochry', 'https://www.pitlochryfestivaltheatre.com/whats-on/as-you-like-it'],
  ['Hamlet', 'Theatre Royal Bath, Bath', 'https://theatreroyal.org.uk/whats-on/hamlet'],
  ['Oh What A Night', 'Òran Mór, Glasgow', 'https://www.oran-mor.co.uk/events/oh-what-a-night'],
  ['Medea', 'Citizens Theatre, Glasgow', 'https://www.citz.co.uk/whats-on/medea'],
  ['King Lear', 'Crucible Theatre, Sheffield', 'https://www.sheffieldtheatres.co.uk/whats-on/king-lear'],
  ['Our Town', 'Writers Theatre, Glencoe, IL', 'https://www.writerstheatre.org/production/our-town/'],
  ['The Mousetrap', 'Theater Wit, Chicago, IL', 'https://www.theaterwit.org/shows/the-mousetrap'],
  ['Hedda Gabler', 'Studio Theatre, Washington, DC', 'https://www.studiotheatre.org/shows/hedda-gabler'],
];

for (const [title, venue, url] of regionalBookingResults) {
  test(`pickTicketUrl accepts the first-party regional booking page for ${title}`, () => {
    const show = { title, venue, category: 'regional', market: 'regional' };
    assert.deepEqual(pickTicketUrl([{ title, url }], show), { url, platform: 'Venue Box Office' });
    assert.equal(pickTicketUrl([{ title: 'Unrelated Production Tickets', url }], show), null);
    assert.equal(pickTicketUrl([{ title, url }], { ...show, venue: 'Another Theatre' }), null);
    assert.equal(pickTicketUrl([{ title, url }], { ...show, venue: undefined }), null);
    const spoof = new URL(url);
    spoof.hostname += '.example.com';
    assert.equal(pickTicketUrl([{ title, url: spoof.href }], show), null);
  });
}

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
test('showRegion reads market first, category as fallback, and stays null when not confidently known', () => {
  assert.equal(showRegion({ market: 'west-end' }), 'uk');
  assert.equal(showRegion({ market: 'off-west-end' }), 'uk');
  assert.equal(showRegion({ category: 'west-end' }), 'uk');
  assert.equal(showRegion({ market: 'broadway' }), 'us');
  assert.equal(showRegion({ category: 'off-broadway' }), 'us');
  // `regional` spans US houses (Arena Stage) AND any future UK regional, so it
  // must NOT default to 'us' — that would reject a legitimate .co.uk link.
  assert.equal(showRegion({ market: 'regional', category: 'regional' }), null);
  assert.equal(showRegion({ market: 'some-market-we-have-not-learned-yet' }), null);
  assert.equal(showRegion({}), null);
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
  // TodayTix is one domain per market, partitioned by path — same failure
  // shape as Ticketmaster, just hidden behind a multi-market host.
  assert.equal(isRegionMismatch('https://www.todaytix.com/london/shows/1-x', weShow), false);
  assert.equal(isRegionMismatch('https://www.todaytix.com/nyc/shows/1-x', bwShow), false);
  assert.equal(isRegionMismatch('https://www.todaytix.com/nyc/shows/1-x', weShow), true);
  assert.equal(isRegionMismatch('https://www.todaytix.com/london/shows/1-x', bwShow), true);
  // Unrecognised city segment → unknown, not a guess.
  assert.equal(isRegionMismatch('https://www.todaytix.com/tokyo/shows/1-x', weShow), false);
  // Genuinely global hosts carry no region and must never be rejected.
  assert.equal(isRegionMismatch('https://www.eventbrite.com/e/1', weShow), false);
  assert.equal(isRegionMismatch('not a url', weShow), false);
  // Unknown-region show → no constraint in either direction.
  const regional = { market: 'regional', category: 'regional' };
  assert.equal(isRegionMismatch(usTm, regional), false);
  assert.equal(isRegionMismatch(ukTm, regional), false);
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

test('market wins over a conflicting category (the "market first" contract, not just documented)', () => {
  // Corrupt/disagreeing pair: market says Broadway, category says West End.
  // The stronger field must decide, or a data-entry slip silently flips the
  // region and starts rejecting correct links.
  assert.equal(showRegion({ market: 'broadway', category: 'west-end' }), 'us');
  assert.equal(showRegion({ market: 'west-end', category: 'broadway' }), 'uk');
});

test('BRO-5455: regional venue hosts do not attach to look-alike NYC venues', () => {
  const url = 'https://www.studiotheatre.org/shows/hedda-gabler';
  for (const venue of ['Ensemble Studio Theatre', 'Irish Repertory Studio Theatre']) {
    assert.equal(pickTicketUrl([{ title: 'Hedda Gabler', url }], { title: 'Hedda Gabler', venue, market: 'broadway' }), null);
  }
});

// BRO-7368: SERP-independent venue-host lookup. URL shapes below are real
// sitemap / listing entries read from each venue site on 2026-11-19.
const {
  venueHostForShow,
  pickChildSitemaps,
  extractSameHostLinks,
  pickVenuePageUrl,
} = require('./ticket-link-discovery.js');

const leedsFences = {
  id: 'fences-leeds-regional-2026', title: 'Fences', venue: 'Leeds Playhouse, Leeds',
  category: 'regional', market: 'regional', openingDate: '2026-09-17',
  synopsis: "August Wilson's Pulitzer Prize-winning drama, part of his Pittsburgh Cycle.",
};
const ravenLoop = {
  id: 'a-strange-loop-regional-2026', title: 'A Strange Loop', venue: 'Raven Theatre, Chicago, IL',
  category: 'regional', market: 'regional', openingDate: '2026-10-15', synopsis: 'Usher writes a musical.',
};
const writersRoyale = {
  id: 'the-royale-regional-2026', title: 'The Royale', venue: 'Writers Theatre, Glencoe, IL',
  category: 'regional', market: 'regional', openingDate: '2026-10-30', synopsis: 'A boxer in 1905.',
};
const oranContact = {
  id: 'contact-oran-mor-regional-2026', title: 'Contact', venue: 'Òran Mór, Glasgow',
  category: 'regional', market: 'regional', openingDate: '2026-10-07', synopsis: 'A lunchtime play.',
};

test('venueHostForShow maps a show to its allowlisted venue host (diacritics folded)', () => {
  assert.equal(venueHostForShow(leedsFences), 'leedsplayhouse.org.uk');
  assert.equal(venueHostForShow(oranContact), 'oran-mor.co.uk');
  assert.equal(venueHostForShow({ venue: 'The Matrix, Los Angeles, CA' }), null);
  assert.equal(venueHostForShow({}), null);
});

test('pickChildSitemaps keeps show shards first and drops editorial ones', () => {
  const picked = pickChildSitemaps([
    'https://www.leedsplayhouse.org.uk/post-sitemap.xml',
    'https://www.leedsplayhouse.org.uk/page-sitemap.xml',
    'https://www.leedsplayhouse.org.uk/event-sitemap.xml',
    'https://www.leedsplayhouse.org.uk/people-sitemap.xml',
    'https://www.leedsplayhouse.org.uk/job-sitemap.xml',
    'https://bristololdvic.org.uk/sitemaps-1-section-whatsOn-1-sitemap.xml',
  ]);
  assert.deepEqual(picked, [
    'https://www.leedsplayhouse.org.uk/event-sitemap.xml',
    'https://bristololdvic.org.uk/sitemaps-1-section-whatsOn-1-sitemap.xml',
    'https://www.leedsplayhouse.org.uk/page-sitemap.xml',
  ]);
  assert.equal(pickChildSitemaps(Array.from({ length: 9 }, (_, i) => `https://x.org/event-${i}.xml`)).length, 4);
});

test('extractSameHostLinks resolves relative links and drops other hosts, queries, fragments', () => {
  const html = '<a href="/events/the-royale">x</a><a href="https://secure.rsc.org.uk/events/a?d=1">y</a>'
    + '<a href="https://www.writerstheatre.org/events/the-royale?utm=1#top">z</a><a href="mailto:a@b.c">m</a>';
  assert.deepEqual(extractSameHostLinks(html, 'https://www.writerstheatre.org/'), [
    'https://www.writerstheatre.org/events/the-royale',
  ]);
});

test('pickVenuePageUrl: playwright-prefixed slug passes when the synopsis names the prefix', () => {
  const pick = pickVenuePageUrl([
    'https://www.leedsplayhouse.org.uk/event/hamlet/',
    'https://www.leedsplayhouse.org.uk/event/august-wilsons-fences/',
  ], leedsFences);
  assert.deepEqual(pick, { url: 'https://www.leedsplayhouse.org.uk/event/august-wilsons-fences/', platform: 'Venue Box Office' });
});

test('pickVenuePageUrl: run-together slug matches, side pages do not', () => {
  const urls = [
    'https://www.raventheatre.com/a-strange-loop-content-warnings/',
    'https://www.raventheatre.com/astrangeloopevents/',
    'https://www.raventheatre.com/stage/astrangeloop/',
  ];
  assert.equal(pickVenuePageUrl(urls, ravenLoop).url, 'https://www.raventheatre.com/stage/astrangeloop/');
  assert.equal(pickVenuePageUrl(urls.slice(0, 2), ravenLoop), null);
});

test('pickVenuePageUrl: main event page beats access/childcare sub-pages; sub-pages alone never match', () => {
  const subPages = [
    'https://www.writerstheatre.org/events/the-royale-childcare-matinee',
    'https://www.writerstheatre.org/events/the-royale-access-performances',
    'https://www.writerstheatre.org/events/the-final-word-the-royale',
  ];
  assert.equal(pickVenuePageUrl(subPages, writersRoyale), null);
  assert.equal(
    pickVenuePageUrl([...subPages, 'https://www.writerstheatre.org/events/the-royale'], writersRoyale).url,
    'https://www.writerstheatre.org/events/the-royale',
  );
});

test('pickVenuePageUrl: one-word title needs a production section ("/contact" is not "Contact")', () => {
  assert.equal(pickVenuePageUrl(['https://www.oran-mor.co.uk/contact/'], oranContact), null);
  assert.equal(pickVenuePageUrl(['https://www.oran-mor.co.uk/contact-us'], oranContact), null);
  assert.equal(
    pickVenuePageUrl(['https://www.oran-mor.co.uk/whats-on/contact/'], oranContact).url,
    'https://www.oran-mor.co.uk/whats-on/contact/',
  );
});

test('pickVenuePageUrl: rejects another host, editorial paths, an old-year production, and a CMS hash is tolerated', () => {
  const iron = { id: 'iron-home-regional-2026', title: 'Iron', venue: 'HOME, Manchester', openingDate: '2026-09-17', category: 'regional' };
  assert.equal(pickVenuePageUrl(['https://www.leedsplayhouse.org.uk/event/iron/'], iron), null, 'not the venue host');
  assert.equal(pickVenuePageUrl(['https://www.homemcr.org/news/whats-on/iron'], iron), null, 'editorial path');
  assert.equal(pickVenuePageUrl(['https://www.homemcr.org/whats-on/iron-2019'], iron), null, 'old production');
  assert.equal(pickVenuePageUrl(['https://www.homemcr.org/whats-on/iron-maiden-tribute'], iron), null, 'different show');
  assert.equal(pickVenuePageUrl(['https://www.homemcr.org/whats-on/iron-x7k2'], iron).url, 'https://www.homemcr.org/whats-on/iron-x7k2');
  assert.equal(pickVenuePageUrl(['http://www.homemcr.org/whats-on/iron?x=1'], iron).url, 'https://www.homemcr.org/whats-on/iron');
});

test('pickChildSitemaps skips whole editorial words only (stage/posttype-page survive)', () => {
  assert.deepEqual(pickChildSitemaps([
    'https://citz.co.uk/sitemap-posttype-post.2026.xml',
    'https://citz.co.uk/sitemap-posttype-page.xml',
    'https://citz.co.uk/sitemap-author.xml',
    'https://x.org/stage-sitemap.xml',
    'https://bristololdvic.org.uk/sitemaps-1-section-pastProductions-1-sitemap.xml',
    'https://bristololdvic.org.uk/sitemaps-1-section-workshopsEvents-1-sitemap.xml',
  ]), ['https://x.org/stage-sitemap.xml', 'https://citz.co.uk/sitemap-posttype-page.xml']);
});

// BRO-7368 review: archived productions and numbered sequels/parts.
test('pickVenuePageUrl: an older year in ANY path segment rejects (archived production)', () => {
  const hamlet = { id: 'hamlet-rsc-regional-2026', title: 'Hamlet', venue: 'Royal Shakespeare Theatre, Stratford-upon-Avon', openingDate: '2026-10-01', category: 'regional' };
  assert.equal(pickVenuePageUrl(['https://www.rsc.org.uk/whats-on/2019/hamlet'], hamlet), null);
  const grinch = { id: 'grinch-old-globe-regional-2026', title: 'How the Grinch Stole Christmas', venue: 'The Old Globe, San Diego, CA', openingDate: '2026-11-15', category: 'regional' };
  assert.equal(pickVenuePageUrl(['https://www.theoldglobe.org/tickets-and-events/2016-season/how-the-grinch-stole-christmas/'], grinch), null);
  // The current season still matches.
  assert.equal(
    pickVenuePageUrl(['https://www.theoldglobe.org/tickets-and-events/2026-season/how-the-grinch-stole-christmas/'], grinch).url,
    'https://www.theoldglobe.org/tickets-and-events/2026-season/how-the-grinch-stole-christmas/',
  );
});

test('pickVenuePageUrl: bare numbers are content (hamlet-2 is not Hamlet; Part 1 is not Part 2)', () => {
  const hamlet = { id: 'hamlet-rsc-regional-2026', title: 'Hamlet', venue: 'Royal Shakespeare Theatre, Stratford-upon-Avon', openingDate: '2026-10-01', category: 'regional', synopsis: 'Act 2 of 5.' };
  assert.equal(pickVenuePageUrl(['https://www.rsc.org.uk/shows/hamlet-2'], hamlet), null);
  assert.equal(pickVenuePageUrl(['https://www.rsc.org.uk/shows/hamlet-2', 'https://www.rsc.org.uk/shows/hamlet'], hamlet).url,
    'https://www.rsc.org.uk/shows/hamlet');
  const part1 = { id: 'henry-iv-part-1-rsc-regional-2026', title: 'Henry IV, Part 1', venue: 'Royal Shakespeare Theatre, Stratford-upon-Avon', openingDate: '2026-10-01', category: 'regional' };
  const urls = ['https://www.rsc.org.uk/whats-on/henry-iv-part-2', 'https://www.rsc.org.uk/whats-on/henry-iv-part-1'];
  assert.equal(pickVenuePageUrl(urls, part1).url, 'https://www.rsc.org.uk/whats-on/henry-iv-part-1');
  assert.equal(pickVenuePageUrl(urls.slice(0, 1), part1), null);
});

test('pickVenuePageUrl: archive and past-production sections are never a current show page (BRO-7368)', () => {
  for (const u of [
    'https://www.leedsplayhouse.org.uk/archive/august-wilsons-fences/',
    'https://www.leedsplayhouse.org.uk/whats-on/past-shows/august-wilsons-fences/',
    'https://www.leedsplayhouse.org.uk/past-productions/august-wilsons-fences/',
  ]) assert.equal(pickVenuePageUrl([u], leedsFences), null, u);
});

test('pickVenuePageUrl: only the venue host itself or www., never a subdomain', () => {
  const pick = pickVenuePageUrl(['https://shop.leedsplayhouse.org.uk/event/fences/'], { ...leedsFences, synopsis: '' });
  assert.equal(pick, null);
  assert.equal(pickVenuePageUrl(['https://leedsplayhouse.org.uk/event/fences/'], leedsFences).url, 'https://leedsplayhouse.org.uk/event/fences/');
});
