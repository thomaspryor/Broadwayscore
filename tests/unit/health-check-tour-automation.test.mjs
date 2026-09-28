import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { tourAutomationResults } = require('../../scripts/health-check.js');
const { classifyHealthCheck } = require('../../scripts/lib/digest-audience.js');

test('nothing to report = no digest rows', () => {
  assert.deepEqual(tourAutomationResults({}), []);
  assert.deepEqual(tourAutomationResults({ sweep: { held: [] }, dates: { tours: [{ id: 'a', problem: null }] }, autocreate: { created: [] } }), []);
});

test('held sweep is an error; date problems warn; created tours are reported (BRO-4262)', () => {
  const rows = tourAutomationResults({
    sweep: { held: ['wicked-tour-2026'] },
    dates: { tours: [{ id: 'mj-tour-2023', problem: 'schedule page parsed to zero engagements' }] },
    autocreate: { created: ['beetlejuice-tour-2026'] },
  });
  assert.deepEqual(rows.map(r => [r.name, r.status]), [
    ['Data: tour review sweep held', 'error'],
    ['Data: tour dates need a look', 'warn'],
    ['Data: national tours added automatically', 'warn'],
  ]);
  assert.match(rows[0].hint, /--tour=wicked-tour-2026/);
  for (const r of rows) assert.equal(classifyHealthCheck(r.name), 'visitors', r.name);
});
