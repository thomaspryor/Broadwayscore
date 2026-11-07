import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { referenceCoverage, inSeason, validateGapJustifications, loadGapJustifications } = require('../../scripts/lib/we-season-reference.js');
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

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

// Gap justifications (BRO-6450): committed, sourced reasons for reference
// entries the matcher misses. Every one must name a real reference entry.
for (const season of ['2012-2013', '2013-2014', '2014-2015', '2015-2016', '2016-2017']) {
  test(`${season} gap justifications are well formed and name real reference entries`, () => {
    const data = JSON.parse(readFileSync(new URL(`../../data/audit/we-season-reference/${season}.json`, import.meta.url), 'utf8'));
    assert.deepEqual(validateGapJustifications(loadGapJustifications(repoRoot, season), data.reference), []);
  });
}

test('validateGapJustifications rejects unknown entries, kinds, categories and unsourced reasons', () => {
  const reference = [{ title: 'Tory Boyz', venue: 'Ambassadors Theatre', start: '2013-09-23' }];
  const good = { title: 'Tory Boyz', start: '2013-09-23', kind: 'out-of-scope', category: 'non-professional-company', reason: 'National Youth Theatre REP season, youth ensemble.', evidence: ['https://theatricalia.com/x'] };
  assert.deepEqual(validateGapJustifications([good], reference), []);
  const errs = j => validateGapJustifications([{ ...good, ...j }], reference);
  assert.match(errs({ start: '2013-09-24' })[0], /no such reference entry/);
  assert.match(errs({ kind: 'skip' }).join(), /unknown kind/);
  assert.match(errs({ category: 'children' }).join(), /unknown out-of-scope category/);
  assert.match(errs({ reason: 'youth' }).join(), /reason/);
  assert.match(errs({ evidence: [] }).join(), /evidence/);
  assert.match(errs({ evidence: ['http://x.test'] }).join(), /evidence/);
  assert.match(errs({ kind: 'same-production', category: undefined }).join(), /needs showId/);
  assert.match(validateGapJustifications([good, good], reference).join(), /duplicate/);
});

test('a same-production justification counts the entry only while its row exists near the entry start', () => {
  const reference = [{ title: 'Bring Up the Bodies', venue: 'Aldwych Theatre', start: '2014-05-07', end: '2014-10-04' }];
  const justifications = [{ title: 'Bring Up the Bodies', start: '2014-05-07', kind: 'same-production', showId: 'wolf-hall' }];
  const wolfHall = { id: 'wolf-hall', title: 'Wolf Hall', category: 'west-end', previewsStartDate: '2014-05-01', closingDate: '2014-10-04' };
  const hit = referenceCoverage({ reference, shows: [wolfHall], justifications });
  assert.deepEqual(hit.present, [{ title: 'Bring Up the Bodies', venue: 'Aldwych Theatre', start: '2014-05-07', showId: 'wolf-hall', via: 'same-production' }]);
  assert.equal(hit.pass, true);
  // Row gone, or a different production of that title years away: the gap reopens and the stale entry is reported.
  for (const shows of [[], [{ ...wolfHall, previewsStartDate: '2021-09-01' }], [{ ...wolfHall, category: 'broadway' }]]) {
    const miss = referenceCoverage({ reference, shows, justifications });
    assert.equal(miss.present.length, 0);
    assert.equal(miss.missing.length, 1);
    assert.deepEqual(miss.staleJustifications, [{ title: 'Bring Up the Bodies', start: '2014-05-07', showId: 'wolf-hall' }]);
  }
  // Without the justification the title matcher alone does not pair them.
  assert.equal(referenceCoverage({ reference, shows: [wolfHall] }).present.length, 0);
});

test('out-of-scope entries leave the in-scope denominator but stay listed; the raw share is unchanged', () => {
  const reference = Array.from({ length: 61 }, (_, i) => ({ title: `Production ${i}`, venue: 'Test Theatre', start: '2015-10-01' }));
  const shows = reference.slice(0, 51).map((r, i) => ({ id: `show-${i}`, title: r.title, category: 'west-end', openingDate: r.start }));
  assert.equal(referenceCoverage({ reference, shows }).pass, false);
  const justifications = [{ title: 'Production 60', start: '2015-10-01', kind: 'out-of-scope', category: 'non-professional-company', reason: 'youth company season' }];
  const c = referenceCoverage({ reference, shows, justifications });
  assert.equal(c.share, 0.84);
  assert.equal(c.inScopeTotal, 60);
  assert.equal(c.inScopeShare, 0.85);
  assert.equal(c.pass, true, '51/60 is exactly 85% and must not lose to float drift');
  assert.deepEqual(c.outOfScope.map(r => [r.title, r.category]), [['Production 60', 'non-professional-company']]);
  assert.equal(c.missing.length, 9);
  // An unknown category is not honoured: the entry stays missing.
  const bad = referenceCoverage({ reference, shows, justifications: [{ ...justifications[0], category: 'children' }] });
  assert.equal(bad.outOfScope.length, 0);
  assert.equal(bad.missing.length, 10);
  assert.equal(bad.staleJustifications.length, 1);
});

test('a justification never overrides a real title match', () => {
  const reference = [{ title: 'Relative Values', venue: 'Harold Pinter Theatre', start: '2014-03-19' }];
  const shows = [{ id: 'rv', title: 'Relative Values', category: 'west-end', openingDate: '2014-03-19' }];
  const c = referenceCoverage({ reference, shows, justifications: [{ title: 'Relative Values', start: '2014-03-19', kind: 'out-of-scope', category: 'non-professional-company', reason: 'x' }] });
  assert.deepEqual(c.present.map(r => r.showId), ['rv']);
  assert.equal(c.outOfScope.length, 0);
});
