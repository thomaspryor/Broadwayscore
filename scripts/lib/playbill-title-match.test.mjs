/**
 * Tests for scripts/lib/playbill-title-match.js (BRO-2821).
 *
 * Colocated under scripts/lib/, so test.yml globs it and it needs no entry in
 * tests/unit-test-manifest.txt.
 *
 * Every URL in the RECOVERS block is a real entry from data/playbill-urls.json
 * that the old exact-match hard filter in scorePlaybillUrl() rejected. Every URL
 * in the REFUSES block is a pair the corpus measurement identified as the reason
 * token-boundary containment cannot be used: across 2,416 distinct normalized
 * titles there are 392 strict containment pairs, and "& Juliet" is contained in
 * "Romeo and Juliet" — the one relaxation that would recover it is the same one
 * that would let it collide.
 *
 * The negatives are the point of this file. A matcher guarding against wrong-show
 * attribution is only as good as what it REFUSES, and a test file that only
 * asserted the recoveries would pass just as well against a function that
 * returned true unconditionally.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  titleForms,
  venueTokens,
  playbillUrlTitleMatch,
} = require('./playbill-title-match.js');

const P = 'https://playbill.com/production/';
// A stand-in for the caller-supplied corpus venue set. Only the venues these
// cases actually need.
const VENUES = new Set([
  'neil-simon-theatre',
  'lena-horne-theatre',
  'walter-kerr-theatre',
  'lyric-theatre',
  'new-amsterdam-theatre',
  'eugene-oneill-theatre',
  'richard-rodgers-theatre',
  'virginia-theatre',
  'some-theatre',
]);
const OPTS = { knownVenueSlugs: VENUES };

describe('titleForms — derived only from delimiters in the raw title', () => {
  test('a plain title yields no lossy or lossless form', () => {
    const f = titleForms('Hadestown');
    assert.equal(f.exact, 'hadestown');
    assert.deepEqual(f.lossless, []);
    assert.deepEqual(f.lossy, []);
  });

  test('a colon subtitle yields the head as lossy and the whole as lossless', () => {
    const f = titleForms('Doubt: A Parable');
    assert.equal(f.exact, 'doubt-a-parable');
    assert.ok(f.lossy.includes('doubt'), 'head form missing');
    assert.ok(!f.lossy.includes('a-parable'), 'the TAIL must never be a form');
  });

  test('a parenthetical yields a lossless spelled-out form, never a lossy one', () => {
    const f = titleForms('Two Strangers (Carry a Cake Across New York)');
    assert.ok(f.lossless.includes('two-strangers-carry-a-cake-across-new-york'));
    assert.deepEqual(f.lossy, [], 'spelling out a parenthetical removes nothing');
  });

  test('a trailing exclamation is not a series brand', () => {
    // "Oklahoma!" and "Moulin Rouge! The Musical" must not be read as
    // "<brand>! <title>" — that would make "Oklahoma!" match anything and
    // "Moulin Rouge! The Musical" match a production called "The Musical".
    assert.deepEqual(titleForms('Oklahoma!').lossy, []);
    assert.ok(!titleForms('Moulin Rouge! The Musical').lossy.includes('the-musical'));
  });

  test('a leading series brand yields the remainder as lossy', () => {
    assert.ok(titleForms('Encores! La Cage Aux Folles').lossy.includes('la-cage-aux-folles'));
    assert.ok(titleForms('Encores! The Wild Party').lossy.includes('wild-party'));
  });

  test('a bang-first title that is NOT a series brand yields no lossy form', () => {
    // The rule used to be structural — "first word ends in !, drop it" — and
    // against the 2,942-show corpus it fired on 13 titles of which ONE was a
    // series brand. The other 12 kept a generic remainder and threw the show's
    // real name away. "Boop! The Musical" then matched a URL slugged
    // "the-musical" at its own house, because a venue hit in the tail is the
    // only gate on a lossy form.
    for (const [title, wrongForm] of [
      ['Boop! The Musical', 'musical'],
      ['Gutenberg! The Musical!', 'musical'],
      ['COPPERFIELD! THE NEW MUSICAL', 'new'],
      ['Oh! Calcutta!', 'calcutta'],
      ['Children! Children!', 'children'],
      ['Pirates! The Penzance Musical', 'penzance'],
      ['Showstopper! The Improvised Musical', 'improvised'],
    ]) {
      assert.deepEqual(titleForms(title).lossy, [], `${title} must yield no lossy form`);
      const r = playbillUrlTitleMatch(
        `${P}${wrongForm}-broadway-broadhurst-theatre-2026`,
        { id: 'x-2026', title, venue: 'Broadhurst Theatre' }, OPTS);
      assert.equal(r.match, false, `${title} wrongly matched "${wrongForm}" via ${r.branch}`);
    }
  });

  test('"-the-play" is never an accepted form, only "-the-musical" as a legacy prefix', () => {
    const f = titleForms('Giant');
    assert.ok(!f.lossless.includes('giant-the-play'), 'Giant must not become giant-the-play');
    assert.ok(!f.lossy.includes('giant-the-play'));
    assert.ok(f.legacyPrefixes.includes('giant-the-musical'));
  });
});

describe('venueTokens — identity tokens, not canonicalVenue()', () => {
  test('drops venue nouns and short tokens', () => {
    assert.deepEqual(venueTokens('Todd Haimes Theatre'), ['haimes']);
    assert.deepEqual(venueTokens('Music Box Theatre'), ['music']);
    assert.deepEqual(venueTokens('New York City Center'), ['center']);
  });
});

describe('playbillUrlTitleMatch — RECOVERS real cached URLs the exact filter rejected', () => {
  const CASES = [
    ['exact',    'Hadestown',            'Walter Kerr Theatre',   'hadestown-2019',
     `${P}hadestown-broadway-walter-kerr-theatre-2019`],
    ['lossless', 'Two Strangers (Carry a Cake Across New York)', 'Longacre Theatre', 'two-strangers-bway-2025',
     `${P}two-strangers-carry-a-cake-across-new-york-broadway-longacre-theatre-2025`],
    ['lossy',    'Doubt: A Parable',     'Todd Haimes Theatre',   'doubt-2024',
     `${P}doubt-broadway-todd-haimes-theatre-2024`],
    ['lossy',    'Purlie Victorious: A Non-Confederate Romp Through the Cotton Patch',
     'Music Box Theatre', 'purlie-victorious-2023',
     `${P}purlie-victorious-broadway-music-box-theatre-2023`],
    ['lossy',    '& Juliet',             'Stephen Sondheim Theatre', 'and-juliet-2022',
     `${P}juliet-broadway-stephen-sondheim-theatre-2022`],
    ['lossy',    'Encores! La Cage Aux Folles', 'New York City Center',
     'encores-la-cage-aux-folles-off-broadway-2026',
     `${P}la-cage-aux-folles-off-broadway-new-york-city-center-2026`],
    ['legacy',   'MJ The Musical',       'Neil Simon Theatre',    'mj-2022',
     `${P}mj-the-musicalneil-simon-theatre-2021-2022`],
    ['legacy',   'SIX',                  'Lena Horne Theatre',    'six-2021',
     `${P}six-the-musicallena-horne-theatre-2021-2022`],
    ['legacy',   'Hadestown',            'Walter Kerr Theatre',   'hadestown-2019',
     `${P}hadestownwalter-kerr-theatre-2018-2019`],
    ['legacy',   'Harry Potter and the Cursed Child', 'Lyric Theatre', 'harry-potter-2021',
     `${P}harry-potter-and-the-cursed-childlyric-theatre-2017-2018`],
    ['legacy',   'Aladdin',              'New Amsterdam Theatre', 'aladdin-2014',
     `${P}aladdin-new-amsterdam-theatre-vault-0000014037`],
    // Leading "the-" survives in the URL but normalizeTitle strips it from ours.
    ['legacy',   'The Book of Mormon',   'Eugene O’Neill Theatre', 'book-of-mormon-2011',
     `${P}the-book-of-mormon-eugene-oneill-theatre-vault-0000013715`],
    // Transferred show: the vault URL names the ORIGINAL house, our record the
    // current one, and there is no year in the URL. The decomposition alone
    // carries it — which is exactly why the legacy branch does not also demand
    // that the URL agree with today's venue.
    ['legacy',   'Chicago',              'Ambassador Theatre',    'chicago-1996',
     `${P}chicago-richard-rodgers-theatre-vault-0000003074`],
    // Renamed house: "Virginia Theatre" is today's August Wilson.
    ['legacy',   'King Hedley II',       'Virginia Theatre',      'king-hedley-ii-2001',
     `${P}king-hedley-ii-virginia-theatre-vault-0000005232`],
  ];
  for (const [branch, title, venue, id, url] of CASES) {
    test(`${branch}: "${title}" <- ${url.slice(P.length)}`, () => {
      const r = playbillUrlTitleMatch(url, { id, title, venue }, OPTS);
      assert.equal(r.match, true, 'expected a match');
      assert.equal(r.branch, branch, `expected the ${branch} branch to fire`);
    });
  }
});

describe('playbillUrlTitleMatch — REFUSES the containment pairs that rule out token matching', () => {
  const CASES = [
    ['& Juliet',   'Stephen Sondheim Theatre', 'and-juliet-2022',
     `${P}romeo-and-juliet-broadway-stephen-sondheim-theatre-2022`],
    ['SIX',        'Lena Horne Theatre', 'six-2021',
     `${P}six-degrees-of-separation-broadway-lena-horne-theatre-2021`],
    ['Home',       'Some Theatre', 'home-2026', `${P}fun-home-broadway-some-theatre-2026`],
    ['Giant',      'Some Theatre', 'giant-2026', `${P}giant-the-play-broadway-some-theatre-2026`],
    ['Oedipus',    'Some Theatre', 'oedipus-2026', `${P}oedipus-rex-broadway-some-theatre-2026`],
    // The TAIL of our own subtitle is not a title.
    ['Doubt: A Parable', 'Todd Haimes Theatre', 'doubt-2024',
     `${P}a-parable-broadway-todd-haimes-theatre-2024`],
    // The series BRAND alone is not a title either.
    ['Encores! La Cage Aux Folles', 'New York City Center', 'encores-2026',
     `${P}encores-off-broadway-new-york-city-center-2026`],
    // Legacy branch must not let a bare prefix through: "the-play-..." is not a
    // venue, so the body does not decompose.
    ['Giant',      'Some Theatre', 'giant-2026', `${P}giant-the-play-some-theatre-vault-0000012345`],
    ['SIX',        'Lena Horne Theatre', 'six-2021',
     `${P}six-degrees-of-separation-lena-horne-theatre-2017-2018`],
  ];
  for (const [title, venue, id, url] of CASES) {
    test(`refuses "${title}" <- ${url.slice(P.length)}`, () => {
      const r = playbillUrlTitleMatch(url, { id, title, venue }, OPTS);
      assert.equal(r.match, false, `wrongly matched via the ${r.branch} branch`);
    });
  }
});

describe('playbillUrlTitleMatch — the corroboration and enablement gates', () => {
  test('a lossy form is refused when the URL does not name this show\'s venue', () => {
    const url = `${P}doubt-broadway-elsewhere-playhouse-2024`;
    const withVenue = playbillUrlTitleMatch(
      url, { id: 'doubt-2024', title: 'Doubt: A Parable', venue: 'Elsewhere Playhouse' }, OPTS);
    assert.equal(withVenue.match, true, 'sanity: matches when the venue agrees');
    const without = playbillUrlTitleMatch(
      url, { id: 'doubt-2024', title: 'Doubt: A Parable', venue: 'Wildly Different Amphitheatre' }, OPTS);
    assert.equal(without.match, false, 'a shortened title with no venue agreement must be refused');
  });

  test('the same year is NOT enough to carry a lossy form', () => {
    // Year-only corroboration was rejected deliberately: a shortened title can
    // land on a genuinely different production opening the same year, which is
    // common. Sharing a house is not.
    const r = playbillUrlTitleMatch(
      `${P}doubt-broadway-elsewhere-playhouse-2024`,
      { id: 'doubt-2024', title: 'Doubt: A Parable', venue: 'Wildly Different Amphitheatre',
        openingDate: '2024-03-01' },
      OPTS);
    assert.equal(r.match, false);
  });

  test('the legacy branch refuses outright when no venue set is supplied', () => {
    // Absence of a signal must not read as the safe outcome: with no corpus
    // venue set the body cannot be decomposed, so the branch declines rather
    // than falling back to a bare prefix test.
    const url = `${P}aladdin-new-amsterdam-theatre-vault-0000014037`;
    const show = { id: 'aladdin-2014', title: 'Aladdin', venue: 'New Amsterdam Theatre' };
    assert.equal(playbillUrlTitleMatch(url, show, OPTS).match, true, 'sanity: matches with the set');
    assert.equal(playbillUrlTitleMatch(url, show, {}).match, false);
    assert.equal(playbillUrlTitleMatch(url, show, { knownVenueSlugs: new Set() }).match, false);
  });

  test('a lossy form cannot corroborate itself out of its own title text', () => {
    // Found by adversarial review. The corroboration search used to scan the
    // WHOLE url, so a show whose only venue identity token also appears in its
    // own title supplied its own evidence. "Music: A New Story" at the Music
    // Box Theatre has exactly one token, "music", and accepted a page at a
    // different house. The gate read as satisfied while nothing outside the
    // title had agreed to anything — the absence-of-a-signal shape.
    const show = { id: 'music-a-new-story-2026', title: 'Music: A New Story', venue: 'Music Box Theatre' };
    const venues = { knownVenueSlugs: new Set(['music-box-theatre', 'other-venue-theatre']) };
    const wrongHouse = playbillUrlTitleMatch(
      `${P}music-broadway-other-venue-theatre-2026`, show, venues);
    assert.equal(wrongHouse.match, false, 'the title must not supply its own venue evidence');

    const rightHouse = playbillUrlTitleMatch(
      `${P}music-broadway-music-box-theatre-2026`, show, venues);
    assert.equal(rightHouse.match, true, 'a genuine venue agreement must still pass');
    assert.equal(rightHouse.branch, 'lossy');
    assert.ok(!rightHouse.corroboration.searchedTail.startsWith('music-'),
      'corroboration must have been searched in the tail, not the title segment');
  });

  test('a LOSSY form never reaches the legacy branch', () => {
    // Found by review. The legacy branch's justification is that decomposing a
    // body into <title><known venue> is self-corroborating — true for a form
    // carrying the FULL title, false for one with a subtitle or leading token
    // cut off. Both of these were real accepts, on real 2026 provisional stubs,
    // which is exactly the population CLAUDE.md rule 3 points this validator at.
    const cats = playbillUrlTitleMatch(
      `${P}cats-neil-simon-theatre-vault-0000001234`,
      { id: 'cats-the-jellicle-ball-2026', title: 'CATS: The Jellicle Ball', venue: 'Broadhurst Theatre' },
      { knownVenueSlugs: new Set([...VENUES, 'broadhurst-theatre']) });
    assert.equal(cats.match, false, '"CATS: The Jellicle Ball" must not take a plain "cats" vault URL');

    const seagull = playbillUrlTitleMatch(
      `${P}the-seagull-walter-kerr-theatre-vault-0000001111`,
      { id: 'seagull-true-story-off-broadway-2026', title: 'Seagull: True Story', venue: 'Walter Kerr Theatre' },
      OPTS);
    assert.equal(seagull.match, false, '"Seagull: True Story" must not take a "the-seagull" vault URL');
  });

  test('a full-title legacy recovery still works after that exclusion', () => {
    // The guard above must not cost any real recovery: none of the 10 legacy
    // URLs in the live cache belongs to a show with a subtitle.
    const r = playbillUrlTitleMatch(
      `${P}six-the-musicallena-horne-theatre-2021-2022`,
      { id: 'six-2021', title: 'SIX', venue: 'Lena Horne Theatre' }, OPTS);
    assert.equal(r.match, true);
    assert.equal(r.branch, 'legacy');
  });

  test('a trailing slash does not kill a legacy recovery', () => {
    // LEGACY_RE is $-anchored and only ?/# were stripped, so one trailing slash
    // silently dropped the exact URL shape this module exists to recover. The
    // market branch never noticed because it matches mid-path.
    const show = { id: 'aladdin-2014', title: 'Aladdin', venue: 'New Amsterdam Theatre' };
    const bare = `${P}aladdin-new-amsterdam-theatre-vault-0000014037`;
    for (const url of [bare, `${bare}/`, `${bare}//`, `${bare}/?utm=x`]) {
      const r = playbillUrlTitleMatch(url, show, OPTS);
      assert.equal(r.match, true, `failed on ${JSON.stringify(url)}`);
      assert.equal(r.branch, 'legacy');
    }
  });

  test('an empty or missing title never matches anything', () => {
    for (const title of [undefined, null, '', '   ']) {
      const r = playbillUrlTitleMatch(`${P}anything-broadway-some-theatre-2026`, { title }, OPTS);
      assert.equal(r.match, false, `empty title matched: ${JSON.stringify(title)}`);
    }
  });

  test('the 1536 cross-title collision is NOT claimed to be closed here', () => {
    // Documented honestly rather than papered over: every candidate segment is
    // offered to the form test, so the short reading still matches a show
    // genuinely titled "1536". The collision is between two CORPUS titles and
    // predates this module; BRO-2886 fixes the data. This test pins the real
    // behaviour so the docblock and the code cannot drift apart again.
    const r = playbillUrlTitleMatch(
      `${P}1536-west-end-london-almeida-theatre-2024`,
      { id: 'x-2024', title: '1536', venue: 'Almeida Theatre' }, OPTS);
    assert.equal(r.match, true);
    assert.equal(r.branch, 'exact');
  });

  test('a market word inside the TITLE is not read as the market delimiter', () => {
    // The lazy MARKET_SEGMENT_RE stops at the first market keyword, so a title
    // carrying one was truncated. Every split point is considered instead.
    const r = playbillUrlTitleMatch(
      `${P}1536-west-end-london-almeida-theatre-2026`,
      { id: 'x-2026', title: '1536 West End', venue: 'Almeida Theatre' }, OPTS);
    assert.equal(r.match, true);
    assert.equal(r.form, '1536-west-end');
  });
});
