import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  matchProductions,
  selectCurrentProductionMatches,
  venuesMatch,
  findStaleMezzanineShowIds,
} = require('./scrape-mezzanine-audience.js');

// BRO-975: Mezzanine matcher merges old/historical productions of the same
// title into a current one-off revival's audience score. These fixtures
// mirror the six broken shows + the long-runner stability cases from the
// original audit (81 open Broadway/WE shows, 2026-04-19).

function production({ name, theater, opened, ratingsCount = 100, averageRating = 4.0 }) {
  return {
    objectId: `${name}-${theater}-${opened || 'undated'}`,
    show: { name },
    theater: theater ? { name: theater } : undefined,
    opened: opened || undefined,
    ratingsCount,
    averageRating,
  };
}

function show({ id, title, venue, openingDate, category = 'west-end', status = 'open' }) {
  return { id, title, venue, openingDate, previewsStartDate: openingDate, category, status };
}

describe('venuesMatch', () => {
  test('matches identical venue strings', () => {
    assert.ok(venuesMatch('Harold Pinter Theatre', 'Harold Pinter'));
  });

  test('folds diacritics so accented and plain forms line up', () => {
    assert.ok(venuesMatch('Noël Coward Theatre', 'Noel Coward'));
  });

  test('does not match different theaters', () => {
    assert.ok(!venuesMatch('Harold Pinter Theatre', "Duke of York's"));
  });

  test('returns false when either side is empty', () => {
    assert.ok(!venuesMatch('', 'Harold Pinter'));
    assert.ok(!venuesMatch('Harold Pinter Theatre', ''));
  });

  // Codex adversarial review (BRO-975): title-match.js's canonicalVenue()
  // falls back to the FIRST WORD for unrecognized venues, which would
  // falsely collide these pairs. venuesMatch() must not reuse that fallback.
  test('does not collide real, distinct theaters that share a first word', () => {
    assert.ok(!venuesMatch('Prince Edward Theatre', 'Prince of Wales Theatre'));
    assert.ok(!venuesMatch('Apollo Theatre', 'Apollo Victoria Theatre'));
    assert.ok(!venuesMatch('Lyric Theatre', 'Lyric Hammersmith'));
  });

  test('matches a descriptive-suffix variant of a specific, multi-word venue name', () => {
    assert.ok(venuesMatch('New York City Center', 'New York City Center - Mainstage'));
  });

  test('strips a leading "The" so it does not cause a false negative', () => {
    assert.ok(venuesMatch('The Gillian Lynne Theatre', 'Gillian Lynne Theatre'));
  });
});

