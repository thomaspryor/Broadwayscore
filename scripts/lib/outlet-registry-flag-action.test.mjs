import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyOutletRegistryFlag } = require('./outlet-registry-flag-action.js');
const { evaluateStandingCoverage } = require('../audit-standing-coverage.js');

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
      full: { tier: 2 },
      half: { tier: 2, standingCoverage: true, standingMarkets: ['broadway'] },
      gone: { tier: 2, standingCoverage: true, standingMarkets: ['broadway'] },
      ...over,
    },
  };
}

const ctx = () => ({ ...fixture(), nowMs: NOW });
const act = (outletId, value) => ({ type: 'outlet-registry-flag', outletId, flag: 'standingCoverage', value, reason: 'audit lists it' });

test('fixture drives the real audit: full promotes, gone demotes, half is neither', () => {
  const { shows, reviews } = fixture();
  const a = evaluateStandingCoverage(shows, reviews, registry().outlets, NOW);
  assert.deepEqual(a.promote, ['full']);
  assert.deepEqual(a.demote, ['gone']);
});

test('promote applies the flag, standingMarkets and metadata when the audit lists it', () => {
  const reg = registry();
  const r = applyOutletRegistryFlag(reg, act('full', true), ctx());
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(reg.outlets.full.standingCoverage, true);
  assert.deepEqual(reg.outlets.full.standingMarkets, ['broadway']);
  assert.equal(reg._meta.lastUpdated, new Date(NOW).toISOString());
  assert.match(reg._meta.lastChange, /BRO-6122.*promote full/);
});

test('demote removes both fields', () => {
  const reg = registry();
  const r = applyOutletRegistryFlag(reg, act('gone', false), ctx());
  assert.equal(r.ok, true);
  assert.equal('standingCoverage' in reg.outlets.gone, false);
  assert.equal('standingMarkets' in reg.outlets.gone, false);
});

test('refuses when the audit does not agree (promote a non-qualifier, demote a healthy flagged outlet)', () => {
  const reg = registry({ other: { tier: 2 } });
  const p = applyOutletRegistryFlag(reg, act('other', true), ctx());
  assert.equal(p.ok, false);
  assert.match(p.reason, /does not list it for promote/);
  const d = applyOutletRegistryFlag(reg, act('half', false), ctx());
  assert.equal(d.ok, false);
  assert.match(d.reason, /does not list it for demote/);
  assert.equal(reg.outlets.other.standingCoverage, undefined);
  assert.equal(reg.outlets.half.standingCoverage, true);
});

test('already at the target value is an ok no-op (re-dispatch / race)', () => {
  const reg = registry();
  const r = applyOutletRegistryFlag(reg, act('half', true), ctx());
  assert.deepEqual([r.ok, r.changed], [true, false]);
  const again = applyOutletRegistryFlag(reg, act('full', false), ctx());
  assert.deepEqual([again.ok, again.changed], [true, false]);
  assert.equal(reg._meta.lastUpdated, 'x');
});

test('refuses unknown outlet, other flags, non-boolean value, missing reason', () => {
  const reg = registry();
  assert.match(applyOutletRegistryFlag(reg, act('nope', true), ctx()).reason, /not in outlet-registry/);
  assert.match(applyOutletRegistryFlag(reg, { ...act('full', true), flag: 'tier' }, ctx()).reason, /unsupported flag/);
  assert.match(applyOutletRegistryFlag(reg, { ...act('full', true), value: 'true' }, ctx()).reason, /true or false/);
  assert.match(applyOutletRegistryFlag(reg, { ...act('full', true), reason: 'x' }, ctx()).reason, /reason/);
  assert.match(applyOutletRegistryFlag(reg, { ...act('../x', true) }, ctx()).reason, /malformed/);
});

test('refuses on stub shows or stub reviews (no evidence must never demote)', () => {
  const reg = registry();
  const { shows, reviews } = fixture();
  assert.match(applyOutletRegistryFlag(reg, act('gone', false), { shows: shows.slice(0, 20), reviews, nowMs: NOW }).reason, /stub/);
  assert.match(applyOutletRegistryFlag(reg, act('gone', false), { shows, reviews: reviews.slice(0, 50), nowMs: NOW }).reason, /stub/);
  assert.equal(reg.outlets.gone.standingCoverage, true);
});

test('flagged outlet missing standingMarkets is repaired; a non-boolean flag is refused', () => {
  const reg = registry({ nomarkets: { tier: 2, standingCoverage: true }, bad: { tier: 2, standingCoverage: 'false' } });
  const r = applyOutletRegistryFlag(reg, act('nomarkets', true), ctx());
  assert.deepEqual([r.ok, r.changed], [true, true]);
  assert.deepEqual(reg.outlets.nomarkets.standingMarkets, ['broadway']);
  const b = applyOutletRegistryFlag(reg, act('bad', true), ctx());
  assert.equal(b.ok, false);
  assert.match(b.reason, /not a boolean/);
});
