// BRO-3619 / BRO-4717: the daily digest must surface armed-but-vacuous Linear cards, Linear refusals, and a stale Linear report.
// The Notion-board rows were retired with the frozen mirror (BRO-4717).
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
// BRO-5164: fresh clean buckets add same-name pass rows; these tests pin the flagged rows.
const flagged = (r) => r.filter((x) => x.status !== 'pass');
const names = (r) => r.filter((x) => x.status !== 'pass').map((x) => x.name);

test('no reports yield nothing; empty buckets on a fresh report flag nothing', () => {
  assert.deepEqual(cardVerifiabilityBacklogResults(null, null, NOW), []);
  assert.deepEqual(names(cardVerifiabilityBacklogResults(null, { total: 9, refused: [], vacuousChecks: [], generatedAt: FRESH }, NOW)), []);
});

test('Linear vacuousChecks surface as one row with polarity counts', () => {
  const r = cardVerifiabilityBacklogResults(null, { total: 9, refused: [], vacuousChecks: [vac('BRO-1', 'never-fails'), vac('BRO-2', 'never-passes')], generatedAt: FRESH }, NOW);
  assert.deepEqual(names(r), ['Data: armed-but-vacuous backlog cards']);
  assert.match(r[0].message, /2 Linear card\(s\)/);
  assert.match(r[0].message, /1 can never fail, 1 can never pass/);
  assert.match(r[0].message, /First: BRO-1/);
  assert.match(r[0].hint, /--rearm --dry-run/);
});

test('Linear refused cards get their own row naming the first card', () => {
  const r = flagged(cardVerifiabilityBacklogResults(null, { total: 100, refused: [{ id: 'BRO-9', name: 'Fix the thing', priority: 1 }, { id: 'BRO-10', name: 'Other' }], vacuousChecks: [], generatedAt: FRESH }, NOW));
  assert.deepEqual(names(r), ['Data: undispatchable Linear backlog cards']);
  assert.match(r[0].message, /2 of 100 open Linear card/);
  assert.match(r[0].message, /BRO-9 Fix the thing/);
});

test('a Linear report older than 3 days, or with no readable date, warns that the audit stopped', () => {
  const stale = cardVerifiabilityBacklogResults(null, { total: 1, refused: [], vacuousChecks: [], generatedAt: '2026-09-15T16:33:26.821Z' }, NOW);
  assert.deepEqual(names(stale), ['Data: Linear card-verifiability report stale']);
  assert.match(stale[0].message, /2026-09-15/);
  const undated = cardVerifiabilityBacklogResults(null, { total: 1, refused: [], vacuousChecks: [] }, NOW);
  assert.deepEqual(names(undated), ['Data: Linear card-verifiability report stale']);
  const edge = cardVerifiabilityBacklogResults(null, { total: 1, refused: [], vacuousChecks: [], generatedAt: '2026-10-04T02:16:00Z' }, NOW);
  assert.deepEqual(names(edge), [], 'just under 3 days is fresh');
});

test('an absent Linear report never raises the stale row (nothing to be stale)', () => {
  assert.deepEqual(cardVerifiabilityBacklogResults(null, undefined, NOW), []);
});

test('BRO-4717: the retired Notion-board row is never produced, whatever the argument shapes', () => {
  // A Notion-shaped report passed where the old first argument went must not resurrect
  // 'Data: undispatchable backlog cards' (the frozen mirror's row).
  const r = cardVerifiabilityBacklogResults({ total: 42, refused: [{ id: 'a', name: 'Fix', priority: 'P1' }] }, null, NOW);
  assert.ok(!names(r).includes('Data: undispatchable backlog cards'));
});

test('all three new rows are classed internal, so the owner digest never reports them as site problems', () => {
  for (const n of ['Data: undispatchable Linear backlog cards', 'Data: armed-but-vacuous backlog cards', 'Data: Linear card-verifiability report stale']) {
    assert.equal(classifyHealthCheck(n), 'internal', n);
  }
});
