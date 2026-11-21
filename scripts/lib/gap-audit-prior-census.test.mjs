// LIVE-DATA-LANE: reads data/audit/show-review-gap.json (read by the test). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { priorCensusUrls } = require('./gap-audit-merge.js');

test('BRO-5516: prior census candidate URLs are carried when the census is skipped', () => {
  const row = { censusVerdict: { candidates: [
    { url: 'https://a.com/r1' }, { url: 'https://a.com/r1' }, { url: 'https://b.com/r2' }, { url: '' }, { url: 'not-a-url' }, null,
  ] } };
  assert.deepEqual(priorCensusUrls(row), ['https://a.com/r1', 'https://b.com/r2']);
});

test('BRO-5516: absent / malformed prior rows yield nothing', () => {
  assert.deepEqual(priorCensusUrls(undefined), []);
  assert.deepEqual(priorCensusUrls({}), []);
  assert.deepEqual(priorCensusUrls({ censusVerdict: { candidates: 'x' } }), []);
});

test('BRO-5516: real audit rows carry their census (sting-west-end-2026 had 3 live)', async () => {
  const fs = require('node:fs');
  if (!fs.existsSync('data/audit/show-review-gap.json')) return;
  const a = JSON.parse(fs.readFileSync('data/audit/show-review-gap.json', 'utf8'));
  const withCensus = a.results.filter(r => priorCensusUrls(r).length > 0);
  assert.ok(withCensus.length > 100);
});

test('BRO-5516: prior URLs are unioned into a census that already ran (SERP variance cannot drop candidates)', () => {
  const { seedPriorCensusUrls } = require('./gap-audit-merge.js');
  const target = new Set(['https://a.com/new']);          // this run's SERP pass found only this
  const n = seedPriorCensusUrls(target, ['https://a.com/old', 'https://b.com/stale'], (u) => (u.includes('stale') ? null : u));
  assert.equal(n, 1);
  assert.deepEqual([...target].sort(), ['https://a.com/new', 'https://a.com/old']);
  assert.equal(seedPriorCensusUrls(new Set(), undefined, (u) => u), 0);
});

test('BRO-5516: isRiskyGapChange bounds candidate-only SERP variance', () => {
  const { isRiskyGapChange } = require('./gap-audit-merge.js');
  assert.equal(isRiskyGapChange('incomplete:2:9', 'incomplete:2:8'), false); // bodyguard 2026-10-24
  assert.equal(isRiskyGapChange('incomplete:2:9', 'incomplete:2:7'), false); // 2 lost within 25%
  assert.equal(isRiskyGapChange('complete:3:3', 'no-census-yet:0:0'), true); // dead census
  assert.equal(isRiskyGapChange('incomplete:1:3', 'incomplete:1:2'), false); // small census stays nonzero
  assert.equal(isRiskyGapChange('incomplete:5:9', 'incomplete:4:9'), true);  // live loss always risky
});

test('BRO-7561: candidate drops against baselines older than 7 days are discounted (2026-11-15 five-show shape)', () => {
  const { riskStateMap, isRiskyGapChange } = require('./gap-audit-merge.js');
  const mk = (live, cand, computedAt) => ({ showId: 's', computedAt, censusVerdict: { verdict: 'incomplete', liveCount: live, candidateCount: cand, censusSchema: require('./gap-audit-merge.js').CENSUS_SCHEMA, candidates: [] } });
  const now = '2026-11-15T05:09:00Z';
  const old = '2026-10-31T05:00:00Z', fresh = '2026-11-14T05:00:00Z';
  const prevOf = (live, cand, at) => riskStateMap([mk(live, cand, at)], { now }).s;
  // 2- and 4-candidate shows from 2026-10-31: zero tolerance before, candidate-only drop now fine
  assert.equal(isRiskyGapChange(prevOf(1, 2, old), 'incomplete:1:1'), false);
  assert.equal(isRiskyGapChange(prevOf(2, 4, old), 'incomplete:2:3'), false);
  // the same bounded drop is also tolerated on a fresh baseline
  assert.equal(isRiskyGapChange(prevOf(1, 2, fresh), 'incomplete:1:1'), false);
  // live loss against an old baseline stays risky; dead census too
  assert.equal(isRiskyGapChange(prevOf(2, 4, old), 'incomplete:1:4'), true);
  assert.equal(isRiskyGapChange(prevOf(3, 3, old), 'no-census-yet:0:0'), true);
  // missing computedAt is never aged
  assert.equal(isRiskyGapChange(prevOf(1, 2, undefined), 'incomplete:1:1'), false);
  // bounded: dead-provider shapes on aged baselines stay risky
  assert.equal(isRiskyGapChange(prevOf(2, 9, old), 'complete:2:2'), true);
  assert.equal(isRiskyGapChange(prevOf(0, 5, old), 'no-census-yet:0:0'), true);
  const q = { ...mk(1, 2, old), quarantine: { nextState: 'x' } };
  assert.equal(isRiskyGapChange(riskStateMap([q], { now }).s, 'incomplete:1:1'), false);
});

test('fresh candidate-only churn is bounded and preserves live coverage', () => {
  const { riskStateMap, isRiskyGapChange, CENSUS_SCHEMA } = require('./gap-audit-merge.js');
  const row = (showId, liveCount, candidateCount) => ({ showId, computedAt: '2026-11-17T20:00:00Z', censusVerdict: { verdict: 'incomplete', liveCount, candidateCount, censusSchema: CENSUS_SCHEMA, candidates: [] } });
  const cases = [
    [row('coal-country-off-broadway-2022', 6, 12), 'incomplete:6:7', true],
    [row('the-wash-regional-2026', 0, 4), 'complete:2:2', true],
    [row('fresh-churn', 2, 8), 'incomplete:2:6', false],
    [row('fresh-small', 1, 2), 'incomplete:1:1', false],
    [row('live-loss', 5, 8), 'incomplete:4:7', false],
    [row('unexplained-live-loss', 5, 8), 'incomplete:4:8', true],
    [row('zero', 0, 1), 'no-census-yet:0:0', true],
  ];
  for (const [previous, next, expected] of cases) {
    const state = riskStateMap([previous], { now: '2026-11-17T23:00:00Z' })[previous.showId];
    assert.equal(isRiskyGapChange(state, next), expected, previous.showId);
  }
});
