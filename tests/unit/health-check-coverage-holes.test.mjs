// BRO-4861: the daily coverage-holes audit (classes A-D) must reach the health digest. Real functions (CLAUDE.md section 15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { coverageHolesResults } = require('../../scripts/health-check.js');
const { countsReport } = require('../../scripts/audit-coverage-holes.js');
const { classifyHealthCheck } = require('../../scripts/lib/digest-audience.js');

const NOW = Date.parse('2026-10-16T05:00:00Z');
const FRESH = '2026-10-15T20:00:00Z';
const c = (total, explained = 0) => ({ total, recent: 0, explained });
const report = (A, B, C, D, generatedAt = FRESH) => ({ generatedAt, shows: 40, counts: { A: c(A), B: c(B), C: c(C), D: { ...c(D), published: D } } });

// BRO-5164: a clean fresh report is a same-name pass row (verifies a fixed card).
const flagged = (rows) => rows.filter((r) => r.status !== 'pass');

test('no report yields nothing; a clean fresh report yields only the pass row', () => {
  assert.deepEqual(coverageHolesResults(null, NOW), []);
  assert.deepEqual(coverageHolesResults(report(0, 0, 0, 0), NOW).map((r) => [r.name, r.status]), [['Data: review coverage holes', 'pass']]);
});

test('holes in A-D surface as one advisory warn row', () => {
  const r = coverageHolesResults(report(3, 2, 1, 1), NOW);
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'Data: review coverage holes');
  assert.equal(r[0].status, 'warn');
  assert.match(r[0].message, /3 review\(s\) with no usable text, 2 rejected.*1 never scored, 1 with a blocked URL \(1 published/);
});

test('fully explained A-C does not warn', () => {
  const rep = report(2, 1, 1, 0);
  for (const k of ['A', 'B', 'C']) rep.counts[k].explained = rep.counts[k].total;
  assert.deepEqual(flagged(coverageHolesResults(rep, NOW)), []);
});

test('a stale report warns that the daily audit stopped', () => {
  const r = coverageHolesResults(report(0, 0, 0, 0, '2026-10-01T00:00:00Z'), NOW);
  assert.equal(r.length, 1);
  assert.match(r[0].message, /more than 3 days old/);
});

test('row is internal-audience, so it never lands in the visitor-facing digest', () => {
  assert.equal(classifyHealthCheck('Data: review coverage holes'), 'internal');
});

test('countsReport carries counts only, no file names or text', () => {
  const rows = [{ file: 'show/secret.json', recent: true, published: true }, { file: 'show/b.json', decision: 'ok' }];
  const rep = countsReport({ shows: 5, files: 9, unreadable: 0, showsAffected: 1, A: rows, B: [], C: [], D: rows }, NOW);
  assert.equal(rep.counts.A.total, 2);
  assert.equal(rep.counts.A.recent, 1);
  assert.equal(rep.counts.A.explained, 1);
  assert.equal(rep.counts.D.published, 1);
  assert.ok(!JSON.stringify(rep).includes('secret'));
});

test('unpublished D rows alone do not warn', () => {
  const rep = report(0, 0, 0, 3);
  rep.counts.D.published = 0;
  assert.deepEqual(flagged(coverageHolesResults(rep, NOW)), []);
});

test('explained above total never goes negative and masks a real hole', () => {
  const rep = report(1, 0, 2, 0);
  rep.counts.A.explained = 5;
  assert.equal(coverageHolesResults(rep, NOW).length, 1);
});
