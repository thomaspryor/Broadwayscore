import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { referenceCoverage, inSeason } = require('../../scripts/lib/we-season-reference.js');

// These are committed research inputs, not the mutable private shows/reviews
// corpus. This acceptance command must work in the code-only CI checkout.
for (const season of ['2012-2013', '2013-2014', '2014-2015', '2015-2016', '2016-2017']) {
  test(`${season} has a sourced, internally consistent season reference list`, () => {
    const data = JSON.parse(readFileSync(new URL(`../../data/audit/we-season-reference/${season}.json`, import.meta.url), 'utf8'));
    assert.equal(data.season, season);
    assert.ok(data.definition.length > 0);
    assert.ok(Number.isFinite(Date.parse(data.generatedAt)));
    assert.ok(data.sources.length >= 2);
    assert.ok(data.reference.length > 0);
    assert.equal(data.counts.reference, data.reference.length);
    assert.equal(data.counts.theatricaliaOnly, data.uncorroborated.length);
    assert.equal(data.counts.excludedShortRuns, data.excluded.length);

    const seen = new Set();
    for (const entry of data.reference) {
      const label = `${entry.title} (${entry.venue}, ${entry.start})`;
      assert.ok(typeof entry.title === 'string' && entry.title.trim(), label);
      assert.ok(typeof entry.venue === 'string' && entry.venue.trim(), label);
      assert.match(entry.start, /^\d{4}-\d{2}-\d{2}$/, label);
      assert.ok(inSeason(entry.start, season), label);
      if (entry.end !== null) {
        assert.match(entry.end, /^\d{4}-\d{2}-\d{2}$/, label);
        assert.ok(Date.parse(entry.end) >= Date.parse(entry.start), label);
      }
      assert.equal(entry.corroborated, true, label);
      assert.ok(new Set(entry.sources).size >= 2, label);
      for (const source of entry.sources) {
        assert.ok(data.sources.some(s => s === source || s.startsWith(`${source} (`)), `${label}: undocumented source ${source}`);
      }
      assert.equal(new URL(entry.url).protocol, 'https:', label);
      const key = JSON.stringify([entry.title, entry.venue, entry.start]);
      assert.ok(!seen.has(key), `duplicate reference: ${label}`);
      seen.add(key);
    }
  });
}

test('completeness counts both promoted and already-present West End rows', () => {
  const reference = [
    { title: 'Macbeth', venue: 'Trafalgar Theatre', start: '2013-02-09' },
    { title: 'The Book of Mormon', venue: 'Prince of Wales Theatre', start: '2013-02-25' },
    { title: 'Old Times', venue: 'Harold Pinter Theatre', start: '2013-01-12', end: '2013-04-06' },
  ];
  const shows = [
    { id: 'macbeth-2013', title: 'Macbeth', category: 'west-end', previewsStartDate: '2013-02-09', discoverySource: 'we-historical:theatricalia' },
    { id: 'mormon', title: 'The Book of Mormon', category: 'west-end', openingDate: '2013-03-21' },
  ];
  const result = referenceCoverage({ reference, shows });
  assert.equal(result.total, 3);
  assert.deepEqual(result.present.map(r => r.showId), ['macbeth-2013', 'mormon']);
  assert.deepEqual(result.missing, [reference[2]]);
  assert.equal(result.share, 0.67);
  assert.equal(result.pass, false);
  assert.equal(result.threshold, 0.85);
});

test('a later revival and a Broadway production do not fill historical gaps', () => {
  const reference = [
    { title: 'The Weir', venue: "Wyndham's Theatre", start: '2014-01-16' },
    { title: 'Kinky Boots', venue: 'Adelphi Theatre', start: '2015-08-21' },
  ];
  const result = referenceCoverage({
    reference,
    shows: [
      { id: 'weir-2025', title: 'The Weir', category: 'west-end', openingDate: '2025-09-19' },
      { id: 'boots-bw', title: 'Kinky Boots', category: 'broadway', openingDate: '2015-08-21' },
    ],
  });
  assert.equal(result.present.length, 0);
  assert.deepEqual(result.missing.map(r => r.title), ['The Weir', 'Kinky Boots']);
  assert.equal(result.share, 0);
  assert.equal(result.pass, false);
});

test('long-running productions and a nearby return run count without duplicate promotions', () => {
  const result = referenceCoverage({
    reference: [
      { title: 'Mamma Mia!', venue: 'Novello Theatre', start: '2012-09-06' },
      { title: 'The Kite Runner', venue: 'Playhouse Theatre', start: '2017-06-08' },
    ],
    shows: [
      { id: 'mamma-mia', title: 'Mamma Mia!', category: 'west-end', openingDate: '1999-04-06' },
      { id: 'kite-runner', title: 'The Kite Runner', category: 'west-end', openingDate: '2017-01-10', closingDate: '2017-03-11' },
    ],
  });
  assert.deepEqual(result.present.map(r => r.showId), ['mamma-mia', 'kite-runner']);
  assert.deepEqual(result.missing, []);
  assert.equal(result.share, 1);
  assert.equal(result.pass, true);
});

test('85 percent is inclusive and the decision uses unrounded coverage', () => {
  const reference = Array.from({ length: 100 }, (_, i) => ({ title: `Production ${i}`, venue: 'Test Theatre', start: '2013-01-01' }));
  const shows = reference.slice(0, 85).map((r, i) => ({ id: `show-${i}`, title: r.title, category: 'west-end', openingDate: r.start }));
  assert.equal(referenceCoverage({ reference, shows }).pass, true);
  const below = referenceCoverage({ reference, shows: shows.slice(0, 84) });
  assert.equal(below.share, 0.84);
  assert.equal(below.pass, false);
  const rounded = referenceCoverage({ reference: reference.slice(0, 99), shows: shows.slice(0, 84) });
  assert.equal(rounded.share, 0.85);
  assert.equal(rounded.pass, false);
});

test('an empty reference is not evidence of completeness', () => {
  const result = referenceCoverage({ reference: [], shows: [] });
  assert.equal(result.total, 0);
  assert.equal(result.share, 0);
  assert.equal(result.pass, false);
});
