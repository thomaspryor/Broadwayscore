import { createRequire } from 'module';
import assert from 'assert';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { parseOltShowPage, oltDate, oltItemId, cleanOltTitle } = require('./olt-archive-parse.js');
const { buildOltCandidates, azMatchesListing, trPageMatchesListing, genreSlugs, trStatedClosing } = require('./we-olt-candidates.js');

// Real archived OLT page (Wayback 20160109115438, item101870).
const html = fs.readFileSync(new URL('./fixtures/olt-show-piaf-2008.html', import.meta.url), 'utf8');
assert.deepStrictEqual(parseOltShowPage(html), {
  title: 'Piaf', venue: 'Vaudeville Theatre', genre: 'Play',
  previewsStartDate: '2008-10-16', openingDate: '2008-10-21', closingDate: '2009-01-24',
});
assert.strictEqual(parseOltShowPage('<html><h1>Search</h1></html>'), null, 'no dated <dl> = not a show page');
assert.strictEqual(parseOltShowPage(null), null);
assert.strictEqual(oltDate('31.02.2016'), null);
assert.strictEqual(cleanOltTitle('Funny Girl Duration 2h30'), 'Funny Girl');
assert.strictEqual(cleanOltTitle('The End Of Longing'), 'The End of Longing');
assert.strictEqual(cleanOltTitle('DiaoChan: The Rise Of The Courtesan'), 'DiaoChan: The Rise of the Courtesan');
assert.strictEqual(cleanOltTitle('What Are They Made Of'), 'What Are They Made Of');
assert.strictEqual(cleanOltTitle('Showstopper! The Improvised Musical'), 'Showstopper! The Improvised Musical');
assert.strictEqual(cleanOltTitle('Harry Potter And The Cursed Child Parts I And II Duration Part One: 2h40 / Part Two: 2h35'), 'Harry Potter and the Cursed Child Parts I and II');
assert.strictEqual(parseOltShowPage('<h1>Funny Girl Duration 2h30</h1><dl><dt>Opening night</dt><dd>20.04.2016</dd></dl>').title, 'Funny Girl');
assert.strictEqual(oltDate('2016-02-01'), null);
assert.strictEqual(oltDate('1.2.2016'), '2016-02-01');
assert.strictEqual(oltItemId('http://www.officiallondontheatre.co.uk:80/london-shows/show/interactive-map/item72986/'), '72986');
assert.strictEqual(oltItemId('http://www.officiallondontheatre.co.uk/london-shows/venue/item1/'), null);
assert.deepStrictEqual(genreSlugs('Opera'), ['opera']);
assert.deepStrictEqual(genreSlugs(null), []);
assert.deepStrictEqual(genreSlugs('Musical Comedy'), ['musical']);
assert.deepStrictEqual(genreSlugs('Play, Comedy'), ['play', 'comedy']);

const page = (o) => ({ item: '1', url: 'http://www.officiallondontheatre.co.uk/london-shows/show/item1/x/', snapshot: '20170101000000',
  title: 'The Entertainer', venue: 'Garrick Theatre', genre: 'Play', previewsStartDate: '2016-08-20', openingDate: '2016-08-30', closingDate: '2016-11-12', ...o });
const az = { title: 'THE ENTERTAINER', venue: 'Garrick', opened: '2016-08-30' };
const today = '2026-10-26';
const run = (pages, extra = {}) => buildOltCandidates({ season: '2015-2016', pages, azTitles: [az], shows: [], today, ...extra });

// Promotable: West End, in season, closed, confirmed close, TR A-Z press night agrees.
let [c] = run([page()]);
assert.strictEqual(c.decision.promotable, true, c.decision.reason);
assert.deepStrictEqual(c.signals, ['tr-az']);
assert.strictEqual(c.origin, 'olt');
assert.ok(c.sourceUrls.olt.startsWith('https://web.archive.org/web/20170101000000/'));

