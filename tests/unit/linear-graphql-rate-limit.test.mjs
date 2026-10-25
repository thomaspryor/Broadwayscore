// tests/unit/linear-graphql-rate-limit.test.mjs
//
// Linear reports rate limiting in two shapes. One is an HTTP 429, which S1-T1's
// retry policy already handles. The other — observed live on 2026-08-20 during
// the S3-T7c corpus import — is an HTTP **200** whose GraphQL body carries
// "Rate limit exceeded. Only 2500 requests are allowed per 1 hour."
//
// Because res.ok was true, that response skipped every retry branch in
// graphql() and threw as an ordinary error. The importer graded 39 of them as
// "unexpected failures" and aborted a run that was only throttled. Sprint 7
// repoints ~66 scripts onto this client, so the misclassification would have
// been inherited fleet-wide.
//
// The payload in `rateLimitBody` below is the real one, copied from the failing
// run's output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const policy = require('../../scripts/lib/linear-retry-policy.js');

const rateLimitBody = {
  errors: [
    {
      message:
        'Rate limit exceeded. Only 2500 requests are allowed per 1 hour. ' +
        'For more information see our developer docs at: https://linear.app/developers/rate-limiting',
    },
  ],
};

test('the real observed rate-limit body is recognised', () => {
  assert.equal(policy.isRateLimitBody(rateLimitBody), true);
});

test('recognised via extensions.code when Linear supplies one', () => {
  assert.equal(
    policy.isRateLimitBody({ errors: [{ message: 'nope', extensions: { code: 'RATELIMITED' } }] }),
    true
  );
  assert.equal(
    policy.isRateLimitBody({ errors: [{ message: 'nope', extensions: { code: 'RATE_LIMIT_EXCEEDED' } }] }),
    true
  );
});

test('does not fire on unrelated GraphQL errors', () => {
  assert.equal(
    policy.isRateLimitBody({
      errors: [{ message: 'Entity Issue with id abc already exists.', extensions: { code: 'INPUT_ERROR' } }],
    }),
    false
  );
  assert.equal(policy.isRateLimitBody({ errors: [{ message: 'Argument Validation Error' }] }), false);
});

test('tolerates malformed bodies rather than throwing inside the transport', () => {
  for (const b of [null, undefined, {}, { errors: null }, { errors: [] }, { errors: [null] }, { errors: [{}] }]) {
    assert.equal(policy.isRateLimitBody(b), false);
  }
});

test('a synthetic 429 from a rate-limit body is judged retryable, mutation or not', () => {
  assert.equal(policy.shouldRetry({ status: 429, body: rateLimitBody, mutation: true }).retry, true);
  assert.equal(policy.shouldRetry({ status: 429, body: rateLimitBody, mutation: false }).retry, true);
});

test('REGRESSION: a 200 status alone is still not retryable — the client must supply the 429', () => {
  // Guards against someone "simplifying" isRetryableStatus to make this case
  // pass there instead, which would route every HTTP 200 down the retry path.
  assert.equal(policy.isRetryableStatus(200), false);
  assert.equal(policy.shouldRetry({ status: 200, body: rateLimitBody }).retry, false);
});

// ---------------------------------------------------------------------------
// Transport-level: the predicate is not the fix, graphql()'s behaviour is.
// Reuses the fetch-stub shape established in linear-client-backoff.test.mjs.
// ---------------------------------------------------------------------------

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.env.LINEAR_API_KEY = process.env.LINEAR_API_KEY || 'test-key-not-used';
const linear = require(path.join(REPO, 'scripts/lib/linear-client.js'));

const QUERY = 'query { viewer { id } }';
const MUTATION = 'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success } }';

function stubFetch(queue) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    const next = queue[calls.length];
    calls.push(1);
    if (!next) throw new Error(`no stubbed response queued for call #${calls.length}`);
    return { status: next.status, headers: next.headers || {}, json: async () => next.body };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const noSleep = async () => {};
const silent = () => {};

test('TRANSPORT: HTTP 200 + rate-limit body is retried, then succeeds', async () => {
  const s = stubFetch([
    { status: 200, body: rateLimitBody },
    { status: 200, body: { data: { viewer: { id: 'u1' } } } },
  ]);
  try {
    const data = await linear.graphql(QUERY, {}, { sleepFn: noSleep, onRetry: silent });
    assert.deepEqual(data, { viewer: { id: 'u1' } });
    assert.equal(s.calls.length, 2, 'expected exactly one retry — this is the whole fix');
  } finally {
    s.restore();
  }
});

test('TRANSPORT: a MUTATION is retried too — a throttled create never reached the server', async () => {
  // Distinct from the 5xx case, which stays un-retried because the write may
  // already have been applied. A rate-limited request was definitionally rejected.
  const s = stubFetch([
    { status: 200, body: rateLimitBody },
    { status: 200, body: { data: { issueCreate: { success: true } } } },
  ]);
  try {
    const data = await linear.graphql(MUTATION, {}, { sleepFn: noSleep, onRetry: silent });
    assert.deepEqual(data, { issueCreate: { success: true } });
    assert.equal(s.calls.length, 2);
  } finally {
    s.restore();
  }
});

test('TRANSPORT: a persistent rate limit throws a flagged, retryable HTTP 429', async () => {
  const s = stubFetch(Array.from({ length: 10 }, () => ({ status: 200, body: rateLimitBody })));
  try {
    await assert.rejects(
      () => linear.graphql(QUERY, {}, { sleepFn: noSleep, onRetry: silent }),
      (err) => {
        // "HTTP 429" in STATUS POSITION is what the fleet's transient
        // classifier matches on; without it this grades as permanent.
        assert.match(err.message, /HTTP 429/);
        assert.equal(err.status, 429);
        assert.equal(err.retryable, true);
        assert.equal(err.rateLimited, true, 'callers need this to say "resume after the window resets"');
        return true;
      }
    );
    assert.ok(s.calls.length > 1 && s.calls.length <= 10, `bounded attempts, got ${s.calls.length}`);
  } finally {
    s.restore();
  }
});

test('TRANSPORT REGRESSION: a non-rate-limit GraphQL error is NOT retried', async () => {
  // The already-exists 400 is load-bearing for import idempotency; retrying it
  // would turn a classified no-op into wasted requests against the same cap.
  const s = stubFetch([
    { status: 200, body: { errors: [{ message: 'Entity Issue with id abc already exists.' }] } },
  ]);
  try {
    await assert.rejects(() => linear.graphql(QUERY, {}, { sleepFn: noSleep, onRetry: silent }));
    assert.equal(s.calls.length, 1, 'must fail fast, exactly one call');
  } finally {
    s.restore();
  }
});
