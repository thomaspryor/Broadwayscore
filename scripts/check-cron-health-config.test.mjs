// BRO-1648: the review-census carriers must be watched by check-cron-health.yml,
// otherwise a dead completeness cron is indistinguishable from "no gaps found".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const yml = fs.readFileSync(path.join(root, '.github/workflows/check-cron-health.yml'), 'utf8');
const exempt = fs.readFileSync(path.join(root, '.cron-health-exempt.txt'), 'utf8');

const block = yml.slice(yml.indexOf('CRITICAL_CRONS=('));
const entries = new Map(
  [...block.slice(0, block.indexOf('\n          )')).matchAll(/^\s*"([^"|]+\.yml)\|(\d+)\|[^"|]+(?:\|[^"]*)?"/gm)]
    .map(m => [m[1], Number(m[2])])
);

// Max hours must exceed the worst real gap (GitHub-throttled hourly cron ~7h observed)
// but stay bounded so a dead cron still pages within a day.
const EXPECTED = { 'audit-aggregator-gap.yml': [8, 24], 'opening-night-reviews.yml': [7, 30] };

for (const [wf, [lo, hi]] of Object.entries(EXPECTED)) {
  test(`${wf} is in CRITICAL_CRONS with sane max_hours`, () => {
    assert.ok(entries.has(wf), `${wf} missing from CRITICAL_CRONS`);
    const h = entries.get(wf);
    assert.ok(h >= lo && h <= hi, `${wf} max_hours=${h} outside [${lo}, ${hi}]`);
  });
  test(`${wf} is not also in the exempt list`, () => {
    assert.ok(!exempt.split('\n').some(l => l.trim() === wf));
  });
}
