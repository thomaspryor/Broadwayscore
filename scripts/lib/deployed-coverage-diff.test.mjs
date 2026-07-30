import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  diffShow, summarize, deployedOutletIds, deployedShowUrl, severityRank, CS_TOLERANCE,
} = require('./deployed-coverage-diff.js');

// A realistic deployed payload: outlet DISPLAY NAMES in `o`, no outletId.
const prodJson = (outlets, cs) => ({
  id: 's', cs, rc: outlets.length,
  rv: outlets.map((o) => ({ cn: 'Critic', o, s: 80, b: 'Positive', t: 1, u: 'u', d: '2026-07-01' })),
});

test('deployedOutletIds derives ids from display names (public JSON has no outletId)', () => {
  const ids = deployedOutletIds(prodJson(['The New York Times', 'Time Out New York'], 90));
  assert.ok(ids.has('nytimes'), `expected nytimes, got ${[...ids]}`);
  assert.equal(ids.size, 2);
  assert.equal(deployedOutletIds(null).size, 0, 'null payload → empty, no throw');
  assert.equal(deployedOutletIds({ rv: [null, {}] }).size, 0, 'junk rows skipped');
});

test('clean show: everything scored locally is live on prod and cs agrees', () => {
  const r = diffShow({
    showId: 's', localScoredOutletIds: ['nytimes', 'vulture'], localCs: 88.5,
    deployedJson: prodJson(['The New York Times', 'Vulture'], 88.5),
  });
  assert.equal(r.ok, true, JSON.stringify(r.defects));
  assert.deepEqual(r.defects, []);
  assert.equal(r.localCount, 2);
  assert.equal(r.deployedCount, 2);
});

// --- THE acceptance case from the plan: a killed/stale deploy must surface -----

test('stale deploy (prod payload predates the new reviews) surfaces as missing-from-prod', () => {
  // Local has 4 scored outlets; production still serves the 2-review build that
  // was live before the deploy got cancel-cascaded.
  const r = diffShow({
    showId: 'broad-strokes-off-broadway-2026', title: 'Broad Strokes',
    localScoredOutletIds: ['nytimes', 'vulture', 'timeout', 'theatermania'],
    localCs: 74.2,
    deployedJson: prodJson(['Vulture', 'TheaterMania'], 74.2),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missingFromProd, ['nytimes', 'timeout']);
  assert.equal(r.defects.length, 1);
  assert.equal(r.defects[0].type, 'missing-from-prod');
  assert.match(r.defects[0].detail, /nytimes, timeout/);
});

test('killed deploy (page never published) surfaces as unreachable, NOT as N missing outlets', () => {
  const r = diffShow({
    showId: 'brand-new-show-2026',
    localScoredOutletIds: ['nytimes', 'vulture', 'timeout'],
    localCs: 80, deployedJson: null, fetchError: 'HTTP 404',
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.defects, [{ type: 'unreachable', detail: 'HTTP 404' }]);
  assert.deepEqual(r.missingFromProd, [], 'one 404 must not report 3 phantom missing outlets');
  assert.equal(r.deployedCount, null);
});

test('score-drift: deployed cs differs beyond tolerance; float noise inside it does not', () => {
  const drifted = diffShow({
    showId: 's', localScoredOutletIds: ['nytimes'], localCs: 91.71,
    deployedJson: prodJson(['The New York Times'], 87.4),
  });
  assert.equal(drifted.ok, false);
  assert.deepEqual(drifted.defects.map(d => d.type), ['score-drift']);
  assert.match(drifted.defects[0].detail, /87\.4.*91\.71/);

  const noise = diffShow({
    showId: 's', localScoredOutletIds: ['nytimes'], localCs: 91.71,
    deployedJson: prodJson(['The New York Times'], 91.71 + CS_TOLERANCE / 2),
  });
  assert.equal(noise.ok, true, 'sub-tolerance float noise must not page anyone');
});

test('deployed payload with reviews but NO numeric cs is a build defect, not silence', () => {
  const r = diffShow({
    showId: 's', localScoredOutletIds: ['nytimes'], localCs: 91.71,
    deployedJson: { id: 's', rv: [{ o: 'The New York Times' }] },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.defects.map(d => d.type), ['score-drift']);
  assert.match(r.defects[0].detail, /no numeric cs/);
});

test('a show with no local score is not judged on cs (nothing to compare)', () => {
  const r = diffShow({
    showId: 's', localScoredOutletIds: [], localCs: null,
    deployedJson: { id: 's', rv: [] },
  });
  assert.equal(r.ok, true, 'unopened/unscored show is not a prod defect');
});

test('both defect classes can co-occur on one show', () => {
  const r = diffShow({
    showId: 's', localScoredOutletIds: ['nytimes', 'vulture'], localCs: 90,
    deployedJson: prodJson(['Vulture'], 70),
  });
  assert.deepEqual(r.defects.map(d => d.type).sort(), ['missing-from-prod', 'score-drift']);
});

// --- report roll-up ---------------------------------------------------------

test('summarize counts by type and ranks unreachable above missing above drift', () => {
  const rows = [
    diffShow({ showId: 'ok', localScoredOutletIds: ['nytimes'], localCs: 80, deployedJson: prodJson(['The New York Times'], 80) }),
    diffShow({ showId: 'drift', localScoredOutletIds: ['nytimes'], localCs: 80, deployedJson: prodJson(['The New York Times'], 60) }),
    diffShow({ showId: 'gone', localScoredOutletIds: ['nytimes'], localCs: 80, deployedJson: null, fetchError: '404' }),
    diffShow({ showId: 'partial', localScoredOutletIds: ['nytimes', 'vulture'], localCs: 80, deployedJson: prodJson(['Vulture'], 80) }),
  ];
  const s = summarize(rows);
  assert.equal(s.checked, 4);
  assert.equal(s.clean, 1);
  assert.equal(s.defective, 3);
  assert.deepEqual(s.byType, { 'score-drift': 1, unreachable: 1, 'missing-from-prod': 1 });
  assert.deepEqual(s.shows.map(r => r.showId), ['gone', 'partial', 'drift'], 'worst first');
});

test('summarize on an all-clean corpus reports zero defects, no throw', () => {
  const s = summarize([]);
  assert.deepEqual(s, { checked: 0, clean: 0, defective: 0, byType: {}, shows: [] });
});

test('severityRank + deployedShowUrl are stable contracts', () => {
  assert.equal(severityRank({ defects: [{ type: 'unreachable' }] }), 3);
  assert.equal(severityRank({ defects: [{ type: 'missing-from-prod' }] }), 2);
  assert.equal(severityRank({ defects: [{ type: 'score-drift' }] }), 1);
  assert.equal(deployedShowUrl('hamilton-2015'), 'https://broadwayscorecard.com/data/shows/hamilton-2015.json');
  assert.equal(deployedShowUrl('x', 'https://staging.example'), 'https://staging.example/data/shows/x.json');
});
