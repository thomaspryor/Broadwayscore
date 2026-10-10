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
