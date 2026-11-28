import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openShowCoverageGaps, nonMatchKey } = require('../../scripts/lib/audience-coverage-gaps.js');

// Reproduces the 2026-06-22 Encores La Cage miss: Mezzanine had the City Center
// production (85 ratings) but the matcher never linked it, and the existing
// coverage audit flagged it — yet it was buried among closed-revival flags in a
// passive digest section. This check narrows to OPEN-show flags so the actionable
// signal (a running show missing a source) drives the alert.
describe('openShowCoverageGaps', () => {
  const openIds = new Set(['encores-la-cage-aux-folles-off-broadway-2026', 'some-open-show-2026']);

  const mezzReport = {
    source: 'Mezzanine',
    flagged: [
      // OPEN show — the actionable La Cage case
      { ourShowId: 'encores-la-cage-aux-folles-off-broadway-2026', ourTitle: 'Encores! La Cage Aux Folles', mezzName: 'La Cage aux Folles', ratingsCount: 85, theater: 'New York City Center - Mainstage' },
      // CLOSED revival — noise, must be excluded
      { ourShowId: 'la-cage-aux-folles-2010', ourTitle: 'La Cage aux Folles', mezzName: 'La Cage aux Folles', ratingsCount: 25, theater: 'Longacre Theatre' },
    ],
  };
  const theatrReport = {
    source: 'Theatr',
    flagged: [
      { ourShowId: 'some-open-show-2026', ourTitle: 'Some Open Show', theatrName: 'Some Open Show', watched: 120 },
    ],
  };

  test('returns only flags on open shows, dropping closed-revival noise', () => {
    const gaps = openShowCoverageGaps([mezzReport, theatrReport], openIds);
    const ids = gaps.map(g => g.ourShowId);
    assert.ok(ids.includes('encores-la-cage-aux-folles-off-broadway-2026'), 'expected La Cage (open) flagged');
    assert.ok(!ids.includes('la-cage-aux-folles-2010'), 'closed revival must be excluded');
    assert.strictEqual(gaps.length, 2, `expected 2 open-show gaps, got ${gaps.length}`);
  });

  test('sorts by ratingsCount desc and normalizes source-side name + count', () => {
    const gaps = openShowCoverageGaps([mezzReport, theatrReport], openIds);
    assert.strictEqual(gaps[0].ourShowId, 'some-open-show-2026', 'highest count (120) first');
    assert.strictEqual(gaps[0].sourceName, 'Some Open Show');
    assert.strictEqual(gaps[0].ratingsCount, 120, 'theatr watched mapped to ratingsCount');
    assert.strictEqual(gaps[1].sourceName, 'La Cage aux Folles');
    assert.strictEqual(gaps[1].source, 'Mezzanine');
  });

  test('empty / malformed reports yield no gaps (never throws)', () => {
    assert.deepStrictEqual(openShowCoverageGaps([], openIds), []);
    assert.deepStrictEqual(openShowCoverageGaps(null, openIds), []);
    assert.deepStrictEqual(openShowCoverageGaps([{ source: 'X' }, null, { flagged: null }], openIds), []);
  });

  test('suppresses an operator-confirmed non-match (Archduke cross-production)', () => {
    // Uses the EXACT production shape: source 'Theatr' (capitalized, as health-
    // check.js passes it), theatrName 'Archduke', ourShowId archduke-west-end-2026.
    const report = {
      source: 'Theatr',
      flagged: [
        { ourShowId: 'archduke-west-end-2026', ourTitle: 'Archduke', theatrName: 'Archduke', eventCategory: 'Off & Off-Off Broadway', watched: 102, ratingsCount: 102, jaccard: 1 },
      ],
    };
    const gaps = openShowCoverageGaps([report], new Set(['archduke-west-end-2026']));
    assert.strictEqual(gaps.length, 0, 'confirmed non-match must be suppressed regardless of source capitalization');
  });

  test('suppression is specific — a DIFFERENT show with the same source name still gaps', () => {
    const report = {
      source: 'Theatr',
      flagged: [
        { ourShowId: 'archduke-broadway-2099', ourTitle: 'Archduke', theatrName: 'Archduke', watched: 102 },
      ],
    };
    const gaps = openShowCoverageGaps([report], new Set(['archduke-broadway-2099']));
    assert.strictEqual(gaps.length, 1, 'only the confirmed (name,show) pair is suppressed, not the title globally');
  });

  test('BRO-303: Mezzanine entries for a different staging of a tour/opera show are suppressed (real audit file shape)', () => {
    // Exact flagged rows from data/audit/mezzanine-coverage.json on 2026-10-05.
    // Source capitalised as health-check.js passes it; names as Mezzanine spells them.
    const flagged = [
      { ourShowId: 'the-great-gatsby-tour-2026', ourTitle: 'The Great Gatsby', mezzName: 'The Great Gatsby', ratingsCount: 3387 },
      { ourShowId: 'mrs-doubtfire-tour-2025', ourTitle: 'Mrs. Doubtfire', mezzName: 'Mrs Doubtfire', ratingsCount: 1393 },
      { ourShowId: 'hells-kitchen-tour-2025', ourTitle: 'Hell\'s Kitchen', mezzName: 'Hell’s Kitchen', ratingsCount: 172 },
      { ourShowId: 'macbeth-off-broadway-2026', ourTitle: 'Macbeth', mezzName: 'Macbeth', ratingsCount: 329 },
      { ourShowId: 'macbeth-off-broadway-2026', ourTitle: 'Macbeth', mezzName: 'Macbeth', ratingsCount: 108 },
      { ourShowId: 'this-is-not-not-a-drill-off-broadway-2026', ourTitle: 'This Is Not Not a Drill', mezzName: 'This Is Not A Drill', ratingsCount: 30 },
    ];
    const open = new Set(flagged.map((f) => f.ourShowId));
    assert.strictEqual(openShowCoverageGaps([{ source: 'Mezzanine', flagged }], open).length, 0);
  });

  test('BRO-303: the Mezzanine suppressions are show-specific, so an unlisted open show with the same name still gaps', () => {
    const flagged = [{ ourShowId: 'the-great-gatsby-broadway-2099', ourTitle: 'The Great Gatsby', mezzName: 'The Great Gatsby', ratingsCount: 3387 }];
    const gaps = openShowCoverageGaps([{ source: 'Mezzanine', flagged }], new Set(['the-great-gatsby-broadway-2099']));
    assert.strictEqual(gaps.length, 1);
  });

  test('nonMatchKey is case-insensitive on source', () => {
    assert.strictEqual(nonMatchKey('Theatr', 'Archduke', 'archduke-west-end-2026'), nonMatchKey('theatr', 'archduke', 'archduke-west-end-2026'));
  });
});

