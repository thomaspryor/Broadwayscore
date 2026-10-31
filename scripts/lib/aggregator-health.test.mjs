import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const H = require('./aggregator-health.js');
const { isScheduledWorkflow } = require('./cron-coverage.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = new Date('2026-10-24T12:00:00Z');

// West End shows opening across 2025Q4..2026Q3, `n` per quarter, first `covered` archived.
function fixture(perQuarter) {
  const shows = [];
  const ids = new Set();
  const month = { '25Q4': '11', '26Q1': '02', '26Q2': '05', '26Q3': '08' };
  for (const [q, [n, covered]] of Object.entries(perQuarter)) {
    for (let i = 0; i < n; i++) {
      const id = `show-${q}-${i}`;
      shows.push({ id, market: 'west-end', openingDate: `20${q.slice(0, 2)}-${month[q]}-10` });
      if (i < covered) ids.add(id);
    }
  }
  return { shows, ids };
}

test('quarterOf', () => {
  assert.equal(H.quarterOf('2026-01-01'), '2026Q1');
  assert.equal(H.quarterOf('2026-12-31'), '2026Q4');
  assert.equal(H.quarterOf('bad'), null);
});

test('coverageSeries ignores shows inside the grace window, other markets and provisional', () => {
  const shows = [
    { id: 'a', market: 'west-end', openingDate: '2026-08-01' },
    { id: 'b', market: 'west-end', openingDate: '2026-10-20' }, // 4 days old
    { id: 'c', market: 'broadway', openingDate: '2026-08-01' },
    { id: 'd', market: 'west-end', openingDate: '2026-08-02', provisional: true },
  ];
  const s = H.coverageSeries(shows, new Set(['a']), { market: 'west-end', now: NOW });
  assert.deepEqual(s, [{ quarter: '2026Q3', total: 1, covered: 1, pct: 100 }]);
});

test('The Stage 59 -> 12 -> 0 is flagged (card evidence)', () => {
  const { shows, ids } = fixture({ '25Q4': [100, 59], '26Q1': [100, 59], '26Q2': [100, 12], '26Q3': [100, 0] });
  const v = H.coverageVerdict(H.coverageSeries(shows, ids, { market: 'west-end', now: NOW }));
  assert.equal(v.flagged, true);
  assert.deepEqual(v.recentQuarters, ['2026Q2', '2026Q3']);
});

test('LBO 59/23/20, BWW London 41/31/15 and westendtheatre 82/58/55 are flagged', () => {
  for (const q of [[59, 23, 20], [41, 31, 15], [82, 58, 55]]) {
    const { shows, ids } = fixture({ '25Q4': [100, q[0]], '26Q1': [100, q[0]], '26Q2': [100, q[1]], '26Q3': [100, q[2]] });
    assert.equal(H.coverageVerdict(H.coverageSeries(shows, ids, { market: 'west-end', now: NOW })).flagged, true, q.join('/'));
  }
});

test('a steady source, a low-baseline source and thin quarters are not flagged', () => {
  const steady = fixture({ '25Q4': [100, 60], '26Q1': [100, 58], '26Q2': [100, 55], '26Q3': [100, 57] });
  assert.equal(H.coverageVerdict(H.coverageSeries(steady.shows, steady.ids, { market: 'west-end', now: NOW })).flagged, false);
  const lowBase = fixture({ '25Q4': [100, 18], '26Q1': [100, 18], '26Q2': [100, 15], '26Q3': [100, 10] }); // Stagedoor shape
  const lb = H.coverageVerdict(H.coverageSeries(lowBase.shows, lowBase.ids, { market: 'west-end', now: NOW }));
  assert.equal(lb.flagged, false);
  const thin = fixture({ '25Q4': [100, 60], '26Q1': [100, 60], '26Q2': [3, 0], '26Q3': [3, 0] });
  assert.equal(H.coverageVerdict(H.coverageSeries(thin.shows, thin.ids, { market: 'west-end', now: NOW })).flagged, false);
});

const run = (iso, conclusion, event = 'schedule') => ({ created_at: iso, conclusion, event });

test('The Stage: 3 weekly failures plus a failed manual dispatch is failing', () => {
  const v = H.workflowVerdict([
    run('2026-10-23T05:22:00Z', 'failure', 'workflow_dispatch'), run('2026-10-20T12:21:00Z', 'failure'),
    run('2026-10-13T14:39:00Z', 'failure'), run('2026-10-06T13:44:00Z', 'failure'),
  ], { cadenceDays: 7, now: NOW });
  assert.equal(v.status, 'failing');
  assert.equal(v.streak, 3); // the manual dispatch is not part of the cron's record
});

test('Stagedoor: weekly cron silent since 2026-06-22 is idle by mid July', () => {
  const runs = [run('2026-06-22T08:13:00Z', 'success'), run('2026-06-15T08:12:00Z', 'success')];
  assert.equal(H.workflowVerdict(runs, { cadenceDays: 7, now: new Date('2026-07-10T00:00:00Z') }).status, 'idle');
  assert.equal(H.workflowVerdict(runs, { cadenceDays: 7, now: new Date('2026-06-30T00:00:00Z') }).status, 'ok');
});

test('cancelled runs do not break or extend a failure streak; a success resets it', () => {
  const runs = [run('2026-10-23T00:00:00Z', 'failure'), run('2026-10-22T00:00:00Z', 'cancelled'),
    run('2026-10-21T00:00:00Z', 'failure'), run('2026-10-20T00:00:00Z', 'failure')];
  assert.equal(H.workflowVerdict(runs, { cadenceDays: 1, now: NOW }).status, 'failing');
  runs.splice(1, 0, run('2026-10-22T12:00:00Z', 'success'));
  assert.notEqual(H.workflowVerdict(runs, { cadenceDays: 1, now: NOW }).status, 'failing');
});

test('green runs that only ever fail intermittently stay ok; no success for a long time is stale', () => {
  const ok = [run('2026-10-23T00:00:00Z', 'success'), run('2026-10-22T00:00:00Z', 'failure')];
  assert.equal(H.workflowVerdict(ok, { cadenceDays: 1, now: NOW }).status, 'ok');
  const stale = [run('2026-10-23T00:00:00Z', 'failure'), run('2026-10-22T00:00:00Z', 'success'),
    run('2026-10-10T00:00:00Z', 'success')];
  assert.equal(H.workflowVerdict(stale, { cadenceDays: 1, now: new Date('2026-10-30T00:00:00Z') }).status, 'idle');
  const staleOk = [run('2026-10-29T00:00:00Z', 'failure'), run('2026-10-02T00:00:00Z', 'success')];
  assert.equal(H.workflowVerdict(staleOk, { cadenceDays: 1, now: new Date('2026-10-30T00:00:00Z') }).status, 'stale-success');
  assert.equal(H.workflowVerdict([], { cadenceDays: 1, now: NOW }).status, 'no-runs');
});

test('retiredConsistency catches a silently removed cron and a retired-but-live one', () => {
  const src = [
    { id: 'a', label: 'A', workflows: { 'a.yml': 7 } },
    { id: 'b', label: 'B', workflows: { 'b.yml': 7 }, retired: { on: '2026-06-25', reason: 'dead' } },
    { id: 'c', label: 'C', workflows: { 'c.yml': 7 } },
  ];
  const f = H.retiredConsistency(src, { 'a.yml': false, 'b.yml': true });
  assert.deepEqual(f.map(x => `${x.source}:${x.kind}`).sort(), ['a:schedule-removed', 'b:retired-but-scheduled', 'c:workflow-missing']);
  assert.deepEqual(H.retiredConsistency(src, { 'a.yml': true, 'b.yml': false, 'c.yml': true }), []);
});

test('assess skips retired sources and reports flagged coverage + failing workflow', () => {
  const { shows, ids } = fixture({ '25Q4': [100, 59], '26Q1': [100, 59], '26Q2': [100, 12], '26Q3': [100, 0] });
  const sources = [
    { id: 'thestage-roundups', label: 'The Stage', market: 'west-end', workflows: { 'x.yml': 7 } },
    { id: 'stagedoor', label: 'Stagedoor', market: 'west-end', workflows: { 'y.yml': 7 }, retired: { on: '2026-06-25', reason: 'dead' } },
  ];
  const { findings, report } = H.assess({
    sources, shows, now: NOW,
    archives: { 'thestage-roundups': ids, stagedoor: new Set() },
    runs: { 'x.yml': [run('2026-10-20T00:00:00Z', 'failure'), run('2026-10-13T00:00:00Z', 'failure'), run('2026-10-06T00:00:00Z', 'failure')] },
    scheduled: { 'x.yml': true, 'y.yml': false },
  });
  assert.deepEqual(findings.map(f => f.kind).sort(), ['coverage-drop', 'workflow-failing']);
  assert.ok(report.find(r => r.source === 'stagedoor').retired);
});

test('real registry matches the real workflow files (cron removed or restored without telling the monitor fails here)', () => {
  const scheduled = {};
  for (const s of H.SOURCES) {
    for (const wf of Object.keys(s.workflows)) {
      const p = path.join(ROOT, '.github', 'workflows', wf);
      if (fs.existsSync(p)) scheduled[wf] = isScheduledWorkflow(fs.readFileSync(p, 'utf8'));
    }
  }
  assert.deepEqual(H.retiredConsistency(H.SOURCES, scheduled), []);
});

test('current quarter is never judged; startup_failure counts; cancelled/pending alone is not stale', () => {
  const { shows, ids } = fixture({ '25Q4': [100, 60], '26Q1': [100, 60], '26Q2': [100, 60], '26Q3': [100, 60] });
  for (let i = 0; i < 20; i++) shows.push({ id: `cur-${i}`, market: 'west-end', openingDate: '2026-10-05' });
  const series = H.coverageSeries(shows, ids, { market: 'west-end', now: NOW });
  assert.ok(!series.some(r => r.quarter === '2026Q4'));
  assert.equal(H.coverageVerdict(series).flagged, false);
  const sf = ['2026-10-23', '2026-10-22', '2026-10-21'].map(d => run(`${d}T00:00:00Z`, 'startup_failure'));
  assert.equal(H.workflowVerdict(sf, { cadenceDays: 1, now: NOW }).status, 'failing');
  const pending = [run('2026-10-23T00:00:00Z', null), run('2026-10-22T00:00:00Z', 'cancelled'), run('2026-10-21T00:00:00Z', 'cancelled')];
  assert.equal(H.workflowVerdict(pending, { cadenceDays: 1, now: NOW }).status, 'ok');
});

test('category filter and shared-workflow dedupe', () => {
  const shows = [];
  for (let i = 0; i < 10; i++) shows.push({ id: `b${i}`, market: 'broadway', category: 'broadway', openingDate: '2026-02-01' }, { id: `o${i}`, market: 'broadway', category: 'off-broadway', openingDate: '2026-02-01' });
  const s = H.coverageSeries(shows, new Set(), { market: 'broadway', category: 'broadway', now: NOW });
  assert.equal(s[0].total, 10);
  const sources = [{ id: 'a', label: 'A', market: 'west-end', workflows: { 'x.yml': 1 } }, { id: 'b', label: 'B', market: 'west-end', workflows: { 'x.yml': 1 } }];
  const fails = ['20', '21', '22'].map(d => run(`2026-10-${d}T00:00:00Z`, 'failure'));
  const { findings } = H.assess({ sources, shows: [], archives: null, runs: { 'x.yml': fails }, scheduled: { 'x.yml': true }, now: NOW });
  assert.equal(findings.length, 1);
});

test('manual dispatch success does not hide a failing cron; retired source may delete its workflow', () => {
  const now = new Date('2026-10-24T00:00:00Z');
  const day = n => new Date(now - n * 86400000).toISOString();
  const runs = [
    { created_at: day(0.5), conclusion: 'success', event: 'workflow_dispatch' },
    ...[7, 14, 21].map(n => ({ created_at: day(n), conclusion: 'failure', event: 'schedule' })),
  ];
  assert.equal(H.workflowVerdict(runs, { cadenceDays: 7, now }).status, 'failing');
  const onlyManual = [{ created_at: day(1), conclusion: 'success', event: 'workflow_dispatch' }];
  assert.equal(H.workflowVerdict(onlyManual, { cadenceDays: 7, now }).status, 'ok');
  assert.deepEqual(H.retiredConsistency([{ id: 'x', label: 'X', retired: { reason: 'r' }, workflows: { 'gone.yml': 7 } }], {}), []);
});