describe('selectCurrentProductionMatches', () => {
  test('single match is returned untouched regardless of venue/year (long-runner protection)', () => {
    const m = [{ production: production({ name: 'Mamma Mia!', theater: 'Prince Edward Theatre', opened: '1999-04-06', ratingsCount: 5000 }) }];
    const result = selectCurrentProductionMatches(m, 2021, 'Novello Theatre');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0], m[0]);
  });

  test('keeps only the venue-confirmed match and drops a different-venue historical production', () => {
    const current = { production: production({ name: 'Dracula', theater: 'Noël Coward Theatre', opened: '2025-09-01', ratingsCount: 483, averageRating: 3.78 }) };
    const historical = { production: production({ name: 'Dracula', theater: 'Lyric Hammersmith', opened: '2019-10-01', ratingsCount: 57, averageRating: 2.83 }) };
    const result = selectCurrentProductionMatches([current, historical], 2026, 'Noël Coward Theatre');
    assert.deepStrictEqual(result, [current]);
  });

  test('drops a different-venue match even when its year is adjacent (Totoro Barbican case)', () => {
    const current = { production: production({ name: 'My Neighbour Totoro', theater: 'Gillian Lynne Theatre', opened: '2024-10-01', ratingsCount: 865 }) };
    const barbican2023 = { production: production({ name: 'My Neighbour Totoro', theater: 'Barbican', opened: '2023-11-01', ratingsCount: 312 }) };
    const barbican2022 = { production: production({ name: 'My Neighbour Totoro', theater: 'Barbican', opened: '2022-10-01', ratingsCount: 190 }) };
    const result = selectCurrentProductionMatches([current, barbican2023, barbican2022], 2025, 'Gillian Lynne Theatre');
    assert.deepStrictEqual(result, [current]);
  });

  test('drops multiple historicals at once, keeping only the current venue (Romeo and Juliet case)', () => {
    const current = { production: production({ name: 'Romeo and Juliet', theater: 'Harold Pinter Theatre', opened: '2026-03-16', ratingsCount: 179, averageRating: 4.02 }) };
    const historical = { production: production({ name: 'Romeo and Juliet', theater: "Duke of York's", opened: undefined, ratingsCount: 565, averageRating: 3.2 }) };
    const result = selectCurrentProductionMatches([current, historical], 2026, 'Harold Pinter Theatre');
    assert.deepStrictEqual(result, [current]);
  });

  test('drops ALL candidates when none confirm the current venue and none anchor within the recency window (Avenue Q case)', () => {
    const allMatches = [
      { production: production({ name: 'Avenue Q', theater: 'Sondheim Theatre', opened: '2024-06-01', ratingsCount: 40 }) },
      { production: production({ name: 'Avenue Q', theater: 'Noël Coward Theatre', opened: '2006-06-01', ratingsCount: 200 }) },
      { production: production({ name: 'Avenue Q', theater: 'Gielgud Theatre', opened: '2009-03-01', ratingsCount: 90 }) },
      { production: production({ name: 'Avenue Q', theater: "Wyndham's Theatre", opened: '2010-01-01', ratingsCount: 60 }) },
    ];
    // Current production plays the Shaftesbury Theatre — none of the above do,
    // and the closest historical (Sondheim 2024) is still 2 years out, outside
    // the ±1 year-verification fallback, so nothing merges.
    const result = selectCurrentProductionMatches(allMatches, 2026, 'Shaftesbury Theatre');
    assert.deepStrictEqual(result, []);
  });

  test('falls back to ±1-year verification when the show has no recognizable venue match anywhere, merging only the year-anchor\'s own venue', () => {
    const anchor = { production: production({ name: 'Foo', theater: 'Some Hall', opened: '2025-01-01', ratingsCount: 10 }) };
    const sameVenueAsAnchor = { production: production({ name: 'Foo', theater: 'Some Hall', opened: '2024-06-01', ratingsCount: 5 }) };
    const noVenueInfo = { production: production({ name: 'Foo', theater: undefined, opened: '2024-03-01', ratingsCount: 7 }) };
    const differentKnownVenue = { production: production({ name: 'Foo', theater: 'A Totally Different Hall', opened: '2024-08-01', ratingsCount: 999 }) };
    const tooOld = { production: production({ name: 'Foo', theater: 'Some Hall', opened: '2015-01-01', ratingsCount: 3 }) };
    const result = selectCurrentProductionMatches([tooOld, anchor, sameVenueAsAnchor, noVenueInfo, differentKnownVenue], 2025, 'Some Venue Not In Data');
    // Year-verified (±1 of 2025): anchor, sameVenueAsAnchor, noVenueInfo, differentKnownVenue — tooOld is excluded outright.
    // Of those, differentKnownVenue names a real, different theater from the anchor and is dropped even though its year qualifies.
    assert.deepStrictEqual(new Set(result), new Set([anchor, sameVenueAsAnchor, noVenueInfo]));
  });

  test('merges same-venue matches (legitimate multi-part production, e.g. Angels in America)', () => {
    const partOne = { production: production({ name: 'Angels in America: Millennium Approaches', theater: 'Neil Simon Theatre', opened: '2018-03-01', ratingsCount: 100 }) };
    const partTwo = { production: production({ name: 'Angels in America: Perestroika', theater: 'Neil Simon Theatre', opened: '2018-03-01', ratingsCount: 80 }) };
    const result = selectCurrentProductionMatches([partOne, partTwo], 2018, 'Neil Simon Theatre');
    assert.deepStrictEqual(new Set(result), new Set([partOne, partTwo]));
  });
});

describe('findStaleMezzanineShowIds', () => {
  const processedShows = [
    { id: 'avenue-q-west-end-2026', title: 'Avenue Q' },
    { id: 'romeo-and-juliet-west-end-2026', title: 'Romeo and Juliet' },
    { id: 'mamma-mia-west-end-2021', title: 'Mamma Mia!' },
  ];

  test('flags a show with existing Mezzanine data that no longer has a current-run match', () => {
    const audienceBuzzShows = {
      'avenue-q-west-end-2026': { sources: { mezzanine: { score: 70, reviewCount: 466 } } },
    };
    const result = findStaleMezzanineShowIds(processedShows, new Set(), audienceBuzzShows);
    assert.deepStrictEqual(result, ['avenue-q-west-end-2026']);
  });

  test('does not flag a show that still has a current match this run', () => {
    const audienceBuzzShows = {
      'romeo-and-juliet-west-end-2026': { sources: { mezzanine: { score: 80, reviewCount: 179 } } },
    };
    const matchedShowIds = new Set(['romeo-and-juliet-west-end-2026']);
    const result = findStaleMezzanineShowIds(processedShows, matchedShowIds, audienceBuzzShows);
    assert.deepStrictEqual(result, []);
  });

  test('does not flag a show with no existing Mezzanine data', () => {
    const result = findStaleMezzanineShowIds(processedShows, new Set(), {});
    assert.deepStrictEqual(result, []);
  });
});

