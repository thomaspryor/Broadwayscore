import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyStashedFile,
  classifyStashEntry,
  isTelemetryPath,
  formatKept,
} = require('./stash-truncation.js');

test('telemetry paths are recognised as discardable churn', () => {
  assert.equal(isTelemetryPath('data/audit/scraper-spend-ledger.jsonl'), true);
  assert.equal(isTelemetryPath('scripts/lib/backlog-drain.js'), false);
  assert.equal(isTelemetryPath('src/app/page.tsx'), false);
});

test('scratchpad/ is NOT telemetry — it carries tracked files on main', () => {
  // scratchpad/dispatch-s3-morning.sh is tracked. Treating the prefix as churn
  // would let a stash that truncates it roll up to telemetry-only and exit 0.
  assert.equal(isTelemetryPath('scratchpad/dispatch-s3-morning.sh'), false);
  const v = classifyStashedFile({
    path: 'scratchpad/dispatch-s3-morning.sh',
    stashedLines: 1,
    baseLines: 120,
    infraTier: null,
  });
  assert.equal(v.verdict, 'truncated');
  assert.equal(v.severity, 'danger');
});

test('a surviving line never renders as "0% kept"', () => {
  assert.equal(formatKept(1, 231), '<1%');
  assert.equal(formatKept(0, 231), '0%');
  assert.equal(formatKept(50, 100), '50%');
  const v = classifyStashedFile({
    path: 'scripts/lib/backlog-drain.js',
    stashedLines: 1,
    baseLines: 231,
    infraTier: 'critical',
  });
  assert.match(v.reason, /<1% kept/);
  assert.doesNotMatch(v.reason, /\(0% kept\)/);
});

test('an undiffable file is judged on BYTES, not exempted', () => {
  // A previous version of this test asserted binaries are never dangerous.
  // That locked in a false-safe: git marks any file containing a NUL byte as
  // undiffable, and a half-written stub is exactly that shape — so a
  // truncation of a critical file was downgraded to INSPECT and exited 0.
  const truncatedStub = classifyStashedFile({
    path: 'scripts/lib/backlog-drain.js',
    stashedLines: 1,
    baseLines: 231,
    infraTier: 'critical',
    binary: true,
    stashedBytes: 37,
    baseBytes: 9000,
  });
  assert.equal(truncatedStub.verdict, 'truncated');
  assert.equal(truncatedStub.severity, 'danger');
  assert.match(truncatedStub.reason, /measured in bytes/);
});

test('a real binary asset edited normally is not flagged', () => {
  const v = classifyStashedFile({
    path: 'public/images/poster.png',
    stashedLines: 3,
    baseLines: 900,
    infraTier: null,
    binary: true,
    stashedBytes: 41000,
    baseBytes: 42000,
  });
  assert.equal(v.verdict, 'code');
  assert.notEqual(v.severity, 'danger');
  assert.match(v.reason, /binary/);
});

test('an undiffable file whose size cannot be read blocks rather than passing', () => {
  const v = classifyStashedFile({
    path: 'scripts/lib/backlog-drain.js',
    stashedLines: 1,
    baseLines: 231,
    infraTier: 'critical',
    binary: true,
    stashedBytes: null,
    baseBytes: null,
  });
  assert.equal(v.verdict, 'error');
  assert.equal(v.severity, 'danger');
});

test('a tiny binary is not ratio-judged (below the byte floor)', () => {
  const v = classifyStashedFile({
    path: 'public/tiny.ico',
    stashedLines: 1,
    baseLines: 2,
    infraTier: null,
    binary: true,
    stashedBytes: 10,
    baseBytes: 100,
  });
  assert.equal(v.verdict, 'code');
  assert.notEqual(v.severity, 'danger');
});

test('an entry git could not enumerate is DANGER, never ok', () => {
  // A guard that examined nothing must not report what a passing guard reports.
  const e = classifyStashEntry([], { enumerationFailed: true });
  assert.equal(e.verdict, 'unreadable');
  assert.equal(e.danger, true);
});

test('an unreadable path inside an entry escalates the whole entry', () => {
  const e = classifyStashEntry([
    { verdict: 'telemetry', severity: 'none' },
    { verdict: 'error', severity: 'danger' },
  ]);
  assert.equal(e.verdict, 'unreadable');
  assert.equal(e.danger, true);
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
