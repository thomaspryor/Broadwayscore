import { createRequire } from 'module';
import assert from 'assert';
const require = createRequire(import.meta.url);
const { azLookups, azVenueName } = require('../lib/we-az-lookups.js');
const { pickTrForReview, buildReviewLedCandidates } = require('../lib/we-review-led-candidates.js');

const az = { titles: [
  { title: 'ALADDIN', venue: 'Prince Edward', opened: '2016-06-15', firstAsAt: '2016-08-27' },
  { title: 'BREAKFAST AT TIFFANY\'S', venue: 'T R Haymarket', opened: '2016-06-30', firstAsAt: '2016-08-27' },
  { title: 'FINBOROUGH PLAY', venue: 'Finborough', opened: '2016-05-10', firstAsAt: '2016-05-24' },
  { title: 'THE FATHER', venue: null, opened: null, firstAsAt: '2015-10-13' },
  { title: 'C$E%&"%C&$D\'&K%&*"', venue: null, opened: null, firstAsAt: '2015-10-13' },
  { title: 'THEATRE RECORD 131', venue: null, opened: null, firstAsAt: '2015-10-13' },
  { title: 'The Father', venue: null, opened: null, firstAsAt: '2015-11-10' },
  { title: 'NO DATE', venue: null, opened: null, firstAsAt: null },
] };

const { lookups, dropped } = azLookups(az, []);
assert.deepStrictEqual(lookups.map(l => l.title), ['ALADDIN', "BREAKFAST AT TIFFANY'S", 'THE FATHER']);
assert.strictEqual(lookups[1].venue, 'Theatre Royal Haymarket');
assert.strictEqual(lookups[2].venue, null);
assert.strictEqual(lookups[2].date, '2015-10-13');
assert(lookups.every(l => l.source === 'tr-az'));
const why = Object.fromEntries(dropped.map(d => [d.title, d.reason]));
assert.match(why.FINBOROUGH_PLAY || why['FINBOROUGH PLAY'], /not a West End venue/);
assert.match(why['THEATRE RECORD 131'], /not a title/);
assert.match(why['NO DATE'], /no A-Z date/);
assert.strictEqual(azVenueName('T R Drury Lane'), 'Theatre Royal Drury Lane');

// existing lookups win over an A-Z duplicate
assert.strictEqual(azLookups(az, [{ title: 'Aladdin' }]).lookups.length, 2);

// a venueless A-Z row matches a London TR result in the date window; a WOS review without a venue still does not
const results = [{ title: 'The Father', venue: 'Theatre Royal Haymarket', link: 'https://www.theatrerecord.com/archive/volume/35/dest/21_the_father' }];
const isLondonVenue = () => true;
assert(pickTrForReview(results, { title: 'THE FATHER', venue: null, date: '2015-10-13', source: 'tr-az' }, { isLondonVenue }));
assert.strictEqual(pickTrForReview(results, { title: 'THE FATHER', venue: null, date: '2015-10-13' }, { isLondonVenue }), null);

// signal label on the candidate
const cands = buildReviewLedCandidates({ season: '2015-2016', shows: [], today: '2026-10-26', lookups: [
  { review: { title: 'ALADDIN', venue: 'Prince Edward', date: '2016-06-15', source: 'tr-az' }, tr: null, header: null, error: null },
  { review: { title: 'THE FATHER', venue: null, date: '2015-10-13', source: 'tr-az' },
    tr: { title: 'The Father', venue: "Wyndham's Theatre, London", link: 'https://www.theatrerecord.com/archive/volume/35/dest/21_the_father' },
    header: 'THE FATHER\nWyndham\'s Theatre\nPreviews 1 October 2015, Opened 13 October 2015, Closes 2 January 2016', error: null },
] });
assert.deepStrictEqual(cands[0].signals, ['tr-az']);
// a venueless A-Z row takes the venue from the TR page and reaches a promotable decision
assert.strictEqual(cands[1].venue, "Wyndham's Theatre");
assert.strictEqual(cands[1].decision.promotable, true, JSON.stringify(cands[1].decision));
console.log('we-az-lookups ok');

{
  const { azTitleGenres } = require('../lib/we-review-led-candidates.js');
  assert.deepStrictEqual(azTitleGenres('SUNSET BOULEVARD – ENO'), ['opera']);
  assert.deepStrictEqual(azTitleGenres('SHOWSTOPPER! THE IMPROVISED MUSICAL'), ['children']);
  assert.deepStrictEqual(azTitleGenres('KINKY BOOTS'), []);
}
