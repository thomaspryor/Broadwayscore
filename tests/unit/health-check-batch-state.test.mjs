// Task #547: index.ts's --batch mode (task #516) writes batchInFlight state to
// data/collection-state/scoring-batch-state.json but nothing read it — a batch
// that stalls past the poll budget scored zero new reviews with no distinct
// signal from "nothing needed scoring". This covers the age-threshold logic
// that promotes stale batch state into the daily digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { batchStateResult, checkBatchState } = require('../../scripts/health-check.js');

function hoursAgoIso(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

// Real batch-runner.ts output always carries both fields together; tests below
// build on this shape unless specifically probing a malformed file.
function validState(overrides = {}) {
  return { submittedAt: hoursAgoIso(1), itemCount: 392, manifest: [], ...overrides };
}

test('batchStateResult: absent state is pass, "no batch in flight"', () => {
  const result = batchStateResult(null);
  assert.equal(result.status, 'pass');
  assert.match(result.message, /no batch in flight/i);
});

test('batchStateResult: 1h-old batch is pass', () => {
  const result = batchStateResult(validState({ submittedAt: hoursAgoIso(1) }));
  assert.equal(result.status, 'pass');
  assert.match(result.message, /392 reviews/);
});

test('batchStateResult: 14h-old batch is warn and carries age + itemCount', () => {
  const result = batchStateResult(validState({ submittedAt: hoursAgoIso(14) }));
  assert.equal(result.status, 'warn');
  assert.match(result.message, /14h/);
  assert.match(result.message, /392 reviews/);
  assert.match(result.message, /next run resumes polling/);
});

test('batchStateResult: 30h-old batch is error (past the 24h vendor-expiry window)', () => {
  const result = batchStateResult(validState({ submittedAt: hoursAgoIso(30) }));
  assert.equal(result.status, 'error');
  assert.match(result.message, /392 reviews/);
  assert.ok(result.hint, 'error result should include a hint');
});

// Boundary fixtures sit a hair INSIDE the line, not exactly on it: the
// predicate is `age > 12`, and `hoursAgoIso(12)` is already 12h + however many
// milliseconds elapse before batchStateResult() reads the clock — so the
// "exactly 12h" case flipped to warn on a slow runner and reddened main
// (2026-08-03). 0.01h = 36s of slack, still far tighter than the 0.5h step
// the test is actually asserting.
test('batchStateResult: just under 12h is still pass, 12.5h flips to warn', () => {
  assert.equal(batchStateResult(validState({ submittedAt: hoursAgoIso(11.99), itemCount: 1 })).status, 'pass');
  assert.equal(batchStateResult(validState({ submittedAt: hoursAgoIso(12.5), itemCount: 1 })).status, 'warn');
});

// 23.99, not 24 — the sibling of the 11.99 fix above, which this test was left
// out of. Same bug, same file: the predicate is `age > 24`, and hoursAgoIso(24)
// is already 24h PLUS however many milliseconds elapse before batchStateResult()
// reads the clock, so on a slow runner it lands on the error side and reddens
// main. It did exactly that in run 31856551268 (2026-08-15, `not ok 2086`), on a
// commit that touched nothing in this code path. 0.01h = 36s of slack, still far
// tighter than the 0.5h step the test is actually asserting.
test('batchStateResult: 24h boundary is still warn, 24.5h flips to error', () => {
  assert.equal(batchStateResult(validState({ submittedAt: hoursAgoIso(23.99), itemCount: 1 })).status, 'warn');
  assert.equal(batchStateResult(validState({ submittedAt: hoursAgoIso(24.5), itemCount: 1 })).status, 'error');
});

test('batchStateResult: unparseable submittedAt is warn, not a crash', () => {
  const result = batchStateResult(validState({ submittedAt: 'not-a-date', itemCount: 5 }));
  assert.equal(result.status, 'warn');
  assert.match(result.message, /unparseable/i);
});

test('batchStateResult: missing itemCount defaults to 0 rather than throwing', () => {
  const result = batchStateResult({ submittedAt: hoursAgoIso(1), manifest: [] });
  assert.equal(result.status, 'pass');
  assert.match(result.message, /0 reviews/);
});

test('batchStateResult: state without a manifest array is treated as no batch (matches readBatchState() in index.ts)', () => {
  // A corrupt-but-parseable `{submittedAt}` alone is not real batch state —
  // index.ts's own reader requires Array.isArray(manifest) too, and would
  // silently ignore this file rather than resume from it.
  const result = batchStateResult({ submittedAt: hoursAgoIso(30), itemCount: 392 });
  assert.equal(result.status, 'pass');
  assert.match(result.message, /no batch in flight/i);
});

test('checkBatchState: reads the real file path — absent file is pass', () => {
  const [result] = checkBatchState();
  // Whatever the actual local dev checkout has (present or absent) must not throw.
  assert.ok(['pass', 'warn', 'error'].includes(result.status));
  assert.equal(result.name, 'Scoring: batch state');
});

test('checkBatchState: seeded 14h-old file on disk is read and flows through batchStateResult', () => {
  const stateDir = path.join(process.cwd(), 'data', 'collection-state');
  const statePath = path.join(stateDir, 'scoring-batch-state.json');
  const existed = fs.existsSync(statePath);
  const backup = existed ? fs.readFileSync(statePath, 'utf8') : null;
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    fs.writeFileSync(statePath, JSON.stringify(validState({ submittedAt: hoursAgoIso(14) })));
    const [result] = checkBatchState();
    assert.equal(result.status, 'warn');
    assert.match(result.message, /14h/);
  } finally {
    if (existed) fs.writeFileSync(statePath, backup);
    else fs.rmSync(statePath, { force: true });
  }
});

test('checkBatchState: malformed JSON on disk is warn, not a crash', () => {
  const stateDir = path.join(process.cwd(), 'data', 'collection-state');
  const statePath = path.join(stateDir, 'scoring-batch-state.json');
  const existed = fs.existsSync(statePath);
  const backup = existed ? fs.readFileSync(statePath, 'utf8') : null;
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    fs.writeFileSync(statePath, '{not valid json');
    const [result] = checkBatchState();
    assert.equal(result.status, 'warn');
    assert.match(result.message, /unparseable/i);
  } finally {
    if (existed) fs.writeFileSync(statePath, backup);
    else fs.rmSync(statePath, { force: true });
  }
});
