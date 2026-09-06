import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyStashedFile,
  classifyStashEntry,
  isTelemetryPath,
} = require('./stash-truncation.js');

test('telemetry paths are recognised as discardable churn', () => {
  assert.equal(isTelemetryPath('data/audit/scraper-spend-ledger.jsonl'), true);
  assert.equal(isTelemetryPath('scratchpad/lq.js'), true);
  assert.equal(isTelemetryPath('scripts/lib/backlog-drain.js'), false);
  assert.equal(isTelemetryPath('src/app/page.tsx'), false);
});

test('the real 2026-09-06 case: backlog-drain.js at 1 line against 231 is a truncation', () => {
  const v = classifyStashedFile({
    path: 'scripts/lib/backlog-drain.js',
    stashedLines: 1,
    baseLines: 231,
    infraTier: 'critical',
  });
  assert.equal(v.verdict, 'truncated');
  assert.equal(v.severity, 'danger');
  assert.match(v.reason, /do NOT apply/);
  assert.match(v.reason, /CRITICAL/);
});

test('a telemetry path is classified as telemetry even when it changes enormously', () => {
  // wt-integ-94224 also dropped 14069 lines of scraper-spend-ledger.jsonl.
  const v = classifyStashedFile({
    path: 'data/audit/scraper-spend-ledger.jsonl',
    stashedLines: 12,
    baseLines: 14081,
    infraTier: null,
  });
  assert.equal(v.verdict, 'telemetry');
  assert.equal(v.severity, 'none');
});

test('an ordinary edit to a large file is not flagged as a truncation', () => {
  const v = classifyStashedFile({
    path: 'scripts/gather-reviews.js',
    stashedLines: 900,
    baseLines: 1000,
    infraTier: null,
  });
  assert.equal(v.verdict, 'code');
  assert.notEqual(v.severity, 'danger');
});

test('a moderate shrink is INSPECT, not DANGER', () => {
  const v = classifyStashedFile({
    path: 'scripts/gather-reviews.js',
    stashedLines: 500,
    baseLines: 1000,
    infraTier: null,
  });
  assert.equal(v.verdict, 'shrunk');
  assert.equal(v.severity, 'warn');
});

test('small files are never ratio-judged (a 6-line file dropping to 2 proves nothing)', () => {
  const v = classifyStashedFile({
    path: 'scripts/tiny.js',
    stashedLines: 2,
    baseLines: 6,
    infraTier: null,
  });
  assert.equal(v.verdict, 'code');
  assert.notEqual(v.severity, 'danger');
});

test('a file the stash deletes is flagged, and harder when it is critical infra', () => {
  const plain = classifyStashedFile({
    path: 'scripts/whatever.js',
    stashedLines: null,
    baseLines: 120,
    infraTier: null,
  });
  assert.equal(plain.verdict, 'deleted');
  assert.equal(plain.severity, 'warn');

  const critical = classifyStashedFile({
    path: 'scripts/lib/backlog-drain.js',
    stashedLines: null,
    baseLines: 231,
    infraTier: 'critical',
  });
  assert.equal(critical.verdict, 'deleted');
  assert.equal(critical.severity, 'danger');
});

test('a newly added file overwrites nothing', () => {
  const v = classifyStashedFile({
    path: 'scripts/brand-new.js',
    stashedLines: 3,
    baseLines: null,
    infraTier: null,
  });
  assert.equal(v.verdict, 'added');
  assert.equal(v.severity, 'info');
});

test('entry rollup: telemetry-only entries are not dangerous', () => {
  const e = classifyStashEntry([
    { verdict: 'telemetry', severity: 'none' },
    { verdict: 'telemetry', severity: 'none' },
  ]);
  assert.equal(e.verdict, 'telemetry-only');
  assert.equal(e.danger, false);
});

test('entry rollup: one truncation makes the whole entry dangerous to apply', () => {
  const e = classifyStashEntry([
    { verdict: 'telemetry', severity: 'none' },
    { verdict: 'truncated', severity: 'danger' },
  ]);
  assert.equal(e.verdict, 'dangerous-to-apply');
  assert.equal(e.danger, true);
});

test('entry rollup: a warn without a danger is INSPECT, and an empty entry is empty', () => {
  const inspect = classifyStashEntry([{ verdict: 'shrunk', severity: 'warn' }]);
  assert.equal(inspect.verdict, 'inspect');
  assert.equal(inspect.danger, false);

  const empty = classifyStashEntry([]);
  assert.equal(empty.verdict, 'empty');
  assert.equal(empty.danger, false);
});