// No second source -> held back.
[c] = run([page()], { azTitles: [] });
assert.strictEqual(c.decision.promotable, false);
assert.match(c.decision.reason, /no review signal/);

// A 2015-layout A-Z row dates a limited run by its season start, not an opened date.
[c] = run([page()], { azTitles: [{ title: 'THE ENTERTAINER', venue: 'Garrick', opened: null, seasonFrom: '2016-08-20', seasonTo: '2016-11-12' }] });
assert.strictEqual(c.decision.promotable, true, c.decision.reason);
assert.strictEqual(c.trAz.seasonFrom, '2016-08-20');
// ...a season starting months away from the OLT run is another production.
assert.strictEqual(azMatchesListing({ title: 'THE ENTERTAINER', venue: 'Garrick', seasonFrom: '2016-03-01' }, page()), false);
// ...a same-title season (no venue in this layout) ending weeks before the OLT close is a fringe run.
assert.strictEqual(azMatchesListing({ title: 'THE ENTERTAINER', venue: null, opened: null, seasonFrom: '2016-08-22', seasonTo: '2016-09-10' }, page()), false);
// ...as is one starting after press night, or one with no end date.
assert.strictEqual(azMatchesListing({ title: 'THE ENTERTAINER', venue: null, opened: null, seasonFrom: '2016-09-05', seasonTo: '2016-11-12' }, page()), false);
assert.strictEqual(azMatchesListing({ title: 'THE ENTERTAINER', venue: null, opened: null, seasonFrom: '2016-08-20' }, page()), false);

// A-Z entry for a different production of the same title (years apart) is not a signal.
assert.strictEqual(azMatchesListing({ ...az, opened: '2007-03-01' }, page()), false);
// ...nor one at another venue.
assert.strictEqual(azMatchesListing({ ...az, venue: 'Old Vic' }, page()), false);

// Theatre Record production page at the same house, volume of the run's year.
const trp = { review: { title: 'THE ENTERTAINER', date: '2016-09-13' }, tr: { title: 'Entertainer (The)', venue: 'Garrick', link: 'https://www.theatrerecord.com/archive/volume/36/page/914' } };
[c] = run([page()], { azTitles: [], trPages: [trp] });
assert.deepStrictEqual(c.signals, ['tr-page']);
assert.strictEqual(c.decision.promotable, true);
assert.ok(c.sourceUrls.theatreRecord.endsWith('/page/914'));
// ...an older volume (an earlier production at the same house) is not.
assert.strictEqual(trPageMatchesListing({ ...trp, tr: { ...trp.tr, link: 'https://www.theatrerecord.com/archive/volume/27/page/10' } }, page()), false);
// ...nor another house.
assert.strictEqual(trPageMatchesListing({ ...trp, tr: { ...trp.tr, venue: 'Royal Court' } }, page()), false);

// Snapshot before the close: the date shown was only scheduled -> held, not persistent.
[c] = run([page({ snapshot: '20161001000000' })]);
assert.strictEqual(c.decision.promotable, false);
assert.strictEqual(c.decision.persistent, false);
assert.match(c.decision.reason, /unconfirmed/);

// Out of season, off-West-End venue and old productions OLT kept online are dropped.
assert.strictEqual(run([page({ openingDate: '2009-10-21', previewsStartDate: '2009-10-16' })]).length, 0);
assert.strictEqual(run([page({ venue: 'Hackney Empire' })]).length, 0);

// Opera genre is screened out by the shared decision.
[c] = run([page({ genre: 'Opera' })]);
assert.match(c.decision.reason, /non-theatre genre/);

// A cached title still carrying the running time matches its A-Z row.
[c] = run([page({ title: 'The Entertainer Duration 2h45' })]);
assert.strictEqual(c.title, 'The Entertainer');
assert.deepStrictEqual(c.signals, ['tr-az']);

