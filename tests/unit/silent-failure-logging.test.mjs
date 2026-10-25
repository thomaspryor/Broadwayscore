/**
 * Unit tests for BRO-931 #1 (silent failure default — no logging on exclusions).
 *
 * Fear of 13 (2026-04-15) postmortem root cause: createReviewFile()
 * (scripts/gather-reviews.js) returns a string reason code on every skip
 * path, but the call site only counted/logged a result when it happened to
 * be a key in a hardcoded `health.rejections` enum. Several real skip
 * reasons ('blocklisted', 'staleFlagCollision', 'profileUrl',
 * 'crossMarketContamination') were never added to that enum, so they were
 * silently dropped: no counter, no log line, nothing an operator could grep.
 *
 * shouldLogRejection() (scripts/lib/gather-review-stats.js) replaces the
 * enum-membership check with "any string result is real and must be
 * logged" — this test require()s the REAL function (never copies logic,
 * CLAUDE.md §15) and proves two things: (1) every skip reason
 * createReviewFile actually returns is caught, including the ones that
 * were previously silent, and (2) the exclusion actually lands in the
 * shared audit trail (scripts/lib/exclusion-logger.js), the same mechanism
 * rebuild-all-reviews.js uses.
 *
 * Run: node --test tests/unit/silent-failure-logging.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { shouldLogRejection } = require('../../scripts/lib/gather-review-stats');

// The pre-fix hardcoded enum from gather-reviews.js (health.rejections
// initializer) — kept here ONLY to prove the fix's coverage is now a
// strict superset of it, not as a source of truth to copy logic from.
const OLD_ENUM_KEYS = new Set([
  'junkOutlet', 'suspiciousOutlet', 'nonBroadway', 'tourReview',
  'crossMarketBroadway', 'nonReviewPath', 'roundupUrl', 'wrongProduction',
  'duplicate', 'crossShow', 'crossShowUrl', 'domainMismatch',
  'aggregatorUrlMismatch', 'nullUrl',
]);

// Every string createReviewFile() actually returns on a skip path, scraped
// live from source so this test fails the moment a new skip reason is added
// without exercising the real logging path — the exact class of gap that
// caused the incident.
function extractCreateReviewFileSkipCodes() {
  const src = fs.readFileSync(path.resolve(__dirname, '../../scripts/gather-reviews.js'), 'utf8');
  const fnStart = src.indexOf('function createReviewFile(');
  assert.ok(fnStart !== -1, 'createReviewFile not found in gather-reviews.js — has it moved?');
  // Function is long; bound the scan at the next top-level function declaration
  // that starts a new "function X(" after a blank line at column 0.
  const nextFnMatch = src.slice(fnStart + 30).search(/\nfunction [a-zA-Z_]+\(/);
  const fnEnd = nextFnMatch === -1 ? src.length : fnStart + 30 + nextFnMatch;
  const body = src.slice(fnStart, fnEnd);
  const codes = new Set();
  for (const m of body.matchAll(/return '([a-zA-Z]+)';/g)) {
    codes.add(m[1]);
  }
  return codes;
}

describe('silent-failure-logging — shouldLogRejection catches every real skip code', () => {
  it('TC1: every code createReviewFile() actually returns → shouldLogRejection true', () => {
    const codes = extractCreateReviewFileSkipCodes();
    assert.ok(codes.size >= 15, `expected to find 15+ skip codes, found ${codes.size}: ${[...codes].join(',')}`);
    for (const code of codes) {
      assert.strictEqual(shouldLogRejection(code), true, `skip code "${code}" must be logged`);
    }
  });

  it('TC2: the previously-silent codes (not in the old hardcoded enum) are logged', () => {
    const codes = extractCreateReviewFileSkipCodes();
    const previouslySilent = [...codes].filter(c => !OLD_ENUM_KEYS.has(c));
    assert.ok(previouslySilent.length > 0, 'expected at least one skip code missing from the old enum (the actual bug)');
    for (const code of previouslySilent) {
      assert.strictEqual(shouldLogRejection(code), true, `previously-silent code "${code}" must now be logged`);
    }
  });

  it('TC3: success (true) is not logged as a rejection', () => {
    assert.strictEqual(shouldLogRejection(true), false);
  });

  it('TC4: undefined/non-string results are not logged', () => {
    assert.strictEqual(shouldLogRejection(undefined), false);
    assert.strictEqual(shouldLogRejection(null), false);
    assert.strictEqual(shouldLogRejection(''), false);
  });
});

describe('silent-failure-logging — end-to-end: rejection reaches the audit trail', () => {
  it('TC5: a reason missing from the old enum still lands in exclusions-*.jsonl', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-failure-test-'));
    const loggerPath = path.resolve(__dirname, '../../scripts/lib/exclusion-logger.js');
    delete require.cache[loggerPath];
    process.env.EXCLUSION_LOGGER_AUDIT_DIR = tmpDir;
    const { logExclusion, getTodayJsonlPath, _resetForTest } = require('../../scripts/lib/exclusion-logger');
    _resetForTest();

    const reason = 'crossMarketContamination'; // one of the previously-silent codes
    assert.ok(!OLD_ENUM_KEYS.has(reason), 'sanity: this reason must be one the old enum never counted');
    assert.strictEqual(shouldLogRejection(reason), true);

    logExclusion({
      script: 'gather-reviews',
      showId: 'fear-of-13-2026',
      file: 'nytimes--ben-brantley.json',
      reason,
      details: { url: 'https://example.com/review' },
    });

    const lines = fs.readFileSync(getTodayJsonlPath(), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].reason, reason);
    assert.strictEqual(lines[0].showId, 'fear-of-13-2026');

    delete process.env.EXCLUSION_LOGGER_AUDIT_DIR;
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('silent-failure-logging — second createReviewFile caller is also covered', () => {
  it('TC6: opening-night-poller.js routes its createReviewFile rejections through the same shared logger (adversarial ship-check finding)', () => {
    // gather-reviews.js is not the only caller of createReviewFile —
    // opening-night-poller.js calls it too, and originally only fed a blind
    // `rejected++` counter with no per-reason breakdown: the same silent-
    // failure pattern this whole fix exists to close, just a second,
    // uncovered call site of the same function. Static-source check (not a
    // full poller run, which needs heavy fs/network mocking) proving the
    // wiring exists: shouldLogRejection gates a logExclusion call in the
    // same branch that increments `rejected`.
    const src = fs.readFileSync(path.resolve(__dirname, '../../scripts/opening-night-poller.js'), 'utf8');
    const rejectedIdx = src.indexOf('rejected++');
    assert.ok(rejectedIdx !== -1, 'opening-night-poller.js should still increment a rejected counter');
    const nearby = src.slice(Math.max(0, rejectedIdx - 400), rejectedIdx + 900);
    assert.ok(nearby.includes('shouldLogRejection'), 'the rejected++ branch must be gated by shouldLogRejection');
    assert.ok(nearby.includes('logExclusion({'), 'the rejected++ branch must call the shared logExclusion');
    assert.ok(nearby.includes("script: 'opening-night-poller'"), 'the log record must identify its own script name, not borrow gather-reviews\' identity');
  });
});
