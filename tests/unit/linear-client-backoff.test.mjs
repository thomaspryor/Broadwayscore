// tests/unit/linear-client-backoff.test.mjs — S1-T1 of the Notion→Linear
// cutover (sprint-plan-notion-linear-cutover.md).
//
// Before this, there was zero rate-limit handling anywhere in the Linear path.
// Sprint 3 pushes 1,831 issue creations through scripts/lib/linear-client.js's
// graphql(), so the transport has to survive a 429 — and, just as importantly,
// has to NOT paper over the two things a blind retry would break:
//   * USAGE_LIMIT_EXCEEDED (the free-tier 250-issue cap) arriving under a
//     retryable status, which must still reach isUsageLimitExceeded()
//   * a 5xx on a MUTATION, which may already have been applied server-side
//
// Covers both the pure policy (scripts/lib/linear-retry-policy.js) and the
// transport that consumes it. The policy is require()d, never restated
// (CLAUDE.md rule 15).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

process.env.LINEAR_API_KEY = process.env.LINEAR_API_KEY || 'test-key-not-used';

const policy = require(path.join(REPO, 'scripts/lib/linear-retry-policy.js'));
const linear = require(path.join(REPO, 'scripts/lib/linear-client.js'));
const { isUsageLimitExceeded } = require(path.join(REPO, 'scripts/lib/linear-issue-create.js'));

const QUERY = 'query { viewer { id } }';
const MUTATION = 'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success } }';

// --- fetch stub -------------------------------------------------------------
// Queue of responses; each is either {status, body, headers} or an Error to
// throw (for the network-failure paths). Records every call so the tests can
// assert on the ATTEMPT COUNT, which is the bounded-retry contract.
function stubFetch(queue) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    const next = queue[calls.length];
    calls.push(1);
    if (!next) throw new Error(`no stubbed response queued for call #${calls.length}`);
    if (next instanceof Error) throw next;
    return {
      status: next.status,
      headers: next.headers || {},
      json: async () => next.body,
    };
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const noSleep = async () => {};
const silent = () => {};

// --- transport: the two acceptance criteria ---------------------------------

test('a 429 followed by a 200 resolves with the data', async () => {
  const s = stubFetch([
    { status: 429, body: {} },
    { status: 200, body: { data: { viewer: { id: 'u1' } } } },
  ]);
  try {
    const data = await linear.graphql(QUERY, {}, { sleepFn: noSleep, onRetry: silent });
    assert.deepEqual(data, { viewer: { id: 'u1' } });
    assert.equal(s.calls.length, 2, 'expected exactly one retry');
  } finally {
    s.restore();
  }
});

test('a persistent 429 throws after the bounded attempt count, naming the status', async () => {
  const s = stubFetch(Array.from({ length: 10 }, () => ({ status: 429, body: {} })));
  try {
    await assert.rejects(
      () => linear.graphql(QUERY, {}, { maxAttempts: 4, sleepFn: noSleep, onRetry: silent }),
      (err) => {
        assert.match(err.message, /429/, 'error message must name the status code');
        assert.equal(err.status, 429);
        assert.equal(err.retryable, true);
        return true;
      }
    );
    assert.equal(s.calls.length, 4, 'bounded: exactly maxAttempts requests, no more');
  } finally {
    s.restore();
  }
});

test('the exhaustion error is graded TRANSIENT by the fleet-wide classifier', async () => {
  // autonomous-triage-core.js requires the code in STATUS POSITION ("HTTP 429",
  // not a bare "429"). This is why the message says "Linear API HTTP 429 …" —
  // asserting it here means a future reword cannot silently regrade every
  // Linear rate-limit into a permanent failure.
  // The predicate itself is module-private, so this drives it through its one
  // public consumer, fetchCardWithRetry: `permanent: false` in the result IS
  // isTransientFetchError() returning true for our error.
  const { fetchCardWithRetry } = require(path.join(REPO, 'scripts/lib/autonomous-triage-core.js'));
  const s = stubFetch(Array.from({ length: 3 }, () => ({ status: 429, body: {} })));
  let err;
  try {
    err = await linear
      .graphql(QUERY, {}, { maxAttempts: 2, sleepFn: noSleep, onRetry: silent })
      .then(() => null, (e) => e);
  } finally {
    s.restore();
  }
  assert.ok(err, 'expected a throw');
  const graded = await fetchCardWithRetry('card-1', async () => {
    throw err;
  }, { retries: 1, sleepFn: noSleep });
  assert.equal(graded.ok, false);
  assert.equal(graded.permanent, false, `classifier read this as permanent: ${err.message}`);
  assert.equal(graded.attempts, 2, 'a transient error must actually be retried');
});