// Already in shows.json (same title, venue, start).
[c] = run([page()], { shows: [{ id: 'the-entertainer-west-end-2016', title: 'The Entertainer', venue: 'Garrick Theatre', market: 'west-end', openingDate: '2016-08-30', previewsStartDate: '2016-08-20' }] });
assert.match(c.decision.reason, /already in shows.json/);

// Two OLT items for one production collapse to the newest snapshot.
const both = run([page({ item: '1', snapshot: '20170101000000' }), page({ item: '2', snapshot: '20180101000000' })]);
assert.strictEqual(both.length, 1);
assert.ok(both[0].sourceUrls.olt.includes('20180101000000'));

// Item ids a few days apart for one production collapse; a return season months later does not.
assert.strictEqual(run([page({ item: '1', openingDate: '2016-08-30' }), page({ item: '2', openingDate: '2016-09-02', snapshot: '20180101000000' })]).length, 1);
assert.strictEqual(run([page({ item: '1' }), page({ item: '2', previewsStartDate: '2016-05-01', openingDate: '2016-05-05', closingDate: '2016-06-01' })]).length, 2);

// A return season ~10 months after an existing row is not "already in shows.json" (Cats, Palladium).
const catsShows = [{ id: 'cats-west-end-2014', title: 'Cats', venue: 'London Palladium', market: 'west-end', previewsStartDate: '2014-12-06', openingDate: '2014-12-11' }];
const catsPage = page({ title: 'Cats', venue: 'London Palladium', genre: 'Musical', previewsStartDate: '2015-10-23', openingDate: '2015-10-27', closingDate: '2016-01-02' });
[c] = run([catsPage], { shows: catsShows, azTitles: [{ title: 'CATS', venue: 'London Palladium', opened: '2015-10-27' }] });
assert.strictEqual(c.decision.promotable, true, c.decision.reason);

// A second-house leg opening days after the first closed is a transfer, not a new production.
const savoy = page({ item: '7', title: 'Guys and Dolls', venue: 'Savoy Theatre', genre: 'Musical', previewsStartDate: '2015-12-10', openingDate: '2016-01-06', closingDate: '2016-03-12' });
const phoenix = page({ item: '8', title: 'Guys and Dolls', venue: 'Phoenix Theatre', genre: 'Musical', previewsStartDate: null, openingDate: '2016-03-19', closingDate: '2016-08-21' });
const legs = run([savoy, phoenix], { azTitles: [{ title: 'GUYS AND DOLLS', venue: 'Phoenix', opened: '2016-03-19' }] });
assert.match(legs.find(x => x.venue === 'Phoenix Theatre').decision.reason, /transfer leg of the Savoy Theatre run/);

// Theatre Record stating a different close holds the row; a bare issue range does not count.
assert.strictEqual(trStatedClosing('GROUNDHOG DAY\nPress night 16 Aug 2016\nCloses 17 Sep 2016'), '2016-09-17');
assert.strictEqual(trStatedClosing('NELL GWYNN\n12 - 25 February 2016'), null);
const gd = { review: { title: 'Groundhog Day', date: '2016-08-16' }, tr: { title: 'Groundhog Day', venue: 'Old Vic', link: 'https://www.theatrerecord.com/archive/volume/36/page/871' },
  header: 'GROUNDHOG DAY\nPress night 16 Aug 2016\nCloses 17 Sep 2016' };
const gdPage = page({ title: 'Groundhog Day', venue: 'The Old Vic', genre: 'Musical', previewsStartDate: '2016-07-15', openingDate: '2016-08-16', closingDate: '2016-09-19' });
[c] = run([gdPage], { azTitles: [], trPages: [gd] });
assert.match(c.decision.reason, /closing conflict: OLT 2016-09-19, Theatre Record 2016-09-17/);
[c] = run([{ ...gdPage, closingDate: '2016-09-17' }], { azTitles: [], trPages: [gd] });
assert.strictEqual(c.decision.promotable, true, c.decision.reason);

console.log('we-olt-season ok');
