import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { auditTargetIds } = require('./newsletter-audit-targets.js');

const meta = {
  openingShows: [{ id: 'audited-recently' }, { id: 'never-audited' }, { id: 'audited-long-ago' }, { id: 'audited-recently' }],
  ledeShows: [{ id: 'lede-only' }, { id: 'never-audited' }, { slug: 'no-id' }, { id: 'Bad Id' }],
};
const checkpoint = {
  'audited-recently': { at: '2026-10-03T00:00:00Z' },
  'audited-long-ago': { at: '2026-09-01T00:00:00Z' },
};

test('featured shows: de-duplicated, invalid ids dropped, least-audited first', () => {
  assert.deepEqual(
    auditTargetIds(meta, checkpoint),
    ['never-audited', 'lede-only', 'audited-long-ago', 'audited-recently'],
  );
});

test('no meta shows gives an empty list', () => {
  assert.deepEqual(auditTargetIds({}, checkpoint), []);
  assert.deepEqual(auditTargetIds(null), []);
});

test('targeted audit dispatch bypasses the SERP census cooldown', async () => {
  const { readFileSync } = await import('node:fs');
  const wf = readFileSync(new URL('../../.github/workflows/audit-aggregator-gap.yml', import.meta.url), 'utf8');
  const at = wf.indexOf('ARGS="--show=$SHOW_IDS');
  assert.ok(at > 0, 'targeted ARGS line present');
  assert.match(wf.slice(at, at + 900), /export SERP_CENSUS_COOLDOWN_HOURS=0/);
});
