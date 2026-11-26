// BRO-8331 / BRO-8107: the land-preflight hook runs the live-data-lane floor
// (scripts/live-data-lane.js --verify-changed --refuse-undeclared) on a direct
// land/* push, so a worker no longer pays a ~30 min land.yml round trip for an
// undeclared live-data unit test. Calls the real exported function; the trace
// runner is a seam. The fuller matrix lives in land-preflight.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveDataLaneCheck } from '../../scripts/lib/land-preflight.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const refused = { status: 1, stdout: '::error::live-data-lane: tests/unit/x.test.mjs reads data/shows.json without a LIVE-DATA-LANE marker\n' };
const run = (r) => ({ run: () => r });

test('an undeclared live-data test blocks the land push', () => {
  const r = liveDataLaneCheck({ root: ROOT, env: {}, seams: run(refused), budgetMs: 100000 });
  assert.equal(r.status, 'fail');
  assert.match(r.message, /tests\/unit\/x\.test\.mjs/);
  assert.match(r.message, /live-data-lane --verify-changed|live-data-lane\.js --verify-changed --refuse-undeclared/);
});

test('clean trace and infrastructure failures never block', () => {
  assert.equal(liveDataLaneCheck({ root: ROOT, env: {}, seams: run({ status: 0, stdout: '' }), budgetMs: 100000 }).status, 'clean');
  assert.equal(liveDataLaneCheck({ root: ROOT, env: {}, seams: run({ status: 2, stdout: '' }), budgetMs: 100000 }).status, 'skip');
  assert.equal(liveDataLaneCheck({ root: ROOT, env: {}, seams: run(refused), budgetMs: 1000 }).status, 'skip');
  assert.equal(liveDataLaneCheck({ root: ROOT, env: { LAND_LIVE_DATA_PREFLIGHT_DISABLE: '1' }, seams: run(refused), budgetMs: 100000 }).status, 'off');
});

test('the hook wires the check into runHook, not only the merge script', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/land-preflight.mjs'), 'utf8');
  assert.match(src, /liveDataLaneCheck\(\{ root, base, env/);
  assert.match(src, /ld\.status === 'fail'/);
});
