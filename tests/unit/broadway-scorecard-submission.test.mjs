/**
 * BRO-3086: Spellbound (OB, OvationTix-only) closed 2026-09-06 but stayed
 * `open` until a reader submitted feedback. Covers (1) the detector blind-spot
 * report and (2) the field-scope guard for feedback-driven closure edits,
 * including the real Spellbound edit in data repo commit 64fe8e919.
 *
 * Run: node --test tests/unit/broadway-scorecard-submission.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findUnmonitoredOpenShows } = require('../../scripts/lib/ob-closing-detector.js');
const { obClosingBacklogResults } = require('../../scripts/health-check.js');
const { checkFieldChangeScope } = require('../../scripts/lib/show-field-change-guard.js');

const TODAY = '2026-09-08';
const spellbound = {
  id: 'spellbound-off-broadway-2026', category: 'off-broadway', status: 'open',
  openingDate: '2026-08-19', closingDate: null,
  ticketLinks: [{ platform: 'OvationTix', url: 'https://ci.ovationtix.com/35583/production/1279605' }],
};
const none = () => false;

test('Spellbound-class show (no TodayTix, no texts, no closingDate) is reported', () => {
  const r = findUnmonitoredOpenShows([spellbound], none, TODAY);
  assert.equal(r.length, 1);
  assert.equal(r[0].showId, spellbound.id);
  assert.equal(r[0].daysOpen, 20);
  assert.deepEqual(r[0].ticketPlatforms, ['OvationTix']);
});

test('shows a signal can see are not reported', () => {
  assert.equal(findUnmonitoredOpenShows([{ ...spellbound, todaytixId: 123 }], none, TODAY).length, 0);
  assert.equal(findUnmonitoredOpenShows([spellbound], () => true, TODAY).length, 0);
  assert.equal(findUnmonitoredOpenShows([{ ...spellbound, closingDate: '2026-09-20' }], none, TODAY).length, 0);
  assert.equal(findUnmonitoredOpenShows([{ ...spellbound, status: 'closed' }], none, TODAY).length, 0);
});

test('brand-new shows are inside the grace window; missing openingDate is skipped', () => {
  assert.equal(findUnmonitoredOpenShows([{ ...spellbound, openingDate: '2026-09-04' }], none, TODAY).length, 0);
  assert.equal(findUnmonitoredOpenShows([{ ...spellbound, openingDate: null }], none, TODAY).length, 0);
});

test('the real Spellbound closure edit stays within status/closingDate', () => {
  const after = { ...spellbound, status: 'closed', closingDate: '2026-09-06' };
  const r = checkFieldChangeScope(spellbound, after);
  assert.equal(r.ok, true);
  assert.deepEqual(r.changed.sort(), ['closingDate', 'status']);
});

test('an edit touching any other field is rejected', () => {
  const after = { ...spellbound, status: 'closed', closingDate: '2026-09-06', venue: 'Elsewhere' };
  const r = checkFieldChangeScope(spellbound, after);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unexpected, ['venue']);
});

test('TodayTix-listed show whose staleness signal is ignored is still reported', () => {
  const r = findUnmonitoredOpenShows([{ ...spellbound, todaytixId: 1, todaytixStalenessIgnore: true }], none, TODAY);
  assert.equal(r.length, 1);
});

test('digest surfaces blind spots even with zero candidates', () => {
  const report = {
    reviewTextSweep: { candidates: [] }, todaytixStaleness: { candidates: [] },
    unmonitoredOpenShows: findUnmonitoredOpenShows([spellbound], none, TODAY),
  };
  const out = obClosingBacklogResults(report);
  assert.equal(out.length, 1);
  assert.match(out[0].message, /spellbound-off-broadway-2026/);
  assert.deepEqual(obClosingBacklogResults({ ...report, unmonitoredOpenShows: [] }), []);
});
