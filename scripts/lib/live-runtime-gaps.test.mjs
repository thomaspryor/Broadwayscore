// Colocated tests for scripts/lib/live-runtime-gaps.js (BRO-7917). Runs in the
// scripts/lib/*.test.mjs glob batch in test.yml.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { liveShowsMissingRuntime } = require('./live-runtime-gaps.js');

const ids = (rows) => rows.map((s) => s.id);

test('counts only open/previews rows with no runtime', () => {
  const shows = [
    { id: 'a', status: 'open', market: 'broadway' },
    { id: 'b', status: 'previews', market: 'west-end', runtime: '' },
    { id: 'c', status: 'open', market: 'broadway', runtime: '2h 15m' },
    { id: 'd', status: 'closed', market: 'broadway' },
    { id: 'e', status: 'upcoming', market: 'west-end' },
    { id: 'f', status: 'previews', market: 'west-end', runtime: '50m' },
  ];
  const { core, regional } = liveShowsMissingRuntime(shows);
  assert.deepEqual(ids(core), ['a', 'b']);
  assert.deepEqual(regional, []);
});

test('splits regional rows out of the NYC/London count', () => {
  const shows = [
    { id: 'r', status: 'open', market: 'regional' },
    { id: 'n', status: 'open', market: 'broadway', runtime: '   ' },
  ];
  const { core, regional } = liveShowsMissingRuntime(shows);
  assert.deepEqual(ids(core), ['n']);
  assert.deepEqual(ids(regional), ['r']);
});

test('tolerates empty or missing input', () => {
  assert.deepEqual(liveShowsMissingRuntime(undefined), { core: [], regional: [] });
  assert.deepEqual(liveShowsMissingRuntime([null]), { core: [], regional: [] });
});
