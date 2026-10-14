// BRO-5326: a `--show` audit run replaced the 734-row image-verification.json
// with one row. require()s the real builder (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildAuditReport } = require('./image-audit-report.js');

const prior = { generatedAt: '2026-02-04T00:00:00Z', mode: 'dry-run', totalShows: 2, stats: { calls: 9 }, results: { a: { showId: 'a', action: 'delete' }, b: { showId: 'b', action: 'keep' } } };
const NOW = '2026-10-14T05:00:00Z';

test('a --show run patches one row and keeps every other row', () => {
  const r = buildAuditReport({ prior, results: { c: { showId: 'c', action: 'keep' } }, singleShow: 'c', mode: 'dry-run', showCount: 3, stats: {}, now: NOW });
  assert.deepEqual(Object.keys(r.results).sort(), ['a', 'b', 'c']);
  assert.equal(r.totalShows, 3);
});

test('a --show run does not make the old rows look freshly audited', () => {
  const r = buildAuditReport({ prior, results: { c: { showId: 'c', action: 'keep' } }, singleShow: 'c', mode: 'dry-run', showCount: 3, stats: {}, now: NOW });
  assert.equal(r.generatedAt, '2026-02-04T00:00:00Z');
  assert.deepEqual(r.stats, { calls: 9 });
  assert.equal(r.partialUpdatedAt, NOW);
  assert.equal(r.results.c.auditedAt, NOW);
  assert.equal(r.results.a.auditedAt, undefined);
});

test('re-auditing a show replaces only its own row', () => {
  const r = buildAuditReport({ prior, results: { a: { showId: 'a', action: 'keep' } }, singleShow: 'a', mode: 'dry-run', showCount: 2, stats: {}, now: NOW });
  assert.equal(r.results.a.action, 'keep');
  assert.equal(r.results.b.action, 'keep');
});

test('an id that matched no show leaves the file alone', () => {
  assert.equal(buildAuditReport({ prior, results: {}, singleShow: 'nope', mode: 'dry-run', showCount: 2, stats: {}, now: NOW }), null);
});

test('a --show run with no prior file writes a fresh report', () => {
  const r = buildAuditReport({ prior: {}, results: { c: { showId: 'c', action: 'keep' } }, singleShow: 'c', mode: 'dry-run', showCount: 3, stats: { calls: 1 }, now: NOW });
  assert.equal(r.generatedAt, NOW);
  assert.equal(r.totalShows, 1);
});

test('a full run replaces the report and counts every show', () => {
  const r = buildAuditReport({ prior, results: { x: { showId: 'x', action: 'keep' } }, singleShow: null, mode: 'apply', showCount: 734, stats: { calls: 1 }, now: NOW });
  assert.deepEqual(Object.keys(r.results), ['x']);
  assert.equal(r.totalShows, 734);
  assert.equal(r.generatedAt, NOW);
  assert.equal(r.mode, 'apply');
});
