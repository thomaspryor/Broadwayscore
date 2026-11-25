// Colocated tests for scripts/lib/live-runtime-gaps.js (BRO-7917). Runs in the
// scripts/lib/*.test.mjs glob batch in test.yml.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { liveShowsMissingRuntime } = require('./live-runtime-gaps.js');

const ids = (rows) => rows.map((s) => s.id);
const TODAY = '2026-11-25';

test('counts only live rows with no runtime', () => {
  const shows = [
    { id: 'a', status: 'open', market: 'broadway', category: 'off-broadway' },
    { id: 'b', status: 'previews', market: 'west-end', category: 'west-end', runtime: '' },
    { id: 'c', status: 'open', market: 'broadway', category: 'broadway', runtime: '2h 15m' },
    { id: 'd', status: 'closed', market: 'broadway', category: 'broadway' },
    { id: 'e', status: 'upcoming', market: 'west-end', category: 'west-end' },
    { id: 'f', status: 'previews', market: 'west-end', category: 'off-west-end', runtime: '50m' },
  ];
  const { core, regional } = liveShowsMissingRuntime(shows, { today: TODAY });
  assert.deepEqual(ids(core), ['a', 'b']);
  assert.deepEqual(regional, []);
});

test('an unparseable runtime counts as missing (same parser as the calendar)', () => {
  const shows = [
    { id: 'v', status: 'open', category: 'broadway', runtime: 'varies' },
    { id: 'z', status: 'open', category: 'broadway', runtime: '0h' },
    { id: 'w', status: 'open', category: 'broadway', runtime: '   ' },
    { id: 'ok', status: 'open', category: 'broadway', runtime: '2h' },
  ];
  assert.deepEqual(ids(liveShowsMissingRuntime(shows, { today: TODAY }).core), ['v', 'z', 'w']);
});

test('uses the effective status: expired open and not-yet-started previews are not live', () => {
  const shows = [
    { id: 'expired', status: 'open', category: 'off-west-end', closingDate: '2026-08-29' },
    { id: 'future', status: 'previews', category: 'west-end', previewsStartDate: '2027-11-05' },
    { id: 'live', status: 'open', category: 'off-broadway', closingDate: '2026-12-06' },
  ];
  assert.deepEqual(ids(liveShowsMissingRuntime(shows, { today: TODAY }).core), ['live']);
});

test('splits regional rows (by category or market) out of the NYC/London count', () => {
  const shows = [
    { id: 'r1', status: 'open', market: 'regional', category: 'regional' },
    { id: 'r2', status: 'open', category: 'regional' },
    { id: 'n', status: 'open', market: 'broadway', category: 'broadway' },
  ];
  const { core, regional } = liveShowsMissingRuntime(shows, { today: TODAY });
  assert.deepEqual(ids(core), ['n']);
  assert.deepEqual(ids(regional), ['r1', 'r2']);
});

test('tolerates empty or missing input', () => {
  assert.deepEqual(liveShowsMissingRuntime(undefined), { core: [], regional: [] });
  assert.deepEqual(liveShowsMissingRuntime([null]), { core: [], regional: [] });
});
