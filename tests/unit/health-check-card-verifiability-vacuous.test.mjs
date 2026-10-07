// BRO-3619: the daily digest must surface armed-but-vacuous cards (both boards), Linear refusals, and a stale Linear report.
// Real function (CLAUDE.md section 15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cardVerifiabilityBacklogResults } = require('../../scripts/health-check.js');
const { classifyHealthCheck } = require('../../scripts/lib/digest-audience.js');

const NOW = Date.parse('2026-10-07T02:15:00Z');
const FRESH = '2026-10-06T05:40:00Z';
const vac = (id, polarity) => ({ id, name: `Card ${id}`, cmd: 'test -f scripts/x.js', polarity });
const names = (r) => r.map((x) => x.name);

test('no reports, or empty buckets on fresh reports, yield nothing', () => {
  assert.deepEqual(cardVerifiabilityBacklogResults(null, null, null, NOW), []);
  assert.deepEqual(cardVerifiabilityBacklogResults({ total: 5, refused: [], vacuousChecks: [] }, null, { total: 9, refused: [], vacuousChecks: [], generatedAt: FRESH }, NOW), []);
});

test('Notion vacuousChecks surface on their own', () => {
  const r = cardVerifiabilityBacklogResults({ total: 5, refused: [], vacuousChecks: [vac('n1', 'never-fails')] }, null, null, NOW);
  assert.deepEqual(names(r), ['Data: armed-but-vacuous backlog cards']);
  assert.match(r[0].message, /1 card\(s\)/);
  assert.match(r[0].message, /Notion=1/);
  assert.match(r[0].hint, /--rearm --dry-run/);
});

test('Linear vacuousChecks surface even when the Notion report is absent (it is the frozen board)', () => {
  const r = cardVerifiabilityBacklogResults(null, null, { total: 9, refused: [], vacuousChecks: [vac('BRO-1', 'never-fails'), vac('BRO-2', 'never-passes')], generatedAt: FRESH }, NOW);
  assert.deepEqual(names(r), ['Data: armed-but-vacuous backlog cards']);
  assert.match(r[0].message, /Linear=2/);
  assert.match(r[0].message, /1 can never fail, 1 can never pass/);
});

test('both boards combine into one row with a per-source count', () => {
  const r = cardVerifiabilityBacklogResults({ total: 5, refused: [], vacuousChecks: [vac('n1', 'never-fails')] }, null, { total: 9, refused: [], vacuousChecks: [vac('BRO-1', 'never-fails')], generatedAt: FRESH }, NOW);
  assert.equal(r.length, 1);
  assert.match(r[0].message, /2 card\(s\).*Notion=1, Linear=1/);
});

test('Linear refused cards get their own row naming the first card', () => {
  const r = cardVerifiabilityBacklogResults(null, null, { total: 100, refused: [{ id: 'BRO-9', name: 'Fix the thing', priority: 1 }, { id: 'BRO-10', name: 'Other' }], vacuousChecks: [], generatedAt: FRESH }, NOW);
  assert.deepEqual(names(r), ['Data: undispatchable Linear backlog cards']);
  assert.match(r[0].message, /2 of 100 open Linear card/);
  assert.match(r[0].message, /BRO-9 Fix the thing/);
});

test('a Linear report older than 3 days, or with no readable date, warns that the audit stopped', () => {
  const stale = cardVerifiabilityBacklogResults(null, null, { total: 1, refused: [], vacuousChecks: [], generatedAt: '2026-09-15T16:33:26.821Z' }, NOW);
  assert.deepEqual(names(stale), ['Data: Linear card-verifiability report stale']);
  assert.match(stale[0].message, /2026-09-15/);
  const undated = cardVerifiabilityBacklogResults(null, null, { total: 1, refused: [], vacuousChecks: [] }, NOW);
  assert.deepEqual(names(undated), ['Data: Linear card-verifiability report stale']);
  const edge = cardVerifiabilityBacklogResults(null, null, { total: 1, refused: [], vacuousChecks: [], generatedAt: '2026-10-04T02:16:00Z' }, NOW);
  assert.deepEqual(edge, [], 'just under 3 days is fresh');
});

test('an absent Linear report never raises the stale row (nothing to be stale)', () => {
  assert.deepEqual(cardVerifiabilityBacklogResults({ total: 5, refused: [] }, null, undefined, NOW), []);
});

test('the Notion refused row still works with the new arguments', () => {
  const r = cardVerifiabilityBacklogResults({ total: 42, refused: [{ id: 'a', name: 'Fix', priority: 'P1', reason: 'x' }] }, null, null, NOW);
  assert.deepEqual(names(r), ['Data: undispatchable backlog cards']);
});

test('all three new rows are classed internal, so the owner digest never reports them as site problems', () => {
  for (const n of ['Data: undispatchable Linear backlog cards', 'Data: armed-but-vacuous backlog cards', 'Data: Linear card-verifiability report stale']) {
    assert.equal(classifyHealthCheck(n), 'internal', n);
  }
});