// --- the two things a blind retry would have broken -------------------------

test('USAGE_LIMIT_EXCEEDED under a 429 is not retried and keeps err.linearErrors', async () => {
  const body = {
    errors: [{ message: 'usage limit', extensions: { code: 'USAGE_LIMIT_EXCEEDED' } }],
  };
  const s = stubFetch([{ status: 429, body }, { status: 200, body: { data: {} } }]);
  try {
    const err = await linear
      .graphql(MUTATION, {}, { sleepFn: noSleep, onRetry: silent })
      .then(() => null, (e) => e);
    assert.ok(err, 'expected a throw');
    assert.equal(s.calls.length, 1, 'a hard cap must not be retried');
    assert.equal(err.retryable, false);
    assert.ok(Array.isArray(err.linearErrors), 'linearErrors must survive a retryable status');
    assert.equal(
      isUsageLimitExceeded(err),
      true,
      'the free-tier cap message must still fire — this is what goes silent if the body is discarded'
    );
  } finally {
    s.restore();
  }
});

test('a 5xx is retried for a read but fails closed for a mutation', async () => {
  const read = stubFetch([
    { status: 503, body: {} },
    { status: 200, body: { data: { ok: true } } },
  ]);
  try {
    assert.deepEqual(await linear.graphql(QUERY, {}, { sleepFn: noSleep, onRetry: silent }), { ok: true });
    assert.equal(read.calls.length, 2);
  } finally {
    read.restore();
  }

  const write = stubFetch([
    { status: 503, body: {} },
    { status: 200, body: { data: { ok: true } } },
  ]);
  try {
    const err = await linear
      .graphql(MUTATION, {}, { sleepFn: noSleep, onRetry: silent })
      .then(() => null, (e) => e);
    assert.ok(err, 'a 502/503 on a mutation may already have been applied — it must not replay');
    assert.equal(write.calls.length, 1);
    assert.equal(err.status, 503);
    assert.equal(err.retryable, false);
    assert.match(err.message, /mutation-5xx-ambiguous/);
  } finally {
    write.restore();
  }
});

test('an idempotent caller can opt a mutation into 5xx retries', async () => {
  const s = stubFetch([
    { status: 500, body: {} },
    { status: 200, body: { data: { ok: true } } },
  ]);
  try {
    const data = await linear.graphql(MUTATION, {}, {
      retryMutationsOn5xx: true,
      sleepFn: noSleep,
      onRetry: silent,
    });
    assert.deepEqual(data, { ok: true });
    assert.equal(s.calls.length, 2);
  } finally {
    s.restore();
  }
});

test('a 30s AbortSignal timeout retries a read and rethrows for a mutation', async () => {
  const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

  const read = stubFetch([timeout(), { status: 200, body: { data: { ok: true } } }]);
  try {
    assert.deepEqual(await linear.graphql(QUERY, {}, { sleepFn: noSleep, onRetry: silent }), { ok: true });
    assert.equal(read.calls.length, 2);
  } finally {
    read.restore();
  }

  const write = stubFetch([timeout(), { status: 200, body: { data: { ok: true } } }]);
  try {
    await assert.rejects(() => linear.graphql(MUTATION, {}, { sleepFn: noSleep, onRetry: silent }), /aborted/);
    assert.equal(write.calls.length, 1);
  } finally {
    write.restore();
  }
});

test('a non-retryable status still reaches the existing GraphQL-error path', async () => {
  // 400 must NOT be intercepted: withArchivedIssueRetry()'s isArchivedIssueError
  // branches on err.linearErrors, and the whole unarchive-and-retry recovery
  // depends on that body surviving.
  const s = stubFetch([{ status: 400, body: { errors: [{ message: 'Entity not found: Issue' }] } }]);
  try {
    const err = await linear.graphql(QUERY, {}, { sleepFn: noSleep, onRetry: silent }).then(() => null, (e) => e);
    assert.match(err.message, /Linear GraphQL error/);
    assert.equal(err.linearErrors.length, 1);
    assert.equal(s.calls.length, 1);
  } finally {
    s.restore();
  }
});

// --- pure policy ------------------------------------------------------------

test('isMutation fails closed on anything it does not recognise as a read', () => {
  assert.equal(policy.isMutation(MUTATION), true);
  assert.equal(policy.isMutation('  mutation($id: String!) { issueArchive(id: $id) { success } }'), true);
  assert.equal(policy.isMutation(QUERY), false);
  assert.equal(policy.isMutation('{ viewer { id } }'), false);
  assert.equal(policy.isMutation(''), true, 'unknown shape must be treated as a write');
  assert.equal(policy.isMutation('fragment F on Issue { id }'), true);
});

