import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  marketTermFor,
  buildCensusQuery,
  shouldRunSerpCensus,
  DEFAULT_COOLDOWN_HOURS,
} = require('./serp-review-census.js');

const NOW = Date.parse('2026-07-23T12:00:00Z');
const HOUR = 3600000;

test('marketTermFor picks the right phrase per market', () => {
  assert.equal(marketTermFor({ category: 'west-end' }), 'West End review');
  assert.equal(marketTermFor({ category: 'off-west-end' }), 'West End review');
  assert.equal(marketTermFor({ category: 'off-broadway' }), 'Off-Broadway review');
  assert.equal(marketTermFor({ category: 'broadway' }), 'Broadway review');
  assert.equal(marketTermFor({}), 'Broadway review');
});

test('buildCensusQuery builds an outlet-agnostic title+market+year query', () => {
  const show = { title: 'Trainspotting the Musical', category: 'west-end', openingDate: '2026-07-01' };
  assert.equal(buildCensusQuery(show), '"Trainspotting the Musical" West End review 2026');
});

test('buildCensusQuery sanitizes & and tolerates a missing openingDate', () => {
  const show = { title: 'Fun & Games', category: 'broadway' };
  assert.equal(buildCensusQuery(show), '"Fun and Games" Broadway review');
});

test('buildCensusQuery returns null without a title', () => {
  assert.equal(buildCensusQuery(null), null);
  assert.equal(buildCensusQuery({ category: 'broadway' }), null);
});

test('shouldRunSerpCensus: out-of-window show never runs regardless of cooldown', () => {
  assert.equal(shouldRunSerpCensus({ inWindow: false, lastRunAt: null, now: NOW }), false);
});

test('shouldRunSerpCensus: in-window + never run → runs', () => {
  assert.equal(shouldRunSerpCensus({ inWindow: true, lastRunAt: null, now: NOW }), true);
});

test('shouldRunSerpCensus: in-window but within cooldown → skipped', () => {
  const lastRunAt = new Date(NOW - 2 * HOUR).toISOString();
  assert.equal(shouldRunSerpCensus({ inWindow: true, lastRunAt, now: NOW }), false);
});

test('shouldRunSerpCensus: in-window and cooldown elapsed → runs', () => {
  const lastRunAt = new Date(NOW - (DEFAULT_COOLDOWN_HOURS + 1) * HOUR).toISOString();
  assert.equal(shouldRunSerpCensus({ inWindow: true, lastRunAt, now: NOW }), true);
});

test('shouldRunSerpCensus: a custom cooldownHours is respected', () => {
  const lastRunAt = new Date(NOW - 3 * HOUR).toISOString();
  assert.equal(shouldRunSerpCensus({ inWindow: true, lastRunAt, now: NOW, cooldownHours: 1 }), true);
  assert.equal(shouldRunSerpCensus({ inWindow: true, lastRunAt, now: NOW, cooldownHours: 12 }), false);
});

test('shouldRunSerpCensus: corrupt lastRunAt stamp reads as due, not stuck forever', () => {
  assert.equal(shouldRunSerpCensus({ inWindow: true, lastRunAt: 'not-a-date', now: NOW }), true);
});
