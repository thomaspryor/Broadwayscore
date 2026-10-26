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
const { parseExemptList } = createRequire(import.meta.url)('./lib/cron-coverage.js');
const exempt = fs.readFileSync(path.join(root, '.cron-health-exempt.txt'), 'utf8');

const block = yml.slice(yml.indexOf('CRITICAL_CRONS=('));
const rows = [...block.slice(0, block.indexOf('\n          )')).matchAll(/^\s*"([^"|]+\.yml)\|(\d+)\|[^"|]+(?:\|[^"]*)?"/gm)]
  .map(m => [m[1], Number(m[2])]);
const entries = new Map(rows);

// Exact max_hours as registered. BRO-1618 set 3h/5h from the cron expressions;
// BRO-3867 (2026-10-22) widened both to 12h after measuring the throttled real
// cadence (success-run gap max 12.1h / 11.4h over 21 days). Still well under the
// 36h generic daily band, so a dead carrier is caught at the next daily check.
const EXPECTED = { 'audit-aggregator-gap.yml': [12, 12], 'opening-night-reviews.yml': [12, 12], 'owner-decision-emails.yml': [13, 13], 'visual-approval-land.yml': [13, 13] };

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
