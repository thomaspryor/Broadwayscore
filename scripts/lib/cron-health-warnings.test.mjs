import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseCronWarnings, recoveredFailureKeys, QUERY_FAILED_KEY } = require('./cron-health-warnings.js');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

test('each failing workflow becomes its own condition', () => {
  const text = '⚠️ Weekly Grosses: Latest run failed (last success 30h ago)\n⚠️ Update Lottery/Rush Data: Latest run failed (last success 80h ago)\n';
  const got = parseCronWarnings(text);
  assert.deepEqual(got.map((c) => c.conditionKey), ['cron-health-failed:Weekly Grosses', 'cron-health-failed:Update Lottery/Rush Data']);
  assert.match(got[0].description, /last success 30h ago/);
});

test('the run-history query failure is one fixed condition', () => {
  const got = parseCronWarnings('⚠️ Run-history query FAILED for: A, B — health UNKNOWN for these. Check gh auth.\n');
  assert.equal(got.length, 1);
  assert.equal(got[0].conditionKey, QUERY_FAILED_KEY);
});

test('blank, unknown and duplicate lines are ignored', () => {
  const got = parseCronWarnings('\n\nsomething else\n⚠️ X: Latest run failed (a)\n⚠️ X: Latest run failed (b)\n');
  assert.deepEqual(got.map((c) => c.conditionKey), ['cron-health-failed:X']);
  assert.deepEqual(parseCronWarnings(''), []);
  assert.deepEqual(parseCronWarnings(undefined), []);
});

test('recoveredFailureKeys returns open failure keys no longer warned about', () => {
  const ledger = {
    'cron-health-failed:A': { status: 'open' },
    'cron-health-failed:B': { status: 'open' },
    'cron-health-failed:C': { status: 'resolved' },
    'cron-health:Weekly Grosses': { status: 'open' },
    'cron-health:query-failed': { status: 'open' },
  };
  assert.deepEqual(recoveredFailureKeys(ledger, ['cron-health-failed:B']), ['cron-health-failed:A', 'cron-health:query-failed']);
});

test('the warning lines the workflow emits still match the parser', () => {
  // If check-cron-health.yml rewords its warning lines, the parser silently
  // drops them. Pin the two shapes to the workflow text.
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/check-cron-health.yml'), 'utf8');
  assert.match(yml, /⚠️ \$\{name\}: Latest run failed/);
  assert.match(yml, /⚠️ Run-history query FAILED for:/);
  assert.match(yml, /cron-health-warnings\.js/, 'workflow must route warnings through this parser');
  assert.doesNotMatch(yml, /Send warning Discord alert/, 'the dead Discord warning step must stay gone');
});
