import { createRequire } from 'module';
import assert from 'assert';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { parseOltShowPage, oltDate, oltItemId, cleanOltTitle } = require('./olt-archive-parse.js');
const { buildOltCandidates, azMatchesListing, trPageMatchesListing, genreSlugs } = require('./we-olt-candidates.js');

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

console.log('we-olt-season ok');
