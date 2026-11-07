import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * BRO-4800. The three workflows that write snapshots for the 11:30 UTC morning
 * digest must be scheduled in the early-UTC band. GitHub starts this repo's
 * schedules hours late: at 06:45 the health check started 11:34-15:17 UTC every
 * day for three weeks, so the digest always showed the previous afternoon's
 * results. At 02:15 the 2026-10-07/08 runs started 08:44 and 09:02.
 *
 * 544f14a3 (2026-10-09) silently put '45 6' back by committing a stale copy of
 * data-health-check.yml, and nothing noticed for three days. This test makes
 * that kind of revert fail CI and the Land gate instead.
 *
 * Reads the real workflow files (CLAUDE.md rule 15).
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

// Latest allowed scheduled hour (UTC, inclusive). Lag here is 5-11h, so a run
// scheduled after ~03:00 can finish after the 11:30 UTC digest.
const MAX_HOUR_UTC = 3;

const FEEDERS = [
  'data-health-check.yml',
  'daily-digest.yml',
  'reddit-engagement-digest.yml',
];

// Crons that start no digest feeder, so the hour cap does not apply. Each one's
// workflow must gate its digest-feeding job to the daily cron (checked below).
// BRO-6634: reddit-engagement-digest.yml's hourly cron only runs the
// opening-night post drafter; the digest job stays on '45 1 * * *'.
const NON_FEEDER_CRONS = {
  'reddit-engagement-digest.yml': { crons: ['41 * * * *'], feederGate: "github.event.schedule == '45 1 * * *'" },
};

function scheduledCrons(file) {
  const text = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', file), 'utf8');
  return [...text.matchAll(/^\s*-\s*cron:\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
}

for (const file of FEEDERS) {
  test(`${file} is scheduled early enough to land before the 11:30 UTC digest`, () => {
    const crons = scheduledCrons(file);
    assert.ok(crons.length > 0, `${file} has no schedule cron`);
    const skip = NON_FEEDER_CRONS[file];
    if (skip) {
      const text = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', file), 'utf8');
      assert.ok(text.includes(skip.feederGate), `${file}: the digest job must stay gated on "${skip.feederGate}"`);
    }
    for (const expr of crons) {
      if (skip && skip.crons.includes(expr)) continue;
      const hour = expr.trim().split(/\s+/)[1];
      assert.match(hour, /^\d+$/, `${file}: cron '${expr}' hour field is not a single hour`);
      assert.ok(
        Number(hour) <= MAX_HOUR_UTC,
        `${file}: cron '${expr}' runs at ${hour}:xx UTC; with GitHub's 5-11h schedule lag it lands after the 11:30 UTC digest (BRO-4800). Keep it at or before ${MAX_HOUR_UTC}:xx UTC.`,
      );
    }
  });
}