test('every mutation string in linear-client.js is classified as a mutation', () => {
  // Guards against a future query-text edit silently reclassifying a write as a
  // read and re-enabling 5xx replay for it.
  const src = require('node:fs').readFileSync(path.join(REPO, 'scripts/lib/linear-client.js'), 'utf8');
  const docs = [...src.matchAll(/`(\s*(?:query|mutation)\b[\s\S]*?)`/g)].map((m) => m[1]);
  assert.ok(docs.length >= 6, `expected to find the inline GraphQL documents, found ${docs.length}`);
  for (const doc of docs) {
    const expected = /^\s*mutation\b/.test(doc);
    assert.equal(policy.isMutation(doc), expected, `misclassified: ${doc.trim().slice(0, 60)}`);
  }
});

test('parseRetryAfter handles seconds, HTTP-dates and garbage', () => {
  const now = Date.parse('2026-08-17T00:00:00Z');
  assert.equal(policy.parseRetryAfter('120', now), 120_000);
  assert.equal(policy.parseRetryAfter('Mon, 17 Aug 2026 00:00:30 GMT', now), 30_000);
  assert.equal(policy.parseRetryAfter('Mon, 17 Aug 2026 00:00:00 GMT', now), 0);
  assert.equal(policy.parseRetryAfter('not-a-date', now), null);
  assert.equal(policy.parseRetryAfter(null, now), null);
  assert.equal(policy.parseRetryAfter('', now), null);
});

test('retryDelayMs prefers Retry-After, then the reset header, then exponential — always capped', () => {
  const now = Date.parse('2026-08-17T00:00:00Z');
  const fixed = { baseMs: 1000, nowMs: now, random: () => 1 };

  assert.equal(policy.retryDelayMs(1, { 'retry-after': '5' }, fixed), 5000);

  // Linear's real header, verified against a live response 2026-08-17: an epoch
  // MILLISECOND timestamp that can sit a full hour out. Honouring it literally
  // would be indistinguishable from a hang, so it clamps.
  assert.equal(policy.retryDelayMs(1, { 'x-ratelimit-requests-reset': String(now + 3_600_000) }, fixed), 60_000);
  assert.equal(policy.retryDelayMs(1, { 'x-ratelimit-requests-reset': String(now + 4_000) }, fixed), 4_000);

  // A reset already in the past means the window rolled — fall through to
  // exponential rather than returning 0 and hot-looping.
  assert.equal(policy.retryDelayMs(2, { 'x-ratelimit-requests-reset': String(now - 5_000) }, fixed), 2000);

  assert.equal(policy.retryDelayMs(1, null, fixed), 1000);
  assert.equal(policy.retryDelayMs(3, null, fixed), 4000);
  assert.equal(policy.retryDelayMs(20, null, fixed), 60_000, 'must clamp, never overflow into a hang');

  // Jitter never collapses to ~0 and never exceeds the un-jittered value.
  const low = policy.retryDelayMs(3, null, { ...fixed, random: () => 0 });
  assert.equal(low, 2000);
  assert.ok(low >= 4000 * 0.5);
});

test('retryDelayMs reads a real fetch Headers instance, not just a plain object', () => {
  const h = new Headers({ 'Retry-After': '7' });
  assert.equal(policy.retryDelayMs(1, h, { baseMs: 1000, nowMs: Date.now(), random: () => 1 }), 7000);
});

test('shouldRetry: 429 always, 5xx only for reads, never on a non-transient code', () => {
  assert.equal(policy.shouldRetry({ status: 429, mutation: true }).retry, true);
  assert.equal(policy.shouldRetry({ status: 500, mutation: false }).retry, true);
  assert.equal(policy.shouldRetry({ status: 500, mutation: true }).retry, false);
  assert.equal(policy.shouldRetry({ status: 200, mutation: false }).retry, false);
  assert.equal(policy.shouldRetry({ status: 400, mutation: false }).retry, false);
  assert.equal(policy.shouldRetry({ status: undefined, mutation: false }).retry, false);
  const capped = policy.shouldRetry({
    status: 429,
    mutation: false,
    body: { errors: [{ extensions: { code: 'USAGE_LIMIT_EXCEEDED' } }] },
  });
  assert.equal(capped.retry, false);
  assert.match(capped.reason, /USAGE_LIMIT_EXCEEDED/);
});
