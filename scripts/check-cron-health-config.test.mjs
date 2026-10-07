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
const rows = [...block.slice(0, block.indexOf('\n          )')).matchAll(/^\s*"([^"|]+\.yml)\|(\d+)\|[^"|]+(?:\|[^"]*)?"/gm)]
  .map(m => [m[1], Number(m[2])]);
const entries = new Map(rows);

// Exact max_hours as registered (BRO-1618): hourly census 3h, rolling ~3h-cadence carrier 5h.
const EXPECTED = { 'audit-aggregator-gap.yml': [3, 3], 'opening-night-reviews.yml': [5, 5] };

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
    assert.ok(!exempt.split('\n').some(l => l.trim() === wf));
  });
}
