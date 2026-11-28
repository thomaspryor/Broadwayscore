/**
 * verify-bro-4061-recheck.test.mjs — RECHECK-AFTER acceptance for BRO-4061
 * (gap-audit back-catalogue lane, landed 2026-10-22). Asserts against LIVE
 * data, not fixtures: run by scripts/autonomous-acceptance-recheck.js once a
 * week of hourly gap-audit runs has used the new lane. A red run means
 * never-audited shows are still not rotating in, not a code regression.
 *
 * Baseline: the checkpoint sat at 925 shows for 14 days before the lane
 * (928 after one targeted run on 2026-10-22). The 14-day replay predicted
 * ~89 never-audited shows audited in 14 days, so +37 in 7 days is a floor.
 *
 * timebomb-audit-exempt: dated RECHECK-AFTER probe of live cron output; the assertion is pinned to a real 2026-10 landing date a shifted clock cannot simulate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKPOINT = path.join(ROOT, 'data', 'audit', 'gap-audit-checkpoint.json');
// land.js runs every changed *.test.mjs, so the cron-dependent check skips
// until a week of runs has had the lane.
const PENDING = Date.now() < Date.parse('2026-10-29T20:00:00Z')
  ? 'waits for a week of gap-audit runs with the catalogue lane' : false;

test('the gap-audit checkpoint grew past its 925-show plateau', { skip: PENDING }, () => {
  const n = Object.keys(JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8'))).length;
  assert.ok(n >= 965, `checkpoint holds ${n} shows; expected >= 965 once the catalogue lane audits never-audited shows`);
});
