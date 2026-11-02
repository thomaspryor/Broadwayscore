import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { proseDateWait } = require('./prose-date-wait.js');

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
test('the cron filers that park with a date in free text still reach the filer (a --source or workflow run is exempt)', () => {
  const r = spawnSync('node', ['scripts/linear-brain.js', 'create', 'Test card', '--park', 'waits for 2 weeks of hit data', '--source', 'workflow:audit-closing-dates', '--notes', 'x'], { encoding: 'utf8', env: { ...process.env, LINEAR_API_KEY: '' }, timeout: 20000 });
  assert.doesNotMatch(r.stderr, /PARK-REFUSED/);
});
