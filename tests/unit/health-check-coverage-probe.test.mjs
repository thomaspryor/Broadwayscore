import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { coverageProbeResult } = require('../../scripts/health-check.js');

const NOW = Date.parse('2026-08-03T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

const clean = (over = {}) => ({
  generatedAt: hoursAgo(6),
  verdict: 'clean',
  gapCount: 0,
  gapShows: [],
  acceptance: { accepted: false, reason: 'only 1 measurable run(s) on record (need 2)' },
  ...over,
});

test('a clean run passes without alarming vocabulary', () => {
  const r = coverageProbeResult(clean(), { nowMs: NOW });
  assert.equal(r.status, 'pass');
  assert.match(r.message, /live or named-excluded/);
});

test('a clean run that clears the 2-week acceptance bar says so', () => {
  const r = coverageProbeResult(clean({ acceptance: { accepted: true, reason: '2 consecutive clean weekly run(s)' } }), { nowMs: NOW });
  assert.equal(r.status, 'pass');
  assert.match(r.message, /acceptance bar cleared/);
});

test('gaps-found is a warn (this-week action), not a page — it is a finding, not an outage', () => {
  const r = coverageProbeResult(clean({ verdict: 'gaps-found', gapCount: 2, gapShows: ['the-car-man-west-end-2026'] }), { nowMs: NOW });
  assert.equal(r.status, 'warn');
  assert.match(r.message, /2 review URL\(s\)/);
  assert.match(r.message, /the-car-man-west-end-2026/);
  assert.match(r.hint, /coverage-adversarial-probe\.json/);
});

test('inconclusive (outage or all-settling sample) warns without claiming health', () => {
  const r = coverageProbeResult(clean({ verdict: 'inconclusive' }), { nowMs: NOW });
  assert.equal(r.status, 'warn');
  assert.match(r.message, /nothing measurable/);
});

test('missing data warns instead of passing — a silent probe reads as health otherwise', () => {
  const r = coverageProbeResult(null, { nowMs: NOW });
  assert.equal(r.status, 'warn');
  assert.match(r.message, /No adversarial-probe data/);
});

test('a stale weekly run warns that the probe itself has gone quiet', () => {
  const r = coverageProbeResult(clean({ generatedAt: hoursAgo(24 * 11) }), { nowMs: NOW });
  assert.equal(r.status, 'warn');
  assert.match(r.message, /last ran/);
  assert.match(r.hint, /stale or disabled/);
});

test('an unparseable generatedAt is treated as stale, never as fresh', () => {
  const r = coverageProbeResult(clean({ generatedAt: 'not-a-date' }), { nowMs: NOW });
  assert.equal(r.status, 'warn');
});
