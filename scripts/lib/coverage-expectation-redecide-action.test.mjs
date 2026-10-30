import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyCoverageExpectationRedecide } = require('./coverage-expectation-redecide-action.js');
const { evaluateCoverageExpectationDrift } = require('../audit-standing-coverage.js');

const NOW = Date.parse('2026-10-24T12:00:00Z');
const DAY = 86400000;

// 3 trailing seasons x 10 Broadway shows, each with 5 filler outlets of press.
// `full` covers every show, `gone` covers none, `half` covers 80% (between the demote and promote bars).
function fixture() {
  const shows = [];
  const reviews = [];
  for (let season = 0; season < 3; season++) {
    for (let i = 0; i < 10; i++) {
      const id = `s${season}-${i}`;
      shows.push({ id, category: 'broadway', openingDate: new Date(NOW - season * 365 * DAY - (30 + i) * DAY).toISOString().slice(0, 10) });
      for (let f = 0; f < 5; f++) reviews.push({ showId: id, outletId: `filler${f}` });
      reviews.push({ showId: id, outletId: 'noise' });
      if (i % 5 !== 0) reviews.push({ showId: id, outletId: 'half' });
      reviews.push({ showId: id, outletId: 'full' });
    }
  }
  for (let i = 0; shows.length < 150; i++) shows.push({ id: `pad-${i}`, category: 'off-broadway' });
  for (let i = 0; reviews.length < 1200; i++) reviews.push({ showId: `pad-${i % 50}`, outletId: 'noise' });
  return { shows, reviews };
}

function registry(over = {}) {
  return {
    _meta: { lastUpdated: 'x', lastChange: 'y' },
    outlets: {
      full: { tier: 2, coverageExpectation: 'reviews', coverageExpectationDecidedAt: '2026-10-01', coverageEvidence: 'old.' },
      fresh: { tier: 2, coverageExpectation: 'reviews', coverageExpectationDecidedAt: '2026-10-20' },
      gone: { tier: 2, coverageExpectation: 'none', coverageExpectationDecidedAt: '2026-10-01' },
      nodata: { tier: 2, coverageExpectation: 'reviews', coverageExpectationDecidedAt: '2026-10-01' },
      plain: { tier: 2 },
      ...over,
    },
  };
}

const ctx = () => ({ ...fixture(), nowMs: NOW });
const act = (outletId) => ({ type: 'coverage-expectation-redecide', outletId, reason: 'drift card refresh' });

test('decayed reviews claim: stamps today, appends measured rate, keeps the claim', () => {
  const reg = registry();
  const r = applyCoverageExpectationRedecide(reg, act('full'), ctx());
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(reg.outlets.full.coverageExpectation, 'reviews');
  assert.equal(reg.outlets.full.coverageExpectationDecidedAt, '2026-10-24');
  assert.match(reg.outlets.full.coverageEvidence, /^old\. Re-probed 2026-10-24 .*measured 100\.0% overall/);
  assert.match(reg._meta.lastChange, /BRO-6610.*full/);
});

test('the refreshed claim no longer drifts (same predicate as the health check)', () => {
  const reg = registry();
  applyCoverageExpectationRedecide(reg, act('full'), ctx());
  const { shows, reviews } = fixture();
  const d = evaluateCoverageExpectationDrift(shows, reviews, reg.outlets, NOW);
  assert.equal(d.needsReprobe.includes('full'), false);
});

test('active claim is an ok no-op (re-dispatch / race)', () => {
  const reg = registry();
  const r = applyCoverageExpectationRedecide(reg, act('fresh'), ctx());
  assert.deepEqual([r.ok, r.changed], [true, false]);
  assert.equal(reg._meta.lastUpdated, 'x');
});

test('refuses a no-review claim, an outlet with no claim, and unknown or malformed ids', () => {
  const reg = registry();
  assert.match(applyCoverageExpectationRedecide(reg, act('gone'), ctx()).reason, /human re-decision/);
  assert.match(applyCoverageExpectationRedecide(reg, act('plain'), ctx()).reason, /human re-decision/);
  assert.match(applyCoverageExpectationRedecide(reg, act('nope'), ctx()).reason, /not in outlet-registry/);
  assert.match(applyCoverageExpectationRedecide(reg, act('../x'), ctx()).reason, /malformed/);
  assert.match(applyCoverageExpectationRedecide(reg, { ...act('full'), reason: 'x' }, ctx()).reason, /reason/);
  assert.equal(reg.outlets.full.coverageExpectationDecidedAt, '2026-10-01');
});

test('refuses on stub inputs', () => {
  const reg = registry();
  assert.match(applyCoverageExpectationRedecide(reg, act('full'), { shows: [], reviews: [], nowMs: NOW }).reason, /stub/);
});
