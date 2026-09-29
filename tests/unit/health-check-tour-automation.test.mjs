import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { tourAutomationResults } = require('../../scripts/health-check.js');
const { classifyHealthCheck } = require('../../scripts/lib/digest-audience.js');

const EARLY = new Date('2026-10-01T12:00:00Z');
const fresh = (h, now) => new Date(now.getTime() - h * 3600000).toISOString();

test('nothing to report = no digest rows', () => {
  assert.deepEqual(tourAutomationResults({}, EARLY), [], 'before the jobs are expected, missing reports are fine');
  const now = new Date('2026-10-10T12:00:00Z');
  assert.deepEqual(tourAutomationResults({
    sweep: { generatedAt: fresh(5, now), held: [] },
    dates: { generatedAt: fresh(5, now), tours: [{ id: 'a', problem: null }] },
    autocreate: { generatedAt: fresh(100, now), created: [] },
  }, now), []);
});

test('a job that stops reporting is flagged', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const rows = tourAutomationResults({
    sweep: { generatedAt: fresh(60, now), held: [] },
    dates: null,
    autocreate: { generatedAt: fresh(24 * 12, now), created: [] },
  }, now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Data: tour automation stopped reporting');
  assert.match(rows[0].message, /review mover.*3 day/);
  assert.match(rows[0].message, /dates check \(update-show-status\.yml\): no report yet/);
  assert.match(rows[0].message, /new-tour check.*12 day/);
});

test('held sweep is an error; date problems warn; created tours are reported (BRO-4262)', () => {
  const rows = tourAutomationResults({
    sweep: { generatedAt: fresh(1, EARLY), held: ['wicked-tour-2026'] },
    dates: { generatedAt: fresh(1, EARLY), tours: [{ id: 'mj-tour-2023', problem: 'schedule page parsed to zero engagements' }] },
    autocreate: { generatedAt: fresh(1, EARLY), created: ['beetlejuice-tour-2026'] },
  }, EARLY);
  assert.deepEqual(rows.map(r => [r.name, r.status]), [
    ['Data: tour review sweep held', 'error'],
    ['Data: tour dates need a look', 'warn'],
    ['Data: national tours added automatically', 'warn'],
  ]);
  assert.match(rows[0].hint, /--tour=wicked-tour-2026/);
  for (const r of rows) assert.equal(classifyHealthCheck(r.name), 'visitors', r.name);
});
