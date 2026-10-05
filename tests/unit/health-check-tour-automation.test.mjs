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
    autocreate: { generatedAt: fresh(30, now), created: [] },
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

test('a failed running-tour discovery warns; a working one is quiet (BRO-4325)', () => {
  const ok = tourAutomationResults({ autocreate: { generatedAt: fresh(1, EARLY), created: [], discovery: { pages: 252, checked: 171, found: 36, ambiguous: 0, error: null } } }, EARLY);
  assert.deepEqual(ok, []);
  const rows = tourAutomationResults({ autocreate: { generatedAt: fresh(1, EARLY), created: [], discovery: { error: 'only 12 show pages listed; the pages API may have changed' } } }, EARLY);
  assert.deepEqual(rows.map(r => [r.name, r.status]), [['Data: running-tour discovery failed', 'warn']]);
  assert.match(rows[0].message, /only 12 show pages/);
  assert.equal(classifyHealthCheck(rows[0].name), 'visitors');
});

test('reopened tours and closed tours listing new dates are reported (BRO-4724)', () => {
  const quiet = tourAutomationResults({ autocreate: { generatedAt: fresh(1, EARLY), created: [], reopened: [], lifecycle: { reopen: [], undecided: [] } } }, EARLY);
  assert.deepEqual(quiet, []);
  const rows = tourAutomationResults({ autocreate: { generatedAt: fresh(1, EARLY), created: [], reopened: ['shucked-tour-2024'],
    lifecycle: { reopen: [], undecided: [{ id: 'a-beautiful-noise-the-neil-diamond-musical-tour-2024', closingDate: '2026-07-12', resumes: '2026-10-30', reason: 'closing 2026-07-12 was checked by hand' }] } } }, EARLY);
  assert.deepEqual(rows.map(r => [r.name, r.status]), [
    ['Data: closed national tours reopened automatically', 'warn'],
    ['Data: closed national tour lists new dates', 'warn'],
  ]);
  assert.match(rows[1].message, /checked by hand/);
  for (const r of rows) assert.equal(classifyHealthCheck(r.name), 'visitors', r.name);
});
