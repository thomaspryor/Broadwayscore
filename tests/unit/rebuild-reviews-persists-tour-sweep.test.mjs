import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// BRO-8357: a heartbeat report that health-check.js reads for freshness must be able to trigger
// the rebuild's commit on its own. Otherwise a no-diff rebuild leaves it days old on main.
const yml = fs.readFileSync(new URL('../../.github/workflows/rebuild-reviews.yml', import.meta.url), 'utf8');
const health = fs.readFileSync(new URL('../../scripts/health-check.js', import.meta.url), 'utf8');

test('health-check still reads tour-sweep.json as the tour mover heartbeat', () => {
  assert.match(health, /read\('tour-sweep\.json'\)/);
});

test('rebuild-reviews commits tour-sweep.json even when reviews did not change', () => {
  const block = yml.match(/git status --porcelain data\/audit\/tour-sweep\.json[^\n]*audit-heartbeat-due\.js data\/audit\/tour-sweep\.json; then\n\s+EXCLUSION_STATE_CHANGED=true/);
  assert.ok(block, 'tour-sweep.json must set EXCLUSION_STATE_CHANGED (the no-diff commit trigger)');
});

test('the commit step is gated on that trigger', () => {
  assert.match(yml, /steps\.changes\.outputs\.has_changes == 'true' \|\| steps\.changes\.outputs\.exclusion_state_changed == 'true'/);
});

test('tour-sweep.json is staged AFTER the fallback-disqualifier unstage helper (BRO-8357 root cause)', () => {
  const helper = yml.indexOf('node scripts/lib/unstage-api-fallback-disqualifiers.js');
  const stage = yml.indexOf('git-add-existing.sh data/audit/tour-sweep.json');
  assert.ok(helper > 0 && stage > helper, 'the helper unstages tour-sweep.json, so it must be re-staged after it');
});