describe('matchProductions integration — BRO-975 contamination fixes', () => {
  test('Romeo and Juliet: current revival score is not dragged down by an undated historical run', () => {
    const shows = [show({ id: 'romeo-and-juliet-west-end-2026', title: 'Romeo and Juliet', venue: 'Harold Pinter Theatre', openingDate: '2026-03-31' })];
    const productions = [
      production({ name: 'Romeo and Juliet', theater: 'Harold Pinter Theatre', opened: '2026-03-16', ratingsCount: 179, averageRating: 4.02 }),
      production({ name: 'Romeo and Juliet', theater: "Duke of York's Theatre", opened: undefined, ratingsCount: 565, averageRating: 3.2 }),
    ];
    const matches = matchProductions(productions, shows);
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].ratingsCount, 179);
    assert.strictEqual(matches[0].starRating, 4.0);
  });

  test('My Neighbour Totoro: Barbican tryout runs do not inflate the West End transfer volume', () => {
    const shows = [show({ id: 'my-neighbour-totoro-west-end-2025', title: 'My Neighbour Totoro', venue: 'Gillian Lynne Theatre', openingDate: '2025-03-08' })];
    const productions = [
      production({ name: 'My Neighbour Totoro', theater: 'Gillian Lynne Theatre', opened: '2024-10-01', ratingsCount: 865, averageRating: 4.26 }),
      production({ name: 'My Neighbour Totoro', theater: 'Barbican', opened: '2023-11-01', ratingsCount: 312, averageRating: 4.5 }),
      production({ name: 'My Neighbour Totoro', theater: 'Barbican', opened: '2022-10-01', ratingsCount: 190, averageRating: 4.5 }),
    ];
    const matches = matchProductions(productions, shows);
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].ratingsCount, 865);
  });

  test('Avenue Q: no confident current-production match means no Mezzanine data, not a 5-way blend', () => {
    const shows = [show({ id: 'avenue-q-west-end-2026', title: 'Avenue Q', venue: 'Shaftesbury Theatre', openingDate: '2026-04-16' })];
    const productions = [
      production({ name: 'Avenue Q', theater: 'Sondheim Theatre', opened: '2024-06-01', ratingsCount: 40 }),
      production({ name: 'Avenue Q', theater: 'Noël Coward Theatre', opened: '2006-06-01', ratingsCount: 200 }),
      production({ name: 'Avenue Q', theater: 'Gielgud Theatre', opened: '2009-03-01', ratingsCount: 90 }),
      production({ name: 'Avenue Q', theater: "Wyndham's Theatre", opened: '2010-01-01', ratingsCount: 60 }),
    ];
    const matches = matchProductions(productions, shows);
    assert.strictEqual(matches.length, 0);
  });

  test('long-runner stability: Mamma Mia keeps its single continuous-run match despite a huge year gap', () => {
    const shows = [show({ id: 'mamma-mia-west-end-2021', title: 'Mamma Mia!', venue: 'Novello Theatre', openingDate: '1999-04-06' })];
    const productions = [
      production({ name: 'Mamma Mia!', theater: 'Novello Theatre', opened: '1999-04-06', ratingsCount: 5000, averageRating: 4.1 }),
    ];
    const matches = matchProductions(productions, shows);
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].ratingsCount, 5000);
  });

  test('long-runner stability: a single match is kept even when Mezzanine venue naming has drifted from ours', () => {
    const shows = [show({ id: 'les-miserables-west-end-2021', title: 'Les Misérables', venue: 'Sondheim Theatre', openingDate: '1985-12-04' })];
    const productions = [
      // Mezzanine hasn't updated its venue name post-2019 rename (was "Queen's Theatre")
      production({ name: 'Les Miserables', theater: "Queen's Theatre", opened: '1985-10-08', ratingsCount: 12000, averageRating: 4.6 }),
    ];
    const matches = matchProductions(productions, shows);
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].ratingsCount, 12000);
  });

  test('legitimate multi-part production still merges end-to-end through Strategy 2 prefix matching (Angels in America)', () => {
    const shows = [show({ id: 'angels-in-america-2018', title: 'Angels in America', venue: 'Neil Simon Theatre', openingDate: '2018-03-25', category: 'broadway' })];
    const productions = [
      production({ name: 'Angels in America: Millennium Approaches', theater: 'Neil Simon Theatre', opened: '2018-03-01', ratingsCount: 100, averageRating: 4.5 }),
      production({ name: 'Angels in America: Perestroika', theater: 'Neil Simon Theatre', opened: '2018-03-01', ratingsCount: 80, averageRating: 4.5 }),
    ];
    const matches = matchProductions(productions, shows);
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].ratingsCount, 180);
    assert.strictEqual(matches[0].mergedFrom, 2);
  });
});
