import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { proseDateWait, parkRefusedForProse } = require('./prose-date-wait.js');

test('prose date waits match the live phrasings from BRO-6857', () => {
  for (const t of ['waits for 2 weeks of hit data', 'promote no earlier than 2026-11-13', 'needs about a week of per-lane data', 'after 2026-11-20', '3 clean runs']) {
    assert.equal(proseDateWait(t), true, t);
  }
});
test('a stamp, a real block or a plain reason is not a prose date wait', () => {
  for (const t of ['RECHECK-AFTER: 2026-11-13 promote no earlier than that', 'needs an API key from the vendor', 'waiting for upstream fix', 'owner decision on the headline', '']) {
    assert.equal(proseDateWait(t), false, t);
  }
});
test('linear-brain create --park refuses a session prose date wait before touching Linear (exit 2)', () => {
  const r = spawnSync('node', ['scripts/linear-brain.js', 'create', 'Test card', '--park', 'waits for 2 weeks of hit data', '--notes', 'x'], { encoding: 'utf8', env: { ...process.env, GITHUB_WORKFLOW: '', LINEAR_API_KEY: '' } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /PARK-REFUSED/);
});
test('false positives from review: real blocks and owner calls with a duration or date nearby are not prose waits', () => {
  for (const t of ['needs an API key; spend is $5 a day', 'needs the Mac, takes a few hours to run', 'requires a run of the private-repo workflow on the Mac',
    'owner decision on numbers from 2026-10-01', 'owner decision on one month of ad spend', 'needs a credential, renew in 2 weeks']) {
    assert.equal(proseDateWait(t), false, t);
  }
});
test('the refusal applies to session filers only: --source or a workflow run is exempt, a stamp in the notes lifts it (no Linear call)', () => {
  const base = { park: 'waits for 2 weeks of hit data', notes: 'x', env: {} };
  assert.equal(parkRefusedForProse(base), true);
  assert.equal(parkRefusedForProse({ ...base, source: 'workflow:audit-closing-dates' }), false);
  assert.equal(parkRefusedForProse({ ...base, env: { GITHUB_WORKFLOW: 'x' } }), false);
  assert.equal(parkRefusedForProse({ ...base, notes: 'RECHECK-AFTER: 2026-11-20' }), false);
  assert.equal(parkRefusedForProse({ ...base, park: undefined }), false);
});
