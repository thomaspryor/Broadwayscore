/**
 * BRO-6098 card VERIFY target: the audit CLI's local loaders read the real
 * workflow files, and the real registry has no persistence or schedule gap.
 * Pure logic is covered in scripts/lib/aggregator-health.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { loadScheduled, loadArchiveSteps } = require('./audit-aggregator-health.js');
const H = require('./lib/aggregator-health.js');

test('loadArchiveSteps reads every registered workflow; The Stage round-trips its archive', () => {
  const steps = loadArchiveSteps(H.SOURCES);
  assert.deepEqual(steps['scrape-thestage-roundups.yml'], { checkout: true, push: true });
  for (const s of H.SOURCES.filter(x => !x.retired)) {
    for (const wf of Object.keys(s.workflows)) assert.ok(steps[wf], `${wf} was read`);
  }
  assert.deepEqual(H.archivePersistence(H.SOURCES, steps), []);
});

test('loadArchiveSteps flags a workflow without the archive steps (temp dir)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-health-wf-'));
  fs.writeFileSync(path.join(dir, 'ts.yml'), 'on:\n  schedule:\n    - cron: "0 7 * * 2"\njobs:\n  s:\n    steps:\n      - uses: ./.github/actions/push-review-texts\n');
  const sources = [{ id: 'thestage-roundups', label: 'The Stage roundups', workflows: { 'ts.yml': 7, 'missing.yml': 7 } }];
  const steps = loadArchiveSteps(sources, dir);
  assert.deepEqual(Object.keys(steps), ['ts.yml']); // a missing file is not read (workflow-missing covers it)
  assert.deepEqual(H.archivePersistence(sources, steps).map(f => f.kind), ['archive-not-persisted']);
});

test('real registry: every West End source judges category west-end only (BRO-7213)', () => {
  const we = H.SOURCES.filter(s => s.market === 'west-end');
  assert.ok(we.length >= 5);
  for (const s of we) assert.equal(s.category, 'west-end', `${s.id} must filter category west-end`);
  // Off-West-End expansion must not move a West End source's coverage.
  const now = new Date('2026-11-15T00:00:00Z');
  const shows = [];
  for (let i = 0; i < 10; i++) shows.push({ id: `we${i}`, market: 'west-end', category: 'west-end', openingDate: '2026-05-01' });
  for (let i = 0; i < 40; i++) shows.push({ id: `owe${i}`, market: 'west-end', category: 'off-west-end', openingDate: '2026-05-01' });
  const archived = new Set(['we0', 'we1', 'we2', 'we3', 'we4', 'we5']);
  const lbo = we.find(s => s.id === 'lbo-roundups');
  const series = H.coverageSeries(shows, archived, { market: lbo.market, category: lbo.category, now });
  assert.deepEqual(series.map(r => [r.quarter, r.covered, r.total, r.pct]), [['2026Q2', 6, 10, 60]]);
});

test('real registry: no schedule drift', () => {
  assert.deepEqual(H.retiredConsistency(H.SOURCES, loadScheduled(H.SOURCES)), []);
});
