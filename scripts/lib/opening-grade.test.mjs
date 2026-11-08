// BRO-7147: an opening whose review window closed with aggregator-cited reviews
// still missing must not grade "on-its-own", and "known" must not be the census
// candidate count (which includes other productions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const og = require('./opening-grade.js');

const show = { id: 'medea-off-broadway-2026', title: 'Medea', category: 'off-broadway', openingDate: '2026-10-20' };
const files = Array.from({ length: 6 }, (_, i) => ({ _file: `${show.id}/r${i}.json`, firstSeenAt: '2026-10-21T03:00:00Z' }));
const embargo = og.estimateEmbargoMs(show.openingDate, show.category);
const closed = embargo + (og.AFTER_H + 24) * 3600000;
const open = embargo + 24 * 3600000;
const gapResult = { showId: show.id, censusVerdict: { candidateCount: 11 } };

test('closed window with cited reviews still missing grades incomplete, not on-its-own', () => {
  const g = og.gradeOpening({ show, files, gapResult, missingCited: 2, nowMs: closed });
  assert.equal(g.verdict, 'incomplete');
  assert.equal(g.known, 8);
  assert.equal(g.missing, 2);
  assert.match(og.gradeLine(g), /6 reviews live of 8 cited, opening week ended with 2 cited reviews still missing/);
  const s = og.summarize([g])['off-broadway'];
  assert.equal(s.onItsOwn, 0);
  assert.equal(s.incomplete, 1);
  assert.match(og.tallyLine(og.summarize([g]), 14), /Off-Broadway 0 of 1/);
});

test('census candidates (other productions) never inflate known', () => {
  const g = og.gradeOpening({ show, files, gapResult, missingCited: 0, nowMs: closed });
  assert.equal(g.verdict, 'on-its-own');
  assert.equal(g.known, 6);
  assert.equal(g.censusCandidates, 11);
  assert.doesNotMatch(og.gradeLine(g), /cited/);
});

test('open window with missing reviews still reads on-its-own so far', () => {
  const g = og.gradeOpening({ show, files, gapResult, missingCited: 3, nowMs: open });
  assert.equal(g.verdict, 'on-its-own');
  assert.match(og.gradeLine(g), /6 reviews live of 9 cited, ran on its own so far/);
});

test('no audit row leaves known unknown', () => {
  const g = og.gradeOpening({ show, files, gapResult: null, missingCited: null, nowMs: closed });
  assert.equal(g.known, null);
  assert.equal(g.verdict, 'on-its-own');
});

test('digest block colours an incomplete opening and older summaries without the field still tally', () => {
  const g = og.gradeOpening({ show, files, gapResult, missingCited: 1, nowMs: closed });
  const html = og.renderOpeningGradesBlock({ from: '2026-10-15', to: '2026-10-29', grades: [g] }, { nowMs: Date.parse('2026-10-25T00:00:00Z') });
  assert.match(html, /#b91c1c/);
  const legacy = { 'off-broadway': { openings: 1, onItsOwn: 1, neededHands: 0, noReviews: 0, notGradable: 0 } };
  assert.match(og.tallyLine(legacy, 14), /Off-Broadway 1 of 1/);
});

test('hand fixes outrank incomplete; no live reviews with cited ones out is no-reviews and still shown', () => {
  const hand = og.gradeOpening({ show, files: [{ ...files[0], ingestOrigin: 'manual', firstSeenAt: new Date(embargo + 3600000).toISOString() }, ...files.slice(1)],
    gapResult, missingCited: 2, nowMs: closed });
  assert.equal(hand.verdict, 'needed-hands');
  const none = og.gradeOpening({ show, files: [], gapResult, missingCited: 2, nowMs: closed });
  assert.equal(none.verdict, 'no-reviews');
  assert.match(og.gradeLine(none), /0 reviews live of 2 cited, cited reviews are out but none are on the site yet/);
});
