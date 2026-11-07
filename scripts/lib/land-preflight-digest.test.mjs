import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { computeLandPreflightDigest } = require('./land-preflight-digest.js');
const { formatReceipt, parseReceipt, evaluateReceipt } = require('./review-receipt.js');

const now = Date.parse('2026-10-29T12:00:00Z');
const H = 'f'.repeat(64);

test('digest: blocked, allowed and stale-container landings are told apart', () => {
  const d = computeLandPreflightDigest({
    now,
    hookEvents: [
      { ts: '2026-10-29T09:00:00Z', event: 'review-coverage-block', reason: 'review coverage incomplete' },
      { ts: '2026-10-29T09:30:00Z', event: 'review-coverage-allow', reason: 'ship-check coverage complete', target: 'land/ok' },
      { ts: '2026-10-29T09:31:00Z', event: 'review-coverage-allow', reason: 'NO-SHIP-CHECK bypass: reason text here', target: 'land/bypass' },
    ],
    landings: [
      { ts: '2026-10-29T09:40:00Z', branch: 'land/ok', sha: 'a', receipt: 'present' },
      { ts: '2026-10-29T10:00:00Z', branch: 'land/stale', sha: 'b', receipt: 'missing' },
      { ts: '2026-10-29T10:05:00Z', branch: 'land/bypass', sha: 'c', receipt: 'missing' },
      { ts: '2026-10-29T10:06:00Z', branch: 'land/old', sha: 'd' },
    ],
  });
  assert.equal(d.blocked, 1);
  assert.equal(d.allowed, 2);
  assert.equal(d.bypassed, 1);
  assert.deepEqual(d.stale, [{ branch: 'land/stale', sha: 'b', receipt: 'missing' }]);
  assert.equal(d.status, 'warn');
  assert.deepEqual(d.byReceipt, { present: 1, missing: 2, unknown: 1 });
});

test('digest: events outside the window are ignored; clean day passes', () => {
  const d = computeLandPreflightDigest({ now, hookEvents: [{ ts: '2026-10-20T00:00:00Z', event: 'review-coverage-block' }], landings: [{ ts: '2026-10-20T00:00:00Z', branch: 'x', receipt: 'missing' }] });
  assert.equal(d.status, 'pass');
  assert.equal(d.blocked, 0);
});

test('receipt: format/parse round trip and evaluation', () => {
  const line = formatReceipt({ outputsHash: H, invocationId: 'toolu_1', checks: [] });
  assert.equal(line, `Review-Receipt: v1 ${H} toolu_1`);
  assert.deepEqual(parseReceipt(['x', `msg\n\n${line}`]), { outputsHash: H, invocationId: 'toolu_1' });
  assert.equal(formatReceipt({ outputsHash: 'short', invocationId: 'x' }), null);
  assert.equal(evaluateReceipt({ gatedLines: 10, messages: [] }).status, 'not-required');
  assert.equal(evaluateReceipt({ gatedLines: 31, messages: ['plain'] }).status, 'missing');
  assert.equal(evaluateReceipt({ gatedLines: 31, messages: [`m\n\n${line}`] }).status, 'present');
  assert.equal(evaluateReceipt({ gatedLines: 31, messages: ['Review-Receipt: v1 nothex id'] }).status, 'malformed');
});
