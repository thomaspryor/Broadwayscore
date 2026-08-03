// Coverage Verdict S2 (task #906) scope item 4 — the warn-only stateless
// candidate report. Proves the monitor covers the producer's output: a URL the
// gap audit knows about but the verdict left unstated is a finding, while every
// fail-open path (no verdict yet, no openingDate, out of window) is silent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  auditShowCandidates,
  windowStatus,
  reportStatelessCandidates,
  knownUrlsFor,
} = require('../../scripts/lib/stateless-candidates.js');

const NOW = '2026-08-03T00:00:00.000Z';

function result(overrides = {}) {
  return {
    showId: 'a-show',
    openingDate: '2026-07-25',
    aggregatorListedUrls: [],
    missing: [],
    flaggedMisses: [],
    citedNoUrl: [],
    ...overrides,
  };
}

test('knownUrlsFor unions listed + missing + flagged URLs and drops blanks', () => {
  const urls = knownUrlsFor(result({
    aggregatorListedUrls: ['https://a.com/1', 'https://a.com/1', ''],
    missing: [{ url: 'https://b.com/2' }, { url: '' }, {}],
    flaggedMisses: [{ url: 'https://c.com/3' }],
  }));
  assert.deepEqual([...urls].sort(), ['https://a.com/1', 'https://b.com/2', 'https://c.com/3']);
});

test('every known URL stated -> no finding', () => {
  const a = auditShowCandidates(result({
    aggregatorListedUrls: ['https://a.com/1'],
    missing: [{ url: 'https://b.com/2' }],
    censusVerdict: {
      verdict: 'incomplete',
      candidates: [
        { url: 'https://a.com/1', outletId: 'a.com', state: 'live' },
        { url: 'https://b.com/2', outletId: 'b-outlet', state: 'GAP' },
      ],
    },
  }));
  assert.equal(a.statelessUrls.length, 0);
  assert.equal(a.unknownStates.length, 0);
  assert.equal(a.statedCount, 2);
  assert.equal(a.knownCount, 2);
});

test('a known URL with no candidate row is stateless', () => {
  const a = auditShowCandidates(result({
    aggregatorListedUrls: ['https://a.com/1', 'https://orphan.com/9'],
    censusVerdict: { verdict: 'complete', candidates: [{ url: 'https://a.com/1', outletId: 'a.com', state: 'live' }] },
  }));
  assert.deepEqual(a.statelessUrls, ['https://orphan.com/9']);
});

test('a candidate carrying an unrecognized state does NOT cover its URL', () => {
  const a = auditShowCandidates(result({
    aggregatorListedUrls: ['https://a.com/1'],
    censusVerdict: { verdict: 'incomplete', candidates: [{ url: 'https://a.com/1', outletId: 'a.com', state: 'WAT' }] },
  }));
  assert.equal(a.unknownStates.length, 1);
  assert.deepEqual(a.statelessUrls, ['https://a.com/1']);
});

test('citedNoUrl outlets are matched by outletId, not URL', () => {
  const covered = auditShowCandidates(result({
    citedNoUrl: [{ outletId: 'the-stage' }],
    censusVerdict: { verdict: 'incomplete', candidates: [{ url: '', outletId: 'the-stage', state: 'IN_FLIGHT' }] },
  }));
  assert.deepEqual(covered.statelessOutlets, []);
  const orphan = auditShowCandidates(result({
    citedNoUrl: [{ outletId: 'the-stage' }],
    censusVerdict: { verdict: 'incomplete', candidates: [] },
  }));
  assert.deepEqual(orphan.statelessOutlets, ['the-stage']);
});

test('fail-open: a show with no censusVerdict yields zero findings', () => {
  const a = auditShowCandidates(result({ aggregatorListedUrls: ['https://a.com/1', 'https://b.com/2'] }));
  assert.equal(a.hasVerdict, false);
  assert.deepEqual(a.statelessUrls, []);
  assert.deepEqual(a.statelessOutlets, []);
});

test('windowStatus: recent in, old out, future out, undated explicit', () => {
  assert.equal(windowStatus(result({ openingDate: '2026-07-25' }), { now: NOW, windowDays: 30 }), 'in-window');
  assert.equal(windowStatus(result({ openingDate: '2026-01-01' }), { now: NOW, windowDays: 30 }), 'out-of-window');
  assert.equal(windowStatus(result({ openingDate: '2026-09-01' }), { now: NOW, windowDays: 30 }), 'out-of-window');
  assert.equal(windowStatus(result({ openingDate: null }), { now: NOW, windowDays: 30 }), 'unknown-date');
  assert.equal(windowStatus(result({ openingDate: 'not a date' }), { now: NOW, windowDays: 30 }), 'unknown-date');
});

test('report: only in-window shows are examined; undated shows are surfaced, not dropped', () => {
  const rep = reportStatelessCandidates([
    result({ showId: 'recent-gap', aggregatorListedUrls: ['https://a.com/1'], censusVerdict: { verdict: 'complete', candidates: [] } }),
    result({ showId: 'old-show', openingDate: '2025-01-01', aggregatorListedUrls: ['https://a.com/1'], censusVerdict: { verdict: 'complete', candidates: [] } }),
    result({ showId: 'undated', openingDate: null, aggregatorListedUrls: ['https://a.com/1'] }),
    result({ showId: 'no-verdict-yet', aggregatorListedUrls: ['https://a.com/1'] }),
    null,
    { title: 'no id' },
  ], { now: NOW, windowDays: 30 });

  // in-window only: recent-gap + no-verdict-yet. old-show is out of window,
  // undated never enters the window, junk rows are skipped.
  assert.equal(rep.examined, 2);
  assert.deepEqual(rep.findings.map((f) => f.showId), ['recent-gap']);
  assert.deepEqual(rep.noVerdict.map((s) => s.showId), ['no-verdict-yet']);
  assert.deepEqual(rep.unknownDate.map((s) => s.showId), ['undated']);
  assert.deepEqual(rep.totals, { shows: 1, statelessUrls: 1, statelessOutlets: 0, unknownStates: 0 });
});

test('report is silent when everything in window is stated', () => {
  const rep = reportStatelessCandidates([
    result({
      showId: 'clean',
      aggregatorListedUrls: ['https://a.com/1'],
      censusVerdict: { verdict: 'complete', candidates: [{ url: 'https://a.com/1', outletId: 'a.com', state: 'live' }] },
    }),
  ], { now: NOW, windowDays: 30 });
  assert.equal(rep.findings.length, 0);
  assert.equal(rep.totals.statelessUrls, 0);
});

test('malformed input never throws', () => {
  assert.doesNotThrow(() => reportStatelessCandidates(null, { now: NOW }));
  assert.doesNotThrow(() => reportStatelessCandidates(undefined, {}));
  assert.doesNotThrow(() => auditShowCandidates(null));
  assert.doesNotThrow(() => auditShowCandidates({ showId: 'x', censusVerdict: { candidates: [null, 'junk', {}] } }));
});
