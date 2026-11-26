// BRO-1648: the review-census carriers must be watched by check-cron-health.yml,
// otherwise a dead completeness cron is indistinguishable from "no gaps found".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const yml = fs.readFileSync(path.join(root, '.github/workflows/check-cron-health.yml'), 'utf8');
const { parseExemptList, findJobLevelKillSwitches } = createRequire(import.meta.url)('./lib/cron-coverage.js');
const exempt = fs.readFileSync(path.join(root, '.cron-health-exempt.txt'), 'utf8');

const block = yml.slice(yml.indexOf('CRITICAL_CRONS=('));
const rows = [...block.slice(0, block.indexOf('\n          )')).matchAll(/^\s*"([^"|]+\.yml)\|(\d+)\|[^"|]+(?:\|[^"]*)?"/gm)]
  .map(m => [m[1], Number(m[2])]);
const entries = new Map(rows);

// Exact max_hours as registered. BRO-1618 set 3h/5h from the cron expressions;
// BRO-3867 (2026-10-22) widened both to 12h after measuring the throttled real
// cadence (success-run gap max 12.1h / 11.4h over 21 days). Still well under the
// 36h generic daily band, so a dead carrier is caught at the next daily check.
const EXPECTED = { 'audit-aggregator-gap.yml': [12, 12], 'opening-night-reviews.yml': [12, 12], 'owner-decision-emails.yml': [13, 13], 'visual-approval-land.yml': [13, 13], 'publish-show-refresh.yml': [13, 13] };

for (const [wf, [lo, hi]] of Object.entries(EXPECTED)) {
  test(`${wf} is in CRITICAL_CRONS with sane max_hours`, () => {
    assert.ok(entries.has(wf), `${wf} missing from CRITICAL_CRONS`);
    const h = entries.get(wf);
    assert.ok(h >= lo && h <= hi, `${wf} max_hours=${h} outside [${lo}, ${hi}]`);
  });
  test(`${wf} is listed exactly once`, () => {
    assert.equal(rows.filter(([w]) => w === wf).length, 1);
  });
  test(`${wf} is not also in the exempt list`, () => {
    assert.ok(!parseExemptList(exempt).has(wf));
  });
}

// BRO-8233: the coverage audit only WARNS on an exempt entry that is also in CRITICAL_CRONS, and
// opening-night-completeness-check.yml sat in both for weeks after BRO-7934. Every entry, not only
// the pinned ones above, must leave the exempt list when it joins CRITICAL_CRONS.
test('no CRITICAL_CRONS entry is also in .cron-health-exempt.txt', () => {
  const ex = parseExemptList(exempt);
  const both = rows.map(([wf]) => wf).filter((wf) => ex.has(wf));
  assert.deepEqual(both, [], `remove from .cron-health-exempt.txt: ${both.join(', ')}`);
});

// BRO-8235: a job-level `if: vars.X_DISABLED != 'true'` makes a disabled run conclude 'skipped',
// and check-cron-health keys staleness on the last SUCCESS, so flipping the kill switch pages
// as stale and cron-redispatch re-dispatches. Gate the steps instead (publish-show-refresh.yml,
// BRO-8233) so a disabled run stays green. Allowlist: { 'file.yml': 'reason' }.
const JOB_LEVEL_KILL_SWITCH_ALLOW = {};
test('no CRITICAL_CRONS workflow gates a whole job on a vars.*_DISABLED kill switch', () => {
  const bad = [];
  for (const [wf] of rows) {
    if (JOB_LEVEL_KILL_SWITCH_ALLOW[wf]) continue;
    const file = path.join(root, '.github/workflows', wf);
    if (!fs.existsSync(file)) continue; // a missing file is another test's concern
    for (const hit of findJobLevelKillSwitches(fs.readFileSync(file, 'utf8'))) {
      bad.push(`${wf} job "${hit.job}": if: ${hit.if}`);
    }
  }
  assert.deepEqual(bad, [], `move the kill switch onto each step (see publish-show-refresh.yml):\n${bad.join('\n')}`);
});
test('the job-level kill-switch allowlist has reasons and only lists CRITICAL_CRONS entries', () => {
  for (const [wf, why] of Object.entries(JOB_LEVEL_KILL_SWITCH_ALLOW)) {
    assert.ok(entries.has(wf), `${wf} is allowlisted but not in CRITICAL_CRONS`);
    assert.ok(typeof why === 'string' && why.trim().length >= 10, `${wf} needs a reason`);
  }
});
