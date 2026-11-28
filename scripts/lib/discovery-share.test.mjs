import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pipelineOf, discoveryShare, pendingGrowthVerdict } = require('./discovery-share.js');

test('pipelineOf: caller wins, form/hand sources with no caller are labelled, collectors name themselves', () => {
  assert.equal(pipelineOf({ source: 'submit-review-form', ingestSource: 'audit-show-review-gap' }), 'audit-show-review-gap');
  assert.equal(pipelineOf({ source: 'submit-review-form' }), 'submit-review-form (no caller)');
  assert.equal(pipelineOf({ source: 'ingest-urls' }), 'ingest-urls (no caller)');
  assert.equal(pipelineOf({ source: 'dtli' }), 'dtli');
  assert.equal(pipelineOf({}), '(no source)');
});

test('discoveryShare: the audit shape (form files, 1,246 from the backstop, rest no caller) and the since filter', () => {
  const files = [
    ...Array(5).fill({ source: 'submit-review-form', ingestSource: 'audit-show-review-gap', stamp: '2026-11-20T00:00:00Z' }),
    ...Array(3).fill({ source: 'submit-review-form', stamp: '2026-11-20T00:00:00Z' }),
    { source: 'dtli', stamp: '2026-11-20T00:00:00Z' },
    { source: 'dtli', stamp: '2026-01-01T00:00:00Z' },
  ];
  const s = discoveryShare(files);
  assert.equal(s.total, 10);
  assert.equal(s.backstop, 5);
  assert.equal(s.noCaller, 3);
  assert.equal(s.backstopShare, 0.5);
  assert.equal(s.rows[0].pipeline, 'audit-show-review-gap');
  const recent = discoveryShare(files, { sinceMs: Date.parse('2026-11-01') });
  assert.equal(recent.total, 9);
});

test('pendingGrowthVerdict: flat is ok, +100 and 1.25x over the recent floor alerts, short history never alerts', () => {
  const mk = (...n) => n.map((pending, i) => ({ date: `2026-11-${10 + i}`, pending }));
  assert.equal(pendingGrowthVerdict(mk(1700, 1710, 1690, 1705)).alert, false);
  const g = pendingGrowthVerdict(mk(1000, 1010, 1020, 1300));
  assert.equal(g.alert, true);
  assert.equal(g.growth, 300);
  assert.equal(pendingGrowthVerdict(mk(1000, 1300)).status, 'insufficient-history');
  assert.equal(pendingGrowthVerdict(mk(5000, 5000, 5000, 5110)).alert, false); // +110 but under 1.25x
});
