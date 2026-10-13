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
    { showId: 'a-2009', file: 'variety--x.json', kind: 'unsupported_pair' },
    { showId: 'b-2010', file: 'nytimes--y.json', kind: 'outside_tenure' },
  ];
  assert.strictEqual(tenureFlagKey(flags[0]), 'a-2009/variety--x.json');
  const r = applyReviewedTenureFlags(flags, [
    { key: 'a-2009/variety--x.json', evidence: 'https://variety.com/2009/x' },
    { key: 'b-2010/nytimes--y.json', evidence: 'checked by hand' },
    { key: 'gone-2001/ew--z.json', evidence: 'https://ew.com/z' },
  ]);
  assert.deepStrictEqual(r.reviewed.map(tenureFlagKey), ['a-2009/variety--x.json']);
  assert.deepStrictEqual(r.unresolved.map(tenureFlagKey), ['b-2010/nytimes--y.json']);
  assert.deepStrictEqual(r.stale.map(e => e.key), ['gone-2001/ew--z.json']);
  assert.strictEqual(r.invalid.length, 1);
});
