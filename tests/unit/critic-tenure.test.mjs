/**
 * BRO-5222 gap 4: critic/outlet tenure check (advisory). Requires the real
 * function (CLAUDE.md 15).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findTenureFlags, isVerifiedRow, reviewYear } = require('../../scripts/lib/critic-tenure.js');

const rows = (outlet, years, verified = true) => years.map((year, i) => ({ showId: `s-${outlet}-${year}-${i}`, file: `${outlet}--x.json`, outlet, year, verified }));

test('a row at the right outlet in a year the critic wrote elsewhere is outside_tenure (Rooney THR 2006)', () => {
  const critics = {
    'david-rooney': {
      displayName: 'David Rooney',
      reviews: [
        ...rows('variety', [2005, 2006, 2006, 2006, 2007]),
        ...rows('hollywood-reporter', [2008, 2010, 2015, 2020]),
        { showId: 'the-threepenny-opera-2006', file: 'hollywood-reporter--david-rooney.json', outlet: 'hollywood-reporter', year: 2006, verified: false },
      ],
    },
  };
  const flags = findTenureFlags(critics);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, 'outside_tenure');
  assert.equal(flags[0].showId, 'the-threepenny-opera-2006');
  assert.deepEqual(flags[0].tenure, { first: 2008, last: 2020, count: 4 });
});

test('no flag inside the slack year, or without enough verified rows elsewhere that year', () => {
  const critics = {
    a: { displayName: 'A', reviews: [...rows('x', [2010, 2011, 2012]), ...rows('y', [2009, 2009, 2009]), { showId: 'q', file: 'x--a.json', outlet: 'x', year: 2009, verified: false }] },
    b: { displayName: 'B', reviews: [...rows('x', [2010, 2011, 2012]), ...rows('y', [2005, 2005]), { showId: 'q', file: 'x--b.json', outlet: 'x', year: 2005, verified: false }] },
  };
  assert.deepEqual(findTenureFlags(critics), []);
});

test('unsupported_pair only for an unverified row at an outlet with no verified support', () => {
  const critics = {
    c: { displayName: 'C', reviews: [...rows('x', [2010, 2011, 2012, 2013, 2014]), { showId: 'z', file: 'y--c.json', outlet: 'y', year: 2012, verified: false }] },
  };
  const flags = findTenureFlags(critics);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, 'unsupported_pair');
  // A verified row at a new outlet is its own support.
  critics.c.reviews[5].verified = true;
  assert.deepEqual(findTenureFlags(critics), []);
});

test('isNonReview rows are neither flagged nor tenure evidence (BRO-5232)', () => {
  const critics = {
    d: { displayName: 'D', reviews: [...rows('x', [2010, 2011, 2012, 2013, 2014]), { showId: 'z', file: 'billboard--d.json', outlet: 'billboard', year: 2012, verified: false, nonReview: true }] },
  };
  assert.deepEqual(findTenureFlags(critics), []);
  critics.d.reviews[5].nonReview = false;
  assert.equal(findTenureFlags(critics).length, 1);
  // A verified non-review page does not build tenure at its outlet either.
  const e = { displayName: 'E', reviews: [...rows('x', [2010, 2011, 2012, 2013, 2014]), { ...rows('y', [2012])[0], nonReview: true }, { showId: 'w', file: 'y--e.json', outlet: 'y', year: 2013, verified: false }] };
  assert.equal(findTenureFlags({ e }).length, 1);
});

test('a stored page crediting another of the outlet critics contradicts the byline (BRO-5232)', () => {
  const { bylineContradicted } = require('../../scripts/lib/critic-tenure.js');
  const page = 'Headline about a revival Patrick RyanUSA TODAYDec. 20, 2024 ' + 'x'.repeat(1200);
  assert.equal(bylineContradicted(page, 'Charles Isherwood', ['Patrick Ryan', 'Charles Isherwood']), true);
  // Own surname anywhere in the text: not contradicted.
  assert.equal(bylineContradicted(page + ' Isherwood', 'Charles Isherwood', ['Patrick Ryan']), false);
  // The other name must be one of the outlet's critics, and sit in the head.
  assert.equal(bylineContradicted(page, 'Charles Isherwood', ['Kelly Lawler']), false);
  assert.equal(bylineContradicted('x'.repeat(700) + ' Patrick Ryan', 'Charles Isherwood', ['Patrick Ryan']), false);
  assert.equal(bylineContradicted(page, 'Patrick Ryan', ['Patrick Ryan']), false);
  // Byline forms count; a mention in the prose does not.
  const pad = 'x'.repeat(1200);
  assert.equal(bylineContradicted('Theatre Review by Howard Miller - July 11 ' + pad, 'Matthew Murray', ['Howard Miller']), true);
  assert.equal(bylineContradicted('Jeremy Malies in the West End 13 Nov ' + pad, 'Maryam Philpott', ['Jeremy Malies']), true);
  assert.equal(bylineContradicted('as Frank Rich wrote in 1991 ' + pad, 'Jesse Green', ['Frank Rich']), false);
  assert.equal(bylineContradicted('in James Graham\u2019s play ' + pad, 'Sam Marlowe', ['James Graham']), false);
  assert.equal(bylineContradicted('opened at the Walter Kerr Theater ' + pad, 'Ben Brantley', ['Walter Kerr']), false);
  assert.equal(bylineContradicted('By New York ' + pad, 'Ben Brantley', ['New York']), false);
  // A contradicted row is flagged and does not build the pair's tenure.
  const critics = { ci: { displayName: 'Charles Isherwood', reviews: [...rows('wsj', [2020, 2021, 2022, 2023, 2024]),
    { showId: 'g-2024', file: 'usatoday--charles-isherwood.json', outlet: 'usatoday', year: 2024, verified: false, bylineContradicted: true },
    { showId: 'h-2024', file: 'usatoday--charles-isherwood.json', outlet: 'usatoday', year: 2024, verified: false }] } };
  const flags = findTenureFlags(critics);
  assert.deepEqual(flags.map(f => f.kind).sort(), ['byline_contradicted', 'unsupported_pair']);
});

test('Unknown critics are never flagged', () => {
  const critics = { unknown: { displayName: 'Unknown', reviews: [...rows('x', [2020, 2020, 2020]), ...rows('y', [2010, 2010, 2010, 2010])] } };
  assert.deepEqual(findTenureFlags(critics), []);
});

test('verified rows and review year', () => {
  assert.equal(isVerifiedRow({ url: 'u', contentTier: 'complete', fullText: 'x'.repeat(1200) }), true);
  assert.equal(isVerifiedRow({ url: 'u', contentTier: 'stub', fullText: 'x'.repeat(1200) }), false);
  assert.equal(isVerifiedRow({ url: null, contentTier: 'complete', fullText: 'x'.repeat(1200) }), false);
  assert.equal(reviewYear('once-2012', { publishDate: '2011-12-07' }), 2011);
  assert.equal(reviewYear('once-2012', {}), 2012);
  assert.equal(reviewYear('no-year', {}), null);
});

test('applyReviewedTenureFlags: evidence-backed entries resolve flags, stale and invalid entries surface', () => {
  const { applyReviewedTenureFlags, tenureFlagKey } = require('../../scripts/lib/critic-tenure.js');
  const flags = [
    { showId: 'a-2009', file: 'variety--x.json', kind: 'unsupported_pair', criticSlug: 'x' },
    { showId: 'b-2010', file: 'nytimes--y.json', kind: 'outside_tenure', criticSlug: 'y' },
  ];
  assert.strictEqual(tenureFlagKey(flags[0]), 'a-2009/variety--x.json#unsupported_pair:x');
  const r = applyReviewedTenureFlags(flags, [
    { key: 'a-2009/variety--x.json#unsupported_pair:x', evidence: 'https://variety.com/2009/x' },
    { key: 'b-2010/nytimes--y.json#outside_tenure:y', evidence: 'checked by hand' },
    { key: 'gone-2001/ew--z.json#unsupported_pair:z', evidence: 'https://ew.com/z' },
  ]);
  assert.deepStrictEqual(r.reviewed.map(tenureFlagKey), ['a-2009/variety--x.json#unsupported_pair:x']);
  assert.deepStrictEqual(r.unresolved.map(tenureFlagKey), ['b-2010/nytimes--y.json#outside_tenure:y']);
  assert.deepStrictEqual(r.stale.map(e => e.key), ['gone-2001/ew--z.json#unsupported_pair:z']);
  assert.strictEqual(r.invalid.length, 1);
  // A byline change on a reviewed row reopens it.
  const moved = applyReviewedTenureFlags([{ ...flags[0], criticSlug: 'other' }], [{ key: 'a-2009/variety--x.json#unsupported_pair:x', evidence: 'https://variety.com/2009/x' }]);
  assert.strictEqual(moved.unresolved.length, 1);
});

// BRO-5261 retro-review of BRO-5222: prose dates carry their own year.
test('reviewYear reads the year from prose dates and ignores junk', () => {
  assert.equal(reviewYear('chicago-1996', { publishDate: 'March 3rd, 2016' }), 2016);
  assert.equal(reviewYear('x-2007', { publishDate: '9 May 2008' }), 2008);
  assert.equal(reviewYear('x-2007', { publishDate: '2009-01-02' }), 2009);
  assert.equal(reviewYear('x-2007', { publishDate: 'Act 1' }), 2007, 'no year written: falls back to the show id');
  assert.equal(reviewYear('x-2007', {}), 2007);
});

test('describeTenureFlag never throws for any kind findTenureFlags emits (BRO-5789)', () => {
  const { describeTenureFlag } = require('../../scripts/lib/critic-tenure.js');
  const critics = {
    'ann-b': {
      displayName: 'Ann B',
      reviews: [
        ...rows('variety', [2005, 2006, 2007, 2008]),
        { showId: 'x-2010', file: 'wsj--ann-b.json', outlet: 'wsj', year: 2010, verified: false },
        { showId: 'y-2011', file: 'nyt--ann-b.json', outlet: 'nyt', year: 2011, verified: true, bylineContradicted: true },
      ],
    },
  };
  const flags = findTenureFlags(critics);
  assert.ok(flags.some(f => f.kind === 'byline_contradicted'), 'fixture must hit the kind that used to crash');
  for (const f of flags) assert.equal(typeof describeTenureFlag(f), 'string');
  assert.match(describeTenureFlag({ kind: 'weird' }), /unrecognised/);
});