// BRO-5167: Mezzanine "An Oak Tree" (Young Vic, closed 2025-05-17) was flagged
// against our 2026 Other Palace run because the title matched exactly. A source
// run that closed before ours began is an earlier staging, never a gap.
describe('earlier closed source runs are not gaps (BRO-5167)', () => {
  const { isEarlierClosedRun } = require('../../scripts/lib/audience-coverage-gaps.js');
  const ours = { id: 'oak-2026', previewsStartDate: '2026-10-07', openingDate: null };

  test('isEarlierClosedRun: closed long before our first preview', () => {
    assert.strictEqual(isEarlierClosedRun('2025-05-17T04:00:00.000Z', ours), true);
  });
  test('isEarlierClosedRun: overlapping or still-running source run is kept', () => {
    assert.strictEqual(isEarlierClosedRun('2026-11-15', ours), false);
    assert.strictEqual(isEarlierClosedRun(null, ours), false);
    // within the 7-day grace window (catalog date slop); a month earlier is not
    assert.strictEqual(isEarlierClosedRun('2026-10-02', ours), false);
    assert.strictEqual(isEarlierClosedRun('2026-09-08', ours), true);
  });
  test('isEarlierClosedRun: unknown start dates never suppress', () => {
    assert.strictEqual(isEarlierClosedRun('2025-05-17', { previewsStartDate: null, openingDate: null }), false);
    assert.strictEqual(isEarlierClosedRun('2025-05-17', undefined), false);
  });

  test('openShowCoverageGaps drops a flag whose source run closed before ours', () => {
    const showsById = new Map([['oak-2026', ours], ['live-2026', { id: 'live-2026', previewsStartDate: '2026-09-01' }]]);
    const report = { source: 'Mezzanine', flagged: [
      { ourShowId: 'oak-2026', ourTitle: 'Oak', mezzName: 'Oak', ratingsCount: 57, sourceClosed: '2025-05-17T04:00:00.000Z' },
      { ourShowId: 'live-2026', ourTitle: 'Live', mezzName: 'Live', ratingsCount: 40, sourceClosed: null },
    ] };
    const gaps = openShowCoverageGaps([report], new Set(['oak-2026', 'live-2026']), showsById);
    assert.deepStrictEqual(gaps.map(g => g.ourShowId), ['live-2026']);
    // Without show dates the old behavior holds (back-compat for callers).
    assert.strictEqual(openShowCoverageGaps([report], new Set(['oak-2026', 'live-2026'])).length, 2);
  });

  test('the real An Oak Tree flag (no closing date in the old audit file) is suppressed', () => {
    const report = { source: 'Mezzanine', flagged: [
      { mezzName: 'An Oak Tree', theater: 'Young Vic Theatre', ratingsCount: 57, mYear: 2025, ourShowId: 'an-oak-tree-off-west-end-2026', ourTitle: 'An Oak Tree' },
    ] };
    assert.strictEqual(openShowCoverageGaps([report], new Set(['an-oak-tree-off-west-end-2026'])).length, 0);
  });
});

describe('differentProductionReason (BRO-5167)', () => {
  const { differentProductionReason } = require('../../scripts/lib/audience-coverage-gaps.js');
  const nycShow = { id: 'button-2026', market: 'broadway', previewsStartDate: '2026-10-08', openingDate: '2026-10-21' };
  const weShow = { id: 'hp-2026', market: 'west-end', previewsStartDate: '2026-10-09', openingDate: null };

  test('London source run never matches a NYC show', () => {
    assert.ok(differentProductionReason({ mYear: 2024, sourceMarket: 'london' }, nycShow));
  });
  test('NYC source run never matches a West End or touring show', () => {
    assert.ok(differentProductionReason({ mYear: 2026, sourceMarket: 'nyc' }, weShow));
    assert.ok(differentProductionReason({ mYear: 2025, sourceMarket: 'nyc' }, { market: 'tour', previewsStartDate: '2025-10-10' }));
  });
  test('year gate uses previewsStartDate when the show has not opened (Cursed Child 2016 vs 2026)', () => {
    assert.ok(differentProductionReason({ mYear: 2016, sourceMarket: 'london' }, weShow));
  });
  test('a same-city, same-era, still-running source run may be ours (stays a gap)', () => {
    assert.strictEqual(differentProductionReason({ mYear: 2026, sourceMarket: 'london', sourceClosed: null }, weShow), null);
    assert.strictEqual(differentProductionReason({ mYear: 2026, sourceMarket: 'nyc' }, nycShow), null);
    // Old audit files carry no sourceMarket: market rule abstains.
    assert.strictEqual(differentProductionReason({ mYear: 2026 }, nycShow), null);
  });
});
