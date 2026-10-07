import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { appendClaim, readClaims, activeClaimsAsTasks, CLAIM_TTL_MS } =
  require('../../scripts/lib/ci-red-claims.js');

function withTmpLedger(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-red-claims-'));
  const path = join(dir, 'ci-red-claims.jsonl');
  try { return fn(path); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('appendClaim requires taskId and at least one of symbol/runId', () => {
  withTmpLedger((path) => {
    assert.throws(() => appendClaim({ taskId: '1' }, path));
    assert.throws(() => appendClaim({ symbol: 'foo' }, path));
  });
});

test('appendClaim + readClaims round-trip', () => {
  withTmpLedger((path) => {
    appendClaim({ symbol: 'shouldShowSentiment', taskId: '563' }, path);
    appendClaim({ runId: '30120249897', taskId: '9' }, path);
    const claims = readClaims(path);
    assert.equal(claims.length, 2);
    assert.equal(claims[0].symbol, 'shouldShowSentiment');
    assert.equal(claims[0].taskId, '563');
    assert.equal(claims[1].runId, '30120249897');
  });
});

test('readClaims skips corrupt lines without throwing', () => {
  withTmpLedger((path) => {
    appendClaim({ symbol: 'foo', taskId: '1' }, path);
    require('fs').appendFileSync(path, 'not valid json\n');
    appendClaim({ symbol: 'bar', taskId: '2' }, path);
    const claims = readClaims(path);
    assert.equal(claims.length, 2);
  });
});

test('readClaims on missing file returns empty array (fail open)', () => {
  const claims = readClaims('/tmp/definitely-does-not-exist-ci-red-claims.jsonl');
  assert.deepEqual(claims, []);
});

test('activeClaimsAsTasks maps a fresh claim to an in_progress task-like shape', () => {
  withTmpLedger((path) => {
    appendClaim({ symbol: 'shouldShowSentiment', taskId: '563' }, path);
    const now = Date.now();
    const tasks = activeClaimsAsTasks(path, now);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, '563');
    assert.equal(tasks[0].status, 'in_progress');
    assert.match(tasks[0].subject, /shouldShowSentiment/);
  });
});

test('activeClaimsAsTasks drops claims older than CLAIM_TTL_MS', () => {
  withTmpLedger((path) => {
    appendClaim({ symbol: 'shouldShowSentiment', taskId: '563' }, path);
    const farFuture = Date.now() + CLAIM_TTL_MS + 1000;
    const tasks = activeClaimsAsTasks(path, farFuture);
    assert.equal(tasks.length, 0);
  });
});

test('activeClaimsAsTasks keeps a claim just under the TTL boundary', () => {
  withTmpLedger((path) => {
    appendClaim({ symbol: 'shouldShowSentiment', taskId: '563' }, path);
    const justBefore = Date.now() + CLAIM_TTL_MS - 1000;
    const tasks = activeClaimsAsTasks(path, justBefore);
    assert.equal(tasks.length, 1);
  });
});

test('activeClaimsAsTasks excludes the caller\'s own prior claim via excludeTaskId', () => {
  withTmpLedger((path) => {
    appendClaim({ symbol: 'shouldShowSentiment', taskId: '584' }, path);
    const now = Date.now();
    // Without exclusion: caller sees its own claim (would false-REFUSE itself).
    assert.equal(activeClaimsAsTasks(path, now).length, 1);
    // With exclusion: own claim is filtered out.
    assert.equal(activeClaimsAsTasks(path, now, '584').length, 0);
  });
});

test('activeClaimsAsTasks excludeTaskId only drops the matching claim, not others', () => {
  withTmpLedger((path) => {
    appendClaim({ symbol: 'shouldShowSentiment', taskId: '584' }, path);
    appendClaim({ symbol: 'otherSymbol', taskId: '563' }, path);
    const tasks = activeClaimsAsTasks(path, Date.now(), '584');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, '563');
  });
});
