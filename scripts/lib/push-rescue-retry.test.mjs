// BRO-7541: replay fetches must survive the shallow-file race that failed every replay run 2026-11-12..15.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { retryFetch, isTransientGitError } = createRequire(import.meta.url)('./push-rescue.js');

const noSleep = () => {};
test('retries the shallow-file race and then succeeds', () => {
  let n = 0; const seen = [];
  const run = (args) => { seen.push(args); n++; if (n < 3) throw new Error('git fetch failed: fatal: shallow file has changed since we read it'); return 'ok'; };
  assert.equal(retryFetch(['--depth=1', 'origin', 'main'], {}, { run, sleep: noSleep }), 'ok');
  assert.equal(n, 3);
  assert.deepEqual(seen[0].slice(0, 4), ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false']);
  assert.ok(seen[0].includes('fetch'));
});
test('gives up after 3 attempts and rethrows', () => {
  let n = 0;
  const run = () => { n++; throw new Error('shallow file has changed since we read it'); };
  assert.throws(() => retryFetch(['x'], {}, { run, sleep: noSleep }), /shallow file has changed/);
  assert.equal(n, 3);
});
test('does not retry a permanent error', () => {
  let n = 0;
  const run = () => { n++; throw new Error("fatal: couldn't find remote ref refs/heads/nope"); };
  assert.throws(() => retryFetch(['x'], {}, { run, sleep: noSleep }));
  assert.equal(n, 1);
});
test('transient classifier', () => {
  assert.ok(isTransientGitError('error: RPC failed; HTTP 503'));
  assert.ok(!isTransientGitError('CONFLICT in file'));
});

import { describeReviewFile } from '../lib/push-rescue.js';
test('describeReviewFile reports metadata only, never text', () => {
  const secret = 'SECRET REVIEW BODY';
  const d = describeReviewFile(JSON.stringify({ fullText: secret, contentTier: 'truncated', criticName: null, llmScore: 70, wrongShow: true, scoredAt: '2026-11-11T10:00:00Z', publishDate: '2026-11-01' }));
  assert.match(d, /fullTextLen=18 contentTier=truncated assignedScore=no llmScore=yes criticName=null flags=wrongShow newest=scoredAt:2026-11-11T10:00:00.000Z/);
  assert.ok(!d.includes(secret));
  assert.equal(describeReviewFile(''), 'absent');
  assert.match(describeReviewFile('{oops'), /unparseable-json/);
});

test('describeReviewFile does not echo free-form field values', () => {
  const d = describeReviewFile(JSON.stringify({ contentTier: 'SECRET\nINJECT', scoredAt: 'SECRET not a date', publishDate: '2026-11-11' }));
  assert.ok(!/SECRET|INJECT/.test(d));
  assert.match(d, /contentTier=other/);
  assert.match(d, /newest=publishDate:2026-11-11T00:00:00.000Z/);
  assert.match(describeReviewFile('[1,2]'), /non-object/);
});
