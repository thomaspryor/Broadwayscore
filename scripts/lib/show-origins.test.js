'use strict';
// BRO-5842: checks on model answers before they reach data/show-origins.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOrigin, pathNoteConflicts, urlKey, inScopeShows } = require('./show-origins');

const ok = { path: ['off-broadway'], pathNote: 'Public Theater (2015)', source: 'book', sourceTitle: 'Alexander Hamilton', confidence: 'high', evidence: ['https://en.wikipedia.org/wiki/Hamilton_(musical)'] };

test('accepts a well-formed answer and drops duplicate stages', () => {
  const r = normalizeOrigin({ ...ok, path: ['off-broadway', 'OFF-BROADWAY', 'london'] });
  assert.deepEqual(r.record.path, ['off-broadway', 'london']);
  assert.equal(r.record.source, 'book');
});

test('refuses unknown codes and answers with no evidence', () => {
  assert.match(normalizeOrigin({ ...ok, path: ['west-end'] }).error, /unknown path stage/);
  assert.match(normalizeOrigin({ ...ok, source: 'movie' }).error, /unknown source/);
  assert.match(normalizeOrigin({ ...ok, evidence: ['not a url'] }).error, /no evidence/);
  assert.match(normalizeOrigin(undefined).error, /not an object/);
});

test('evidence must be a URL the search returned', () => {
  const seen = ['https://en.wikipedia.org/wiki/Hamilton_%28musical%29?utm_source=openai'];
  assert.ok(normalizeOrigin(ok, seen).record);
  assert.match(normalizeOrigin({ ...ok, evidence: ['https://www.ibdb.com/made-up'] }, seen).error, /search returned/);
  assert.equal(urlKey('https://www.IBDB.com/a/?x=1#y'), 'ibdb.com/a');
});

test('original shows carry no source title', () => {
  assert.equal(normalizeOrigin({ ...ok, source: 'original' }).record.sourceTitle, null);
});

test('pathNote naming a stop the codes miss is flagged', () => {
  assert.deepEqual(pathNoteConflicts({ path: ['off-broadway', 'regional-us', 'london'], pathNote: 'NYTW (2016) > Citadel Theatre, Edmonton (2017) > National Theatre, London (2018)' }), ['international']);
  assert.deepEqual(pathNoteConflicts({ path: ['international'], pathNote: 'London production in 1997' }), ['london']);
  assert.deepEqual(pathNoteConflicts({ path: ['regional-us'], pathNote: 'La Jolla Playhouse (2004)' }), []);
  assert.deepEqual(pathNoteConflicts({ path: [], pathNote: null }), []);
});

test('scope: Broadway, opened or announced from 2000-01 on, not a tour or cancelled', () => {
  const ids = inScopeShows([
    { id: 'a', category: 'broadway', openingDate: '2001-01-01', status: 'closed' },
    { id: 'b', category: 'broadway', openingDate: '1999-01-01', status: 'closed' },
    { id: 'c', category: 'broadway', openingDate: '2027-01-01', status: 'upcoming' },
    { id: 'd', category: 'off-broadway', market: 'broadway', openingDate: '2010-01-01', status: 'closed' },
    { id: 'e', category: 'broadway', openingDate: '2010-01-01', status: 'closed', tourOf: 'x' },
    { id: 'f', category: 'broadway', openingDate: '2027-01-01', status: 'upcoming', cancelledBeforeOpening: true },
  ]).map((s) => s.id);
  assert.deepEqual(ids, ['a', 'c']);
});

test('second opinions: labels only, agreement ignores stop order and film vs TV', () => {
  const { normalizeCheck, originsAgree } = require('./show-origins');
  assert.deepEqual(normalizeCheck({ path: ['london'], source: 'film' }).record, { path: ['london'], source: 'film' });
  assert.match(normalizeCheck({ path: ['west-end'], source: 'film' }).error, /unknown path stage/);
  assert.equal(originsAgree({ path: ['london', 'regional-us'], source: 'film' }, { path: ['regional-us', 'london'], source: 'tv' }), true);
  assert.equal(originsAgree({ path: [], source: 'original' }, { path: ['regional-us'], source: 'original' }), false);
  assert.equal(originsAgree({ path: [], source: 'film' }, { path: [], source: 'book' }), false);
});

test('every original record in data/show-origins.json says true story or invented (BRO-5871)', () => {
  // sourceBucket counts an unlabeled original as invented; run scripts/classify-original-kind.js after labeling new shows.
  const { ORIGINAL_KINDS } = require('./show-origins');
  const data = require('../../data/show-origins.json');
  const missing = Object.entries(data.shows).filter(([, r]) => r.source === 'original' && !ORIGINAL_KINDS.includes(r.originalKind)).map(([id]) => id);
  assert.deepEqual(missing, []);
});
