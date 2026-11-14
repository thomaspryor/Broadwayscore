/**
 * BRO-5637: the named-different-director bypass must not treat the director of
 * an EARLIER, closed production of the same title as proof of a different
 * staging. Requires the real functions (CLAUDE.md §15).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hasNamedDifferentDirectorSignal, setMultiProdGuardShows, applyTemporalOverrides } = require('./review-guards.js');
const { buildPriorProductionDirectors } = require('./prior-run-sibling.js');

const odc2011 = {
  id: 'other-desert-cities-2011', title: 'Other Desert Cities', category: 'broadway',
  previewsStartDate: '2011-10-12', openingDate: '2011-11-03', closingDate: '2012-06-17',
  creativeTeam: [{ name: 'Joe Mantello', role: 'Director' }],
};
const odc2026 = {
  id: 'other-desert-cities-2026', title: 'Other Desert Cities', category: 'broadway',
  previewsStartDate: '2026-09-29', openingDate: '2026-10-18', closingDate: '2027-01-17',
  creativeTeam: [{ name: 'John Benjamin Hickey', role: 'Director' }],
};
// Same-title staging running concurrently with odc2026: could really be the subject.
const odcConcurrent = {
  id: 'other-desert-cities-west-end-2026', title: 'Other Desert Cities', category: 'west-end',
  openingDate: '2026-09-01', closingDate: '2026-11-30',
  creativeTeam: [{ name: 'Lindsay Posner', role: 'Director' }],
};
const SHOWS = [odc2011, odc2026, odcConcurrent];
setMultiProdGuardShows(SHOWS);

const revivalText = 'When it opened in 2011, Joe Mantello directed Stockard Channing. '
  + 'This revival, staged by John Benjamin Hickey, stars Julia Louis-Dreyfus and Ed Harris. ' + 'x'.repeat(1500);

test('buildPriorProductionDirectors maps only earlier, closed productions', () => {
  const m = buildPriorProductionDirectors(SHOWS, r => /^director$/i.test(r));
  assert.equal(m['other-desert-cities-2026'].get('joe mantello'), 'other-desert-cities-2011');
  assert.equal(m['other-desert-cities-2026'].has('lindsay posner'), false, 'concurrent staging never counts');
  assert.equal(m['other-desert-cities-2011'], undefined, 'nothing is earlier than the original');
});

test('CV naming the earlier production director does not bypass when the text names the current director', () => {
  const r = 'The review discusses the production directed by Joe Mantello at the Booth Theatre.';
  assert.equal(hasNamedDifferentDirectorSignal([], r, odc2026, revivalText), false);
});

test('the opening-week override then downgrades the flag', () => {
  const out = applyTemporalOverrides(true, false, 'high', odc2026.openingDate, '2026-10-19', {
    issues: [], reasoning: 'Appears to review the staging directed by Joe Mantello.', show: odc2026, fullText: revivalText,
  });
  assert.equal(out.wpConfidence, 'low');
  assert.equal(out.bypassedForStrongSignal, false);
});

test('a misdated old review that never names the current director keeps the bypass', () => {
  const oldText = 'Joe Mantello directs Stockard Channing and Stacy Keach at the Booth. ' + 'x'.repeat(1500);
  assert.equal(hasNamedDifferentDirectorSignal([], 'This review is directed by Joe Mantello.', odc2026, oldText), true);
});

test('a concurrent same-title staging director keeps the bypass', () => {
  assert.equal(hasNamedDifferentDirectorSignal([], 'A production directed by Lindsay Posner in London.', odc2026, revivalText), true);
});

test('a director from no known production keeps the bypass (Hamlet FRC class)', () => {
  assert.equal(hasNamedDifferentDirectorSignal([], 'Teatro La Plaza staging directed by Chela De Ferrari.', odc2026, revivalText), true);
});

test('a show missing from the shows list behaves as before', () => {
  const unknown = { ...odc2026, id: 'not-in-shows-2026' };
  assert.equal(hasNamedDifferentDirectorSignal([], 'The production directed by Joe Mantello.', unknown, revivalText), true);
});

test('a prior director who also leads a production still running is not historical', () => {
  const tour = {
    id: 'other-desert-cities-tour-2026', title: 'Other Desert Cities', category: 'tour',
    openingDate: '2026-08-01', closingDate: null,
    creativeTeam: [{ name: 'Joe Mantello', role: 'Director' }],
  };
  const m = buildPriorProductionDirectors([odc2011, odc2026, tour], r => /^director$/i.test(r));
  assert.equal(m['other-desert-cities-2026'], undefined);
});

test('non-stage director credits of a prior production do not count', () => {
  const prior = { ...odc2011, creativeTeam: [{ name: 'Joe Mantello', role: 'Director' }, { name: 'Pat Gold', role: 'Music Director' }] };
  setMultiProdGuardShows([prior, odc2026]);
  try {
    assert.equal(hasNamedDifferentDirectorSignal([], 'The staging directed by Pat Gold.', odc2026, revivalText), true);
  } finally {
    setMultiProdGuardShows(SHOWS);
  }
});

test('the current director must be named in full, not by surname alone', () => {
  const surnameOnly = 'Joe Mantello staged it in 2011. Hickey keeps it moving now. ' + 'x'.repeat(1500);
  assert.equal(hasNamedDifferentDirectorSignal([], 'The production directed by Joe Mantello.', odc2026, surnameOnly), true);
});
